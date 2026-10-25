// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import type { BrowserPort } from './auth-attempt.js'
import { authFrameMaxBytes, authInputSchema } from './auth-protocol.js'
import type { AuthInput } from './auth-protocol.js'

const ENTRY = 'https://chatgpt.com/'
const ORIGIN = 'https://chatgpt.com'
const WIDTH = 1280
const HEIGHT = 900
const DEADLINE = 15_000
const MAX_BODY = 64 * 1024
const MAX_RESPONSE = 4 * 1024 * 1024
const MESSAGE = 'Dot browser session operation refused.'
const CLEANUP_MESSAGE = 'Dot browser cleanup unconfirmed; private profile retained.'

export class DotBrowserSessionError extends Error {
  constructor(readonly code: 'failed' | 'busy' | 'not-ready' | 'not-admitted' | 'forbidden' | 'cleanup-unconfirmed') {
    super(code === 'cleanup-unconfirmed' ? CLEANUP_MESSAGE : MESSAGE)
    this.name = 'DotBrowserSessionError'
  }
}
const failed = () => new DotBrowserSessionError('failed')

/** Trusted operator composition only. Never accept these paths through an API/tool/client. */
export interface DotBrowserSessionOptions {
  readonly chromiumExecutable: string
  readonly privateProfileParentPath: string
}
export interface DotBrowserSession extends BrowserPort {
  /** One borrowed human-only lease. Closing it before admission destroys the session;
   * closing it after admission revokes only viewing/input, retaining API transport. */
  viewer(signal: AbortSignal): Promise<BrowserPort>
  /** Browser admission only, NOT Dot connection or account-identity verification. */
  complete(signal: AbortSignal): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

interface BrowserRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | undefined
}
interface BrowserResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly bytes: Uint8Array
}
/** Test-only substitution boundary. No browser handle, CDP endpoint, cookies or storage.
 * close() must resolve ONLY after context AND native browser process shutdown; a
 * rejected open must clean up, or throw DotBrowserSessionError(cleanup-unconfirmed). */
export interface DotBrowserSessionIO extends BrowserPort {
  admission(signal: AbortSignal): Promise<{ readonly url: string; readonly status: number; readonly challenge: boolean; readonly navigating: boolean }>
  request(request: BrowserRequest, signal: AbortSignal): Promise<BrowserResponse>
}
export type DotBrowserSessionTestFactory = (input: {
  readonly chromiumExecutable: string
  readonly privateProfilePath: string
  readonly env: Readonly<Record<string, string>>
  readonly revoke: () => void
}) => Promise<DotBrowserSessionIO>

