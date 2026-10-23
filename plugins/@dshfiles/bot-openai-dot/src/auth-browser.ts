// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { terminateManagedProcess } from '@dshfiles/dshx/host'
import type { BrowserPort as BackendBrowserPort } from './auth-attempt.js'
import { authInputSchema } from './auth-protocol.js'
import type { AuthInput } from './auth-protocol.js'

const WIDTH = 1280
const HEIGHT = 900
const MAX_FRAME = 1024 * 1024
const DEADLINE_MS = 10_000
const FAILED = 'Synthetic fixture browser failed.'
const CLEANUP_FAILED = 'Synthetic fixture browser cleanup unconfirmed; private temporary profile retained.'
type NativeRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
class BrowserCleanupUnconfirmed extends Error {
  constructor() {
    super(CLEANUP_FAILED)
  }
}

/** Trusted Host configuration, NEVER a value accepted from browser input or a provider adapter.
 * There is deliberately no production policy: incognito interception is NOT OS egress containment.
 */
export interface FixtureBrowserPolicy {
  readonly kind: 'synthetic-local-fixture'
  readonly entryUrl: string
  readonly chromiumExecutable: string
}

/** A narrow test seam; the default implementation uses only public Playwright 1.56 APIs.
 * Implementations must close connections on setup failure and must never log the endpoint.
 */
export interface FixtureBrowserIO {
  connect(privateEndpoint: string, policy: FixtureBrowserPolicy, revoke: () => void): Promise<BackendBrowserPort>
}

export interface FixtureBrowserOptions {
  readonly runtime: NativeRuntime
  readonly policy: FixtureBrowserPolicy
  /** Mandatory integration proof: native subprocess, Node temp filesystem AND loopback
   * must be in the same execution world. Absence/unknown/false fails before spawn.
   * The public SubprocessRuntime has no local-provider identity/attestation API.
   * For the default IO this must be a controlled fixture Host with no previously
   * programmatically enabled Playwright diagnostics (not inspectable by its public API).
   */
  readonly confirmLocalExecutionWorld: (input: { readonly runtime: NativeRuntime; readonly signal: AbortSignal }) => Promise<boolean>
  readonly browserIO?: FixtureBrowserIO
}

function checkedPolicy(policy: FixtureBrowserPolicy): FixtureBrowserPolicy {
  let entry: URL
  try {
    entry = new URL(policy.entryUrl)
  } catch {
    throw new Error(FAILED)
  }
  if (
    policy.kind !== 'synthetic-local-fixture' ||
    entry.protocol !== 'http:' ||
    entry.hostname !== '127.0.0.1' ||
    !entry.port ||
    entry.username ||
    entry.password ||
    entry.hash ||
    entry.search ||
    !isAbsolute(policy.chromiumExecutable) ||
    policy.chromiumExecutable.includes('\0')
  )
    throw new Error(FAILED)
  return Object.freeze({ kind: policy.kind, entryUrl: entry.href, chromiumExecutable: policy.chromiumExecutable })
}

function diagnosticsDisabled(): boolean {
  // Protocol/browser debug output can contain CDP capabilities, frames and input.
  return ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PW_TEST_DEBUG_PROTOCOL'].every(name => !process.env[name])
}

async function createPrivateProfile() {
  let directory: string | undefined
  try {
    const parent = await realpath(tmpdir())
    directory = await mkdtemp(join(parent, 'dsh-dot-fixture-'))
    await chmod(directory, 0o700)
    const identity = await lstat(directory)
    return { parent, directory, identity }
  } catch {
    throw new Error(directory === undefined ? FAILED : CLEANUP_FAILED)
  }
}

function allowedUrl(url: string, policy: FixtureBrowserPolicy): boolean {
  try {
    const value = new URL(url)
    return value.protocol === 'http:' && value.origin === new URL(policy.entryUrl).origin && !value.username && !value.password
  } catch {
    return false
  }
}