function diagnosticsDisabled(): boolean {
  return ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PW_TEST_DEBUG_PROTOCOL'].every(name => !process.env[name])
}
function allowedTopFrame(raw: string): boolean {
  try {
    const url = new URL(raw)
    return !url.username && !url.password && (url.origin === ORIGIN || url.origin === 'https://auth.openai.com')
  } catch {
    return false
  }
}
function checkedInput(input: AuthInput): void {
  if (!authInputSchema.safeParse(input).success) throw failed()
  if (input.kind === 'pointer' || input.kind === 'wheel') {
    if (input.x >= WIDTH || input.y >= HEIGHT) throw failed()
    if (input.kind === 'pointer' && input.button !== 'left') throw failed()
    if (input.kind === 'wheel' && (Math.abs(input.deltaX) > HEIGHT || Math.abs(input.deltaY) > HEIGHT)) throw failed()
  }
  // No context menus, browser shortcuts, clipboard, address bar, DevTools or scripts.
  if (
    input.kind === 'key' &&
    input.modifiers !== 0 &&
    !(input.modifiers === 8 && ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space'].includes(input.key))
  )
    throw failed()
}
function hasAsciiControl(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
}
function checkedRequest(input: RequestInfo | URL, init: RequestInit = {}): BrowserRequest {
  // DotHttp uses a URL + init. Opaque Request objects/streams are intentionally not a
  // second authority: reading an arbitrary Request body would bypass this byte bound.
  // oxlint-disable-next-line antislop/no-runtime-typeof -- Native fetch union boundary: exclude Request/stream authority, then validate the complete URL and fixed provider paths below.
  if (typeof input !== 'string' && !(input instanceof URL)) throw failed()
  const raw = String(input)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw failed()
  }
  if (raw.length > 4096 || url.href !== raw || raw !== `${ORIGIN}${url.pathname}${url.search}` || url.origin !== ORIGIN || url.username || url.password)
    throw failed()
  const method = init.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') throw failed()
  const segment = "[A-Za-z0-9_.!~*'()-]|%[A-Fa-f0-9]{2}"
  const id = `(?:${segment}){1,900}`
  const getPath = new RegExp(`^/backend-api/(?:tbo/primary|tbo/by-thread/${id}|messaging/rooms/${id}(?:/messages)?)$`, 'u')
  const postPath = new RegExp(`^/backend-api/messaging/rooms/${id}/messages$`, 'u')
  if (!(method === 'GET' ? getPath : postPath).test(url.pathname)) throw failed()
  // Dot identifiers never contain ASCII control/space, separators or dot traversal.
  if (
    /%(?:0[0-9a-f]|1[0-9a-f]|20|7f|2f|5c)/iu.test(url.pathname) ||
    url.pathname.split('/').some(part => part === '.' || part === '..' || /^(?:%2e){1,2}$/iu.test(part))
  )
    throw failed()
  if (url.search) {
    if (
      method !== 'GET' ||
      !url.pathname.endsWith('/messages') ||
      !/^\?limit=(?:1|32)(?:&after=(?:[A-Za-z0-9_.~-]|%[A-Fa-f0-9]{2}){0,900})?$/u.test(url.search)
    )
      throw failed()
  }
  if (Object.keys(init).some(key => !['method', 'headers', 'body', 'signal', 'redirect', 'credentials'].includes(key))) throw failed()
  if ((init.redirect !== undefined && init.redirect !== 'error') || (init.credentials !== undefined && init.credentials !== 'omit')) throw failed()
  // oxlint-disable-next-line antislop/no-runtime-typeof -- Native BodyInit boundary rejects streams/objects and validates the UTF-8 byte ceiling before any browser I/O.
  if (method === 'GET' ? init.body !== undefined && init.body !== null : typeof init.body !== 'string' || Buffer.byteLength(init.body) > MAX_BODY || !init.body)
    throw failed()
  const headers: Array<readonly [string, string]> = []
  let total = 0
  try {
    for (const [name, value] of new Headers(init.headers)) {
      total += name.length + value.length
      if (total > 32 * 1024 || hasAsciiControl(value)) throw failed()
      // Compatibility with existing DotHttp only. Never send its Node UA; the
      // browser supplies its own truthful native UA and normal browser cookies.
      if (name === 'user-agent' && value === 'DSHDotAdapter/0.1') continue
      if (!['authorization', 'content-type', 'chatgpt-account-id', 'x-openai-expected-account-id'].includes(name)) throw failed()
      if (name === 'authorization' && !/^Bearer [A-Za-z0-9._~+/-]{1,16384}=*$/u.test(value)) throw failed()
      if (name === 'content-type' && value !== 'application/json') throw failed()
      if ((name === 'chatgpt-account-id' || name === 'x-openai-expected-account-id') && !/^[A-Za-z0-9_-]{1,300}$/u.test(value)) throw failed()
      headers.push([name, value])
    }
  } catch {
    throw failed()
  }
  const values = new Map(headers)
  if (
    !values.has('authorization') ||
    values.get('content-type') !== 'application/json' ||
    !values.has('chatgpt-account-id') ||
    values.get('chatgpt-account-id') !== values.get('x-openai-expected-account-id')
  )
    throw failed()
  // oxlint-disable-next-line antislop/no-runtime-typeof -- Carry only the already byte-bounded string; GET null/undefined means no body.
  return { url: raw, method, headers, body: typeof init.body === 'string' ? init.body : undefined }
}

/** Trusted-human-only, first-party browser boundary, NOT general agent browsing.
 * Normal provider JS/TLS/CORS and Chromium renderer sandbox stay enabled. The
 * human may sign in or solve a security check manually, never through a solver.
 * We do not import/export cookies, read web-session tokens or run supplied JS.
 * First-party pages/subresources remain trusted browser content; document
 * interception is NOT OS egress confinement. Production kernel/network hardening
 * is a deployment responsibility, not a fabricated runtime attestation flag.
 * Host composition must not enable Playwright tracing/protocol logging.
 */
// oxlint-disable-next-line antislop/no-export-bag -- Explicit production constructor plus isolated test substitution boundaries; never a general browser registry.
export function createDotBrowserSession(options: DotBrowserSessionOptions): DotBrowserSession {
  return createSession(options, playwrightFactory)
}
/** Explicit TEST factory only; never expose this function or factory through Host APIs. */
export function createDotBrowserSessionForTest(options: DotBrowserSessionOptions, factory: DotBrowserSessionTestFactory): DotBrowserSession {
  return createSession(options, factory)
}
function createSession(options: DotBrowserSessionOptions, factory: DotBrowserSessionTestFactory): DotBrowserSession {
  for (const path of [options.chromiumExecutable, options.privateProfileParentPath]) {
    if (!isAbsolute(path) || path.includes('\0')) throw failed()
  }
  // Copy trusted configuration so a later mutation cannot change the authority.
  const executable = options.chromiumExecutable
  const profileParent = options.privateProfileParentPath
  let phase: 'absent' | 'enrolling' | 'ready' | 'closing' | 'closed' = 'absent'
  let generation = 0
  let viewing = false
  // Resource admission, not UI state: independent screenshot/input work must not
  // fail one another. Ready HTTP polling and sends share a small bounded pool.
  const active = { frame: 0, input: 0, complete: 0, fetch: 0 }
  const limits = { frame: 1, input: 1, complete: 1, fetch: 8 }
  let io: DotBrowserSessionIO | undefined
  let ioClosing: Promise<void> | undefined
  const stopIO = (): Promise<void> => {
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Capture this resource across asynchronous callbacks; do not look up a mutable resource after cancellation.
    const port = io
    if (!port) return Promise.resolve()
    ioClosing ??= Promise.resolve().then(() => port.close())
    return ioClosing
  }
  let opening: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let profile: { directory: string; parent: string; ino: number; dev: number; uid: number } | undefined
  let cleanupUnconfirmed = false
  let detachEnrollment: (() => void) | undefined
  const lifetime = new AbortController()
  const boundedWait = async <Value>(work: Promise<Value>): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(failed()), DEADLINE)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const assertLive = (signal: AbortSignal, epoch: number) => {
    if (signal.aborted || lifetime.signal.aborted || epoch !== generation || phase === 'closing' || phase === 'closed') throw failed()
  }
  const close = (): Promise<void> => {
    if (closing) return closing
    phase = 'closing'
    generation++
    viewing = false
    detachEnrollment?.()
    lifetime.abort()
    closing = (async () => {
      try {
        await boundedWait(opening?.catch(() => undefined) ?? Promise.resolve())
        if (cleanupUnconfirmed) throw failed()
        await boundedWait(stopIO())
        if (profile) {
          const { directory, parent, ino, dev, uid } = profile
          const current = await lstat(directory)
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.ino !== ino ||
            current.dev !== dev ||
            current.uid !== uid ||
            (current.mode & 0o777) !== 0o700 ||
            (await realpath(directory)) !== directory ||
            dirname(directory) !== parent ||
            !basename(directory).startsWith('dsh-dot-session-')
          )
            throw failed()
          // The resolved, owned directory and inode are checked immediately above.
          await rm(directory, { recursive: true, force: false })
        }
        phase = 'closed'
      } catch {
        cleanupUnconfirmed = true
        throw new DotBrowserSessionError('cleanup-unconfirmed')
      }
    })()
    return closing
  }
  const revoke = () => {
    void close().catch(() => undefined)
  }
  const operate = async <Value>(
    kind: keyof typeof active,
    signal: AbortSignal,
    run: (port: DotBrowserSessionIO, signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> => {
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Snapshot operation identity before awaiting, so late completion cannot observe a newer generation.
    const epoch = generation
    assertLive(signal, epoch)
    if (!diagnosticsDisabled()) {
      revoke()
      throw failed()
    }
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Capture this resource across asynchronous callbacks; do not look up a mutable resource after cancellation.
    const port = io
    if (!port) throw new DotBrowserSessionError('not-ready')
    if (active[kind] >= limits[kind] || (kind === 'complete' ? active.frame + active.input > 0 : kind !== 'fetch' && active.complete > 0))
      throw new DotBrowserSessionError('busy')
    active[kind]++
    const bounded = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(DEADLINE)])
    let onAbort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          revoke()
          reject(failed())
        }
        bounded.addEventListener('abort', onAbort, { once: true })
        if (bounded.aborted) onAbort()
      })
      const result = await Promise.race([
        Promise.resolve().then(() => {
          assertLive(bounded, epoch)
          return run(port, bounded)
        }),
        cancelled,
      ])
      assertLive(bounded, epoch)
      return result
    } catch (error) {
      if (error instanceof DotBrowserSessionError && error.code !== 'failed') throw error
      revoke()
      throw failed()
    } finally {
      if (onAbort) bounded.removeEventListener('abort', onAbort)
      active[kind]--
    }
  }
  const frame: BrowserPort['frame'] = signal => {
    if (!viewing || phase !== 'enrolling') return Promise.reject(new DotBrowserSessionError('forbidden'))
    return operate('frame', signal, async (port, bounded) => {
      const frame = await port.frame(bounded)
      if (
        !(frame.bytes instanceof Uint8Array) ||
        frame.bytes.byteLength < 5 ||
        frame.bytes.byteLength > authFrameMaxBytes ||
        frame.bytes[0] !== 0xff ||
        frame.bytes[1] !== 0xd8 ||
        frame.bytes[2] !== 0xff ||
        frame.bytes.at(-2) !== 0xff ||
        frame.bytes.at(-1) !== 0xd9 ||
        frame.width !== WIDTH ||
        frame.height !== HEIGHT
      )
        throw failed()
      return { bytes: new Uint8Array(frame.bytes), width: WIDTH, height: HEIGHT }
    })
  }
  const input: BrowserPort['input'] = async (value, signal) => {
    if (!viewing || phase !== 'enrolling') return Promise.reject(new DotBrowserSessionError('forbidden'))
    checkedInput(value)
    return operate('input', signal, (port, bounded) => port.input(value, bounded))
  }
  return {
    frame,
    input,
    close,
    async viewer(signal) {
      if (phase !== 'absent' || signal.aborted) throw new DotBrowserSessionError('busy')
      phase = 'enrolling'
      const epoch = ++generation
      const abort = () => revoke()
      signal.addEventListener('abort', abort, { once: true })
      detachEnrollment = () => signal.removeEventListener('abort', abort)
      opening = (async () => {
        if (!diagnosticsDisabled()) throw failed()
        const parent = await realpath(profileParent)
        assertLive(signal, epoch)
        const directory = await mkdtemp(join(parent, 'dsh-dot-session-'))
        await chmod(directory, 0o700)
        const identity = await lstat(directory)
        profile = { directory, parent, ino: identity.ino, dev: identity.dev, uid: identity.uid }
        const env = {
          HOME: directory,
          LANG: 'C.UTF-8',
          XDG_CONFIG_HOME: join(directory, 'config'),
          XDG_CACHE_HOME: join(directory, 'cache'),
          XDG_DATA_HOME: join(directory, 'data'),
          XDG_RUNTIME_DIR: join(directory, 'runtime'),
          TMPDIR: join(directory, 'tmp'),
        }
        for (const child of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.TMPDIR]) await mkdir(child, { mode: 0o700 })
        assertLive(signal, epoch)
        try {
          io = await factory({ chromiumExecutable: executable, privateProfilePath: directory, env, revoke })
        } catch (error) {
          if (error instanceof DotBrowserSessionError && error.code === 'cleanup-unconfirmed') cleanupUnconfirmed = true
          throw failed()
        }
        // A factory resolving after cleanup's deadline must still be stopped; it
        // can never publish a live lease or resurrect transport. Retain its profile.
        if (lifetime.signal.aborted) await boundedWait(stopIO())
        assertLive(signal, epoch)
      })()
      let rejectOpening: (() => void) | undefined
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectOpening = () => reject(failed())
          signal.addEventListener('abort', rejectOpening, { once: true })
          if (signal.aborted) rejectOpening()
        })
        await Promise.race([boundedWait(opening), cancelled])
        assertLive(signal, epoch)
        viewing = true
        return {
          frame,
          input,
          async close() {
            viewing = false
            if (phase !== 'ready') await close()
          },
        }
      } catch {
        await close()
        throw failed()
      } finally {
        if (rejectOpening) signal.removeEventListener('abort', rejectOpening)
      }
    },
    async complete(signal) {
      if (phase !== 'enrolling' || !viewing) throw new DotBrowserSessionError('not-ready')
      await operate('complete', signal, async (port, bounded) => {
        const admission = await port.admission(bounded)
        if (
          !allowedTopFrame(admission.url) ||
          new URL(admission.url).origin !== ORIGIN ||
          admission.status !== 200 ||
          admission.challenge ||
          admission.navigating
        )
          throw new DotBrowserSessionError('not-admitted')
      })
      // No await between the final operation fence and promotion.
      if (signal.aborted || lifetime.signal.aborted || phase !== 'enrolling' || !viewing) throw failed()
      phase = 'ready'
      viewing = false
      detachEnrollment?.()
    },
    async fetch(value, init) {
      if (phase !== 'ready') throw new DotBrowserSessionError('not-ready')
      const request = checkedRequest(value, init)
      const signal = init?.signal ?? new AbortController().signal
      return operate('fetch', signal, async (port, bounded) => {
        const admission = await port.admission(bounded)
        if (
          !allowedTopFrame(admission.url) ||
          new URL(admission.url).origin !== ORIGIN ||
          admission.status !== 200 ||
          admission.challenge ||
          admission.navigating
        )
          throw new DotBrowserSessionError('not-admitted')
        bounded.throwIfAborted()
        const response = await port.request(request, bounded)
        if (
          !Number.isInteger(response.status) ||
          response.status < 200 ||
          response.status > 599 ||
          (response.status >= 300 && response.status < 400) ||
          !(response.bytes instanceof Uint8Array) ||
          response.bytes.byteLength > MAX_RESPONSE
        )
          throw failed()
        const headers = new Headers()
        if (!Array.isArray(response.headers) || response.headers.length > 2) throw failed()
        for (const [name, header] of response.headers) {
          if (!['content-type', 'cf-mitigated'].includes(name) || headers.has(name) || header.length > 512 || hasAsciiControl(header)) throw failed()
          headers.set(name, header)
        }
        return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(response.bytes), { status: response.status, headers })
      })
    },
  }
}