function validateInput(input: AuthInput): void {
  if (!authInputSchema.safeParse(input).success) throw new Error(FAILED)
  const point = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT
  const keys = [
    'Backspace',
    'Delete',
    'Tab',
    'Enter',
    'Escape',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Space',
  ]
  const shifted = ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space']
  switch (input.kind) {
    case 'pointer':
      if (!point(input.x, input.y) || input.button !== 'left' || !['move', 'down', 'up'].includes(input.action)) throw new Error(FAILED)
      break
    case 'wheel':
      if (
        !point(input.x, input.y) ||
        !Number.isFinite(input.deltaX) ||
        !Number.isFinite(input.deltaY) ||
        Math.abs(input.deltaX) > HEIGHT ||
        Math.abs(input.deltaY) > HEIGHT
      )
        throw new Error(FAILED)
      break
    case 'text':
      // The owned input schema already rejects empty/control-character text.
      if (Buffer.byteLength(input.text) > 4096) throw new Error(FAILED)
      break
    case 'key':
      if (
        !keys.includes(input.key) ||
        !['down', 'up'].includes(input.action) ||
        (input.modifiers !== 0 && !(input.modifiers === 8 && shifted.includes(input.key)))
      )
        throw new Error(FAILED)
      break
    default:
      throw new Error(FAILED)
  }
}

/** Never retains stderr in the managed collector, a spill, a log, or an Error. */
function readPrivateEndpoint(stderr: Readable, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = ''
    let seen = 0
    const finish = (endpoint?: string) => {
      stderr.off('data', onData)
      stderr.off('end', onEnd)
      signal.removeEventListener('abort', onEnd)
      pending = ''
      // Keep draining without retaining diagnostics, including after readiness.
      stderr.resume()
      if (endpoint === undefined) reject(new Error(FAILED))
      else resolve(endpoint)
    }
    const onEnd = () => finish()
    // Native raw pipes emit Buffer bytes; never opt into text encoding or object mode.
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk)) return finish()
      seen += chunk.byteLength
      if (seen > 64 * 1024) return finish()
      pending += chunk.toString()
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, '')
        pending = pending.slice(newline + 1)
        const match = /^DevTools listening on (ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/devtools\/browser\/[a-f0-9-]{36})$/u.exec(line)
        if (match?.[1] !== undefined && Number(match[2]) > 0 && Number(match[2]) <= 65535) return finish(match[1])
        newline = pending.indexOf('\n')
      }
    }
    stderr.on('data', onData)
    stderr.once('end', onEnd)
    signal.addEventListener('abort', onEnd, { once: true })
    if (signal.aborted) onEnd()
  })
}

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(FAILED)), DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const playwrightIO: FixtureBrowserIO = {
  async connect(endpoint, policy, revoke) {
    // Do not initialize Playwright's DEBUG_FILE writer before the fixture gate.
    if (!diagnosticsDisabled()) throw new Error(FAILED)
    const { chromium } = await import('playwright-core')
    if (!diagnosticsDisabled()) throw new Error(FAILED)
    const browser = await chromium.connectOverCDP(endpoint, { timeout: DEADLINE_MS })
    try {
      // Never inspect/import the default profile, contexts, targets, cookies, or storage.
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        javaScriptEnabled: false,
      })
      context.setDefaultTimeout(DEADLINE_MS)
      context.setDefaultNavigationTimeout(DEADLINE_MS)
      let ownedPage: Awaited<ReturnType<typeof context.newPage>> | undefined
      // A routed redirect is fetched without following it; continue() alone does not
      // promise interception of every redirect hop. No Host/provider requests exist here.
      await context.route('**/*', async route => {
        try {
          const request = route.request()
          if (
            !allowedUrl(request.url(), policy) ||
            !['GET', 'HEAD', 'POST'].includes(request.method()) ||
            (request.resourceType() === 'document' && (ownedPage === undefined || request.frame() !== ownedPage.mainFrame()))
          ) {
            await route.abort('blockedbyclient')
            return
          }
          const response = await route.fetch({ maxRedirects: 0, timeout: DEADLINE_MS })
          if (response.status() >= 300 && response.status() < 400) await route.abort('blockedbyclient')
          else
            await route.fulfill({
              response,
              headers: {
                ...response.headers(),
                'content-security-policy':
                  "default-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'self'; base-uri 'none'; sandbox allow-forms allow-same-origin",
                'permissions-policy': 'clipboard-read=(), clipboard-write=(), camera=(), microphone=(), display-capture=()',
                'referrer-policy': 'no-referrer',
              },
            })
        } catch {
          revoke()
        }
      })
      await context.routeWebSocket('**/*', socket => socket.close())
      context.on('serviceworker', revoke)
      context.on('page', page => {
        if (ownedPage !== undefined && page !== ownedPage) {
          revoke()
          void page.close().catch(() => undefined)
        }
      })
      const page = await context.newPage()
      ownedPage = page
      page.on('popup', popup => {
        revoke()
        void popup.close().catch(() => undefined)
      })
      page.on('download', download => {
        revoke()
        void download.cancel().catch(() => undefined)
      })
      page.on('filechooser', () => revoke())
      page.on('dialog', dialog => {
        void dialog.dismiss().catch(() => revoke())
      })
      page.on('framenavigated', frame => {
        if (!allowedUrl(frame.url(), policy)) revoke()
      })
      await page.goto(policy.entryUrl, { waitUntil: 'domcontentloaded', timeout: DEADLINE_MS })
      return {
        async frame(signal) {
          signal.throwIfAborted()
          if (!allowedUrl(page.url(), policy)) throw new Error(FAILED)
          const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: DEADLINE_MS })
          signal.throwIfAborted()
          return { bytes, width: WIDTH, height: HEIGHT }
        },
        async input(input, signal) {
          signal.throwIfAborted()
          if (!allowedUrl(page.url(), policy)) throw new Error(FAILED)
          switch (input.kind) {
            case 'pointer':
              await page.mouse.move(input.x, input.y)
              if (input.action === 'down') await page.mouse.down({ button: 'left' })
              if (input.action === 'up') await page.mouse.up({ button: 'left' })
              break
            case 'wheel':
              await page.mouse.move(input.x, input.y)
              await page.mouse.wheel(input.deltaX, input.deltaY)
              break
            case 'text':
              await page.keyboard.insertText(input.text)
              break
            case 'key': {
              const key = input.key === 'Space' ? ' ' : input.key
              if (input.modifiers === 8) await page.keyboard.down('Shift')
              try {
                await page.keyboard[input.action](key)
              } finally {
                if (input.modifiers === 8) await page.keyboard.up('Shift')
              }
              break
            }
          }
          signal.throwIfAborted()
        },
        async close() {
          try {
            await context.close()
          } finally {
            await browser.close()
          }
        },
      }
    } catch {
      try {
        await bounded(browser.close())
      } catch {
        throw new BrowserCleanupUnconfirmed()
      }
      throw new Error(FAILED)
    }
  },
}