interface PagePolicy {
  readonly entry: string
  readonly origin: string
  readonly permits: (url: string) => boolean
  readonly inspectSandboxForTest: ((report: string) => void) | undefined
}
const productionPolicy: PagePolicy = { entry: ENTRY, origin: ORIGIN, permits: allowedTopFrame, inspectSandboxForTest: undefined }
const playwrightFactory: DotBrowserSessionTestFactory = options => openPlaywright(options, productionPolicy)
/** Explicit synthetic loopback-only TEST factory. No production option can select
 * another URL. The provider request authority remains validated by the session;
 * this test port substitutes only its origin with an owned local fixture. */
export function createDotBrowserLocalFixtureFactoryForTest(entryUrl: string, inspectSandboxForTest?: (report: string) => void): DotBrowserSessionTestFactory {
  let entry: URL
  try {
    entry = new URL(entryUrl)
  } catch {
    throw failed()
  }
  if (
    entry.protocol !== 'http:' ||
    entry.hostname !== '127.0.0.1' ||
    !entry.port ||
    entry.username ||
    entry.password ||
    entry.search ||
    entry.hash ||
    entry.href !== entryUrl
  )
    throw failed()
  const origin = entry.origin
  const policy: PagePolicy = {
    entry: entry.href,
    origin,
    inspectSandboxForTest,
    permits(raw) {
      try {
        const url = new URL(raw)
        return url.origin === origin && !url.username && !url.password
      } catch {
        return false
      }
    },
  }
  return options => openPlaywright(options, policy)
}
async function openPlaywright(
  { chromiumExecutable, privateProfilePath, env, revoke }: Parameters<DotBrowserSessionTestFactory>[0],
  policy: PagePolicy,
): Promise<DotBrowserSessionIO> {
  if (!diagnosticsDisabled()) throw failed()
  const { chromium } = await import('playwright-core')
  if (!diagnosticsDisabled()) throw failed()
  let context: BrowserContext | undefined
  let stopping: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (!context) return
      const browser = context.browser()
      // PW1.56.1 persistent-context doClose delegates Browser.close; its process
      // launcher joins native child `close` and cleanup. Await browser.close too,
      // not just a context/transport-disconnected notification.
      try {
        await context.close()
      } finally {
        if (browser) await browser.close()
      }
    })()
    return stopping
  }
  try {
    context = await chromium.launchPersistentContext(privateProfilePath, {
      executablePath: chromiumExecutable,
      chromiumSandbox: true,
      headless: true,
      env: { ...env },
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      permissions: [],
      serviceWorkers: 'block',
      javaScriptEnabled: true,
      timeout: DEADLINE,
    })
    context.setDefaultTimeout(DEADLINE)
    context.setDefaultNavigationTimeout(DEADLINE)
    const pages = context.pages()
    if (pages.length !== 1 || !pages[0]) throw failed()
    const ownedPage = pages[0]
    if (policy.inspectSandboxForTest) {
      // Only an explicit synthetic fixture can request this pre-fixture internal
      // diagnostic. No production option/human input can navigate to chrome://.
      // This is the SAME fresh driver-owned Chromium, before any provider secrets.
      await ownedPage.goto('chrome://sandbox/', { waitUntil: 'domcontentloaded', timeout: DEADLINE })
      await ownedPage.getByText('Seccomp-BPF sandbox', { exact: true }).waitFor({ state: 'visible', timeout: DEADLINE })
      const report = await ownedPage.locator('body').innerText({ timeout: DEADLINE })
      if (report.length > 16 * 1024) throw failed()
      policy.inspectSandboxForTest(report)
    }
    // A new popup's first document must be denied before its page event. CDP below
    // separately checks every redirect hop of the one permitted top-level page.
    await context.route('**/*', async route => {
      try {
        const request = route.request()
        if (request.isNavigationRequest() && request.frame().parentFrame() === null && request.frame() !== ownedPage.mainFrame()) {
          revoke()
          await route.abort('blockedbyclient')
        } else await route.continue()
      } catch {
        revoke()
      }
    })
    context.on('page', other => {
      if (other !== ownedPage) {
        revoke()
        void other.close().catch(() => undefined)
      }
    })
    context.on('close', revoke)
    ownedPage.on('crash', revoke)
    ownedPage.on('close', revoke)
    ownedPage.on('download', download => {
      revoke()
      void download.cancel().catch(() => undefined)
    })
    ownedPage.on('filechooser', revoke)
    ownedPage.on('dialog', dialog => {
      void dialog.dismiss().catch(revoke)
    })
    ownedPage.on('framenavigated', frame => {
      if (frame === ownedPage.mainFrame() && !policy.permits(frame.url())) revoke()
    })
    const control = await context.newCDPSession(ownedPage)
    const tree = await control.send('Page.getFrameTree')
    const mainFrameId = tree.frameTree.frame.id
    // Unlike Playwright route(), public Fetch request interception sees redirect
    // hops too. Only document navigation is checked; normal subresource TLS/CORS
    // and provider scripts are not reimplemented or fetched through Node HTTP.
    control.on('Fetch.requestPaused', event => {
      const permitted = event.frameId !== mainFrameId || policy.permits(event.request.url)
      if (!permitted) revoke()
      void control
        .send(
          permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          permitted ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(revoke)
    })
    await control.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    let navigation = 0
    let navigating = false
    let response: Promise<{ url: string; status: number; challenge: boolean }> = Promise.resolve({ url: '', status: 0, challenge: true })
    ownedPage.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === ownedPage.mainFrame()) {
        navigation++
        navigating = true
        response = Promise.resolve({ url: '', status: 0, challenge: true })
      }
    })
    ownedPage.on('response', received => {
      if (!received.request().isNavigationRequest() || received.frame() !== ownedPage.mainFrame()) return
      // Public provisional headers omit security-related/cookie headers. Do not
      // call allHeaders/headerValue (PW headerValue internally loads raw headers).
      response = Promise.resolve({ url: received.url(), status: received.status(), challenge: received.headers()['cf-mitigated'] === 'challenge' })
    })
    ownedPage.on('framenavigated', frame => {
      if (frame === ownedPage.mainFrame()) navigating = false
    })
    await ownedPage.goto(policy.entry, { waitUntil: 'domcontentloaded', timeout: DEADLINE })
    const assertPage = (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!policy.permits(ownedPage.url())) throw failed()
    }
    let leftDown = false
    return {
      async frame(signal) {
        assertPage(signal)
        const bytes = await ownedPage.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: DEADLINE })
        assertPage(signal)
        return { bytes, width: WIDTH, height: HEIGHT }
      },
      async input(input, signal) {
        assertPage(signal)
        checkedInput(input)
        switch (input.kind) {
          case 'pointer': {
            const pressed = input.action === 'move' ? leftDown : input.action === 'down'
            await control.send('Input.dispatchMouseEvent', {
              type: input.action === 'move' ? 'mouseMoved' : input.action === 'down' ? 'mousePressed' : 'mouseReleased',
              x: input.x,
              y: input.y,
              button: input.action === 'move' && !pressed ? 'none' : 'left',
              buttons: pressed ? 1 : 0,
              clickCount: input.action === 'move' ? 0 : 1,
            })
            leftDown = pressed
            break
          }
          case 'wheel':
            await control.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: input.x,
              y: input.y,
              buttons: leftDown ? 1 : 0,
              deltaX: input.deltaX,
              deltaY: input.deltaY,
            })
            break
          case 'text':
            await ownedPage.keyboard.insertText(input.text)
            break
          case 'key': {
            const key = input.key === 'Space' ? ' ' : input.key
            if (input.modifiers === 8) await ownedPage.keyboard.down('Shift')
            try {
              await ownedPage.keyboard[input.action](key)
            } finally {
              if (input.modifiers === 8) await ownedPage.keyboard.up('Shift')
            }
            break
          }
        }
        assertPage(signal)
      },
      async admission(signal) {
        assertPage(signal)
        // oxlint-disable-next-line antislop/no-passthrough-variable -- Snapshot the current document identity before reading headers/DOM; do not admit a subsequent navigation.
        const epoch = navigation
        const current = await response
        const state = await ownedPage.evaluate(() => ({
          url: location.href,
          challenge:
            !!document.querySelector('#challenge-running, #challenge-stage, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]') ||
            /^(?:Just a moment|Checking your browser)/iu.test(document.title),
        }))
        assertPage(signal)
        const actual = new URL(state.url)
        const admittedUrl =
          policy === productionPolicy || actual.origin !== policy.origin ? state.url : `${ORIGIN}${actual.pathname}${actual.search}${actual.hash}`
        return {
          url: admittedUrl,
          status: current.url === state.url && epoch === navigation ? current.status : 0,
          challenge: current.challenge || state.challenge,
          navigating: navigating || epoch !== navigation,
        }
      },
      async request(request, signal) {
        assertPage(signal)
        if (new URL(ownedPage.url()).origin !== policy.origin) throw failed()
        const target = new URL(request.url)
        const browserRequest = { ...request, url: `${policy.origin}${target.pathname}${target.search}` }
        // This is a fixed program, not source text or a function from a caller.
        const result = await ownedPage.evaluate(
          async ({ request, limit, deadline, origin }) => {
            if (location.origin !== origin) throw new Error('Browser request refused.')
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), deadline)
            try {
              const init: RequestInit = {
                method: request.method,
                headers: request.headers.map(([name, value]) => [name, value]),
                credentials: 'same-origin',
                mode: 'same-origin',
                redirect: 'error',
                signal: controller.signal,
              }
              if (request.body !== undefined) init.body = request.body
              const response = await fetch(request.url, init)
              if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('Browser request refused.')
              const advertised = response.headers.get('content-length')
              if (advertised && (!/^\d+$/u.test(advertised) || Number(advertised) > limit)) {
                await response.body?.cancel()
                throw new Error('Browser response refused.')
              }
              const reader = response.body?.getReader()
              const chunks: Uint8Array[] = []
              let length = 0
              try {
                if (reader)
                  for (;;) {
                    const chunk = await reader.read()
                    if (chunk.done) break
                    length += chunk.value.byteLength
                    if (length > limit) {
                      await reader.cancel()
                      throw new Error('Browser response refused.')
                    }
                    chunks.push(chunk.value)
                  }
              } finally {
                reader?.releaseLock()
              }
              const bytes = new Uint8Array(length)
              let offset = 0
              for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.byteLength
              }
              const headers: Array<[string, string]> = []
              for (const name of ['content-type', 'cf-mitigated']) {
                const value = response.headers.get(name)
                if (value !== null) {
                  if (value.length > 512) throw new Error('Browser response refused.')
                  headers.push([name, value])
                }
              }
              // Base64 avoids unbounded per-byte JSON arrays crossing the private pipe.
              let binary = ''
              for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
              return { status: response.status, headers, body: btoa(binary) }
            } finally {
              clearTimeout(timer)
            }
          },
          { request: browserRequest, limit: MAX_RESPONSE, deadline: DEADLINE, origin: policy.origin },
        )
        assertPage(signal)
        if (result.body.length > Math.ceil(MAX_RESPONSE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.body)) throw failed()
        return { status: result.status, headers: result.headers, bytes: new Uint8Array(Buffer.from(result.body, 'base64')) }
      },
      close,
    }
  } catch {
    try {
      await close()
    } catch {
      throw new DotBrowserSessionError('cleanup-unconfirmed')
    }
    throw failed()
  }
}