/** Build, not launch, a fixture-only factory. No production/provider URL is accepted.
 * No Playwright launch, unmanaged children, arbitrary CDP, JS evaluation or filesystem exports.
 */
export function createFixtureBrowserFactory(options: FixtureBrowserOptions): (signal: AbortSignal) => Promise<BackendBrowserPort> {
  const policy = checkedPolicy(options.policy)
  return async signal => {
    signal.throwIfAborted()
    try {
      if (!diagnosticsDisabled()) throw new Error(FAILED)
      if ((await bounded(options.confirmLocalExecutionWorld({ runtime: options.runtime, signal }))) !== true) throw new Error(FAILED)
      signal.throwIfAborted()
    } catch {
      throw new Error(FAILED)
    }
    const { parent, directory, identity } = await createPrivateProfile()
    const lifetime = new AbortController()
    const processSignal = AbortSignal.any([signal, lifetime.signal])
    let handle: SubprocessHandle | undefined
    let established: BackendBrowserPort | undefined
    let connecting: Promise<BackendBrowserPort> | undefined
    let revoked = false
    let stopping: Promise<void> | undefined
    let opening = true
    const assertLive = (requestSignal: AbortSignal) => {
      requestSignal.throwIfAborted()
      if (revoked || processSignal.aborted) throw new Error(FAILED)
    }
    const close = (): Promise<void> => {
      if (stopping !== undefined) return stopping
      revoked = true
      lifetime.abort()
      signal.removeEventListener('abort', onAbort)
      stopping = (async () => {
        // Both browser and managed-range joins are required, not just direct-child exit.
        const closeConnection = async () => {
          let connected = established
          if (connected === undefined && connecting !== undefined) {
            try {
              connected = await connecting
            } catch (error) {
              if (error instanceof BrowserCleanupUnconfirmed) throw error
              // The IO contract closes connections before rejecting ordinary setup failures.
            }
          }
          await connected?.close()
        }
        const outcomes = await Promise.allSettled([
          bounded(closeConnection()),
          handle === undefined ? Promise.resolve(true) : terminateManagedProcess({ handle, timeoutMs: DEADLINE_MS }),
          handle === undefined ? Promise.resolve() : bounded(handle.done),
        ])
        if (outcomes.some(result => result.status === 'rejected') || outcomes[1]?.status !== 'fulfilled' || outcomes[1].value !== true)
          throw new Error(CLEANUP_FAILED)
        try {
          const now = await lstat(directory)
          if (
            !now.isDirectory() ||
            now.isSymbolicLink() ||
            now.ino !== identity.ino ||
            now.dev !== identity.dev ||
            now.uid !== identity.uid ||
            (now.mode & 0o777) !== 0o700 ||
            (await realpath(directory)) !== directory ||
            dirname(directory) !== parent ||
            !basename(directory).startsWith('dsh-dot-fixture-')
          )
            throw new Error(CLEANUP_FAILED)
          await rm(directory, { recursive: true, force: false })
        } catch {
          throw new Error(CLEANUP_FAILED)
        }
      })()
      return stopping
    }
    const revoke = () => {
      revoked = true
      lifetime.abort()
      if (!opening) void close().catch(() => undefined)
    }
    const onAbort = () => revoke()
    signal.addEventListener('abort', onAbort, { once: true })
    const deadline = setTimeout(revoke, DEADLINE_MS)
    try {
      assertLive(signal)
      const env: NodeJS.ProcessEnv = {}
      // Tombstone ambient NAMES only; no parent values are read or forwarded.
      for (const name of Object.keys(process.env)) env[name] = undefined
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
        'NODE_USE_ENV_PROXY',
        'SSLKEYLOGFILE',
        'CHROME_LOG_FILE',
      ])
        env[name] = undefined
      env.HOME = directory
      env.XDG_CONFIG_HOME = join(directory, 'config')
      env.XDG_CACHE_HOME = join(directory, 'cache')
      env.XDG_DATA_HOME = join(directory, 'data')
      env.XDG_RUNTIME_DIR = join(directory, 'runtime')
      env.TMPDIR = join(directory, 'tmp')
      env.LANG = 'C.UTF-8'
      for (const child of ['config', 'cache', 'data', 'runtime', 'tmp']) await mkdir(join(directory, child), { mode: 0o700 })
      const executable = await options.runtime.resolveExecutable(policy.chromiumExecutable, { HOME: directory, LANG: 'C.UTF-8' }, processSignal)
      if (!isAbsolute(executable) || executable.includes('\0')) throw new Error(FAILED)
      assertLive(signal)
      handle = options.runtime.spawn({
        argv: [
          executable,
          '--headless',
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          `--user-data-dir=${directory}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-default-apps',
          'about:blank',
        ],
        cwd: directory,
        env,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 1_000,
        signal: processSignal,
      })
      void handle.done.then(revoke, revoke)
      if (handle.stderr === undefined || handle.stdout === undefined) throw new Error(FAILED)
      handle.stdout.on('error', revoke).resume()
      handle.stderr.on('error', revoke)
      const endpoint = await readPrivateEndpoint(handle.stderr, processSignal)
      connecting = (options.browserIO ?? playwrightIO).connect(endpoint, policy, revoke)
      const browser = await bounded(connecting)
      established = browser
      assertLive(signal)
      opening = false
      // One operation at a time; no unbounded screenshot or input queue.
      let busy = false
      const operation = async <Value>(requestSignal: AbortSignal, run: (operationSignal: AbortSignal) => Promise<Value>): Promise<Value> => {
        assertLive(requestSignal)
        if (busy) throw new Error(FAILED)
        busy = true
        try {
          const result = await run(AbortSignal.any([requestSignal, processSignal]))
          assertLive(requestSignal)
          return result
        } catch {
          throw new Error(FAILED)
        } finally {
          busy = false
        }
      }
      return {
        frame: requestSignal =>
          operation(requestSignal, async operationSignal => {
            const frame = await browser.frame(operationSignal)
            if (
              !(frame.bytes instanceof Uint8Array) ||
              frame.bytes.byteLength < 5 ||
              frame.bytes.byteLength > MAX_FRAME ||
              frame.bytes[0] !== 0xff ||
              frame.bytes[1] !== 0xd8 ||
              frame.bytes[2] !== 0xff ||
              frame.bytes.at(-2) !== 0xff ||
              frame.bytes.at(-1) !== 0xd9 ||
              !Number.isInteger(frame.width) ||
              !Number.isInteger(frame.height) ||
              frame.width < 1 ||
              frame.width > 1440 ||
              frame.height < 1 ||
              frame.height > 1000
            )
              throw new Error(FAILED)
            return frame
          }),
        input: (input, requestSignal) =>
          operation(requestSignal, async operationSignal => {
            validateInput(input)
            await browser.input(input, operationSignal)
          }),
        close,
      }
    } catch {
      await close()
      throw new Error(FAILED)
    } finally {
      clearTimeout(deadline)
    }
  }
}
