// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDotBrowserLocalFixtureFactoryForTest,
  createDotBrowserSession,
  createDotBrowserSessionForTest,
  DotBrowserSessionError,
} from '../src/browser-session.js'
import type { DotBrowserSession, DotBrowserSessionIO, DotBrowserSessionTestFactory } from '../src/browser-session.js'
import type { AuthInput } from '../src/auth-protocol.js'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9])
const URL = 'https://chatgpt.com/backend-api/tbo/primary'
const CANARY = 'SYNTHETIC_PRIVATE_CANARY'
const signal = () => new AbortController().signal
const HEADERS = {
  Authorization: 'Bearer synthetic.token.value',
  'Content-Type': 'application/json',
  'ChatGPT-Account-Id': 'synthetic-account',
  'X-OpenAI-Expected-Account-Id': 'synthetic-account',
  'User-Agent': 'DSHDotAdapter/0.1',
}
const request = (): RequestInit => ({ method: 'GET', redirect: 'error', credentials: 'omit', headers: HEADERS })
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const ownedParents = new Set<string>()
const sessions: DotBrowserSession[] = []
afterEach(async () => {
  for (const session of sessions) await session.close().catch(() => undefined)
  sessions.length = 0
  for (const parent of ownedParents) {
    if ((await realpath(parent)) !== parent || dirname(parent) !== (await realpath(tmpdir())) || !basename(parent).startsWith('dsh-dot-session-test-'))
      throw new Error('Unexpected owned test directory')
    // Every factory in this suite is a fake and owns no OS process. Retention tests
    // remove only their own observed parent AFTER checking production retained it.
    await rm(parent, { recursive: true, force: false })
  }
  ownedParents.clear()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
async function fixture(patch: Partial<DotBrowserSessionIO> = {}, factoryOverride?: DotBrowserSessionTestFactory) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'dsh-dot-session-test-'))
  ownedParents.add(parent)
  const io: DotBrowserSessionIO = {
    frame: vi.fn(async () => ({ bytes: JPEG, width: 1280, height: 900 })),
    input: vi.fn(async () => undefined),
    admission: vi.fn(async () => ({ url: 'https://chatgpt.com/', status: 200, challenge: false, navigating: false })),
    request: vi.fn<DotBrowserSessionIO['request']>(async () => ({
      status: 200,
      headers: [['content-type', 'application/json']],
      bytes: new TextEncoder().encode('{"synthetic":true}'),
    })),
    close: vi.fn(async () => undefined),
    ...patch,
  }
  for (const name of ['request', 'admission', 'frame', 'input', 'close'] as const) vi.spyOn(io, name)
  let opened: Parameters<DotBrowserSessionTestFactory>[0] | undefined
  const factory = vi.fn<DotBrowserSessionTestFactory>(async options => {
    opened = options
    return factoryOverride ? factoryOverride(options) : io
  })
  const session = createDotBrowserSessionForTest({ chromiumExecutable: '/synthetic/chrome', privateProfileParentPath: parent }, factory)
  sessions.push(session)
  const ready = async () => {
    const viewer = await session.viewer(signal())
    await session.complete(signal())
    return viewer
  }
  return {
    session,
    io,
    factory,
    parent,
    ready,
    opened: () => {
      if (!opened) throw new Error('Not opened')
      return opened
    },
  }
}

describe('provider-owned bounded browser session (no real provider I/O)', () => {
  it('is lazy and denies transport until normal browser admission', async () => {
    const f = await fixture()
    expect(f.factory).not.toHaveBeenCalled()
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
    await expect(f.session.complete(signal())).rejects.toMatchObject({ code: 'not-ready' })
    const viewer = await f.session.viewer(signal())
    expect(f.factory).toHaveBeenCalledTimes(1)
    expect((await viewer.frame(signal())).bytes).toEqual(JPEG)
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
    await f.session.complete(signal())
    await viewer.close()
    expect(f.io.close).not.toHaveBeenCalled()
    expect(await (await f.session.fetch(URL, request())).json()).toEqual({ synthetic: true })
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(viewer.input({ kind: 'text', text: 'test' }, signal())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.session.complete(signal())).rejects.toMatchObject({ code: 'not-ready' })
    await f.session.close()
    expect(f.io.close).toHaveBeenCalledTimes(1)
    expect(await readdir(f.parent)).toEqual([])
  })

  it('uses a fresh 0700 profile/private HOME and an explicit environment allowlist', async () => {
    vi.stubEnv('HTTP_PROXY', CANARY)
    vi.stubEnv('HTTPS_PROXY', CANARY)
    vi.stubEnv('COOKIE', CANARY)
    vi.stubEnv('SSLKEYLOGFILE', CANARY)
    const f = await fixture()
    await f.session.viewer(signal())
    const opened = f.opened()
    expect(opened.privateProfilePath).not.toBe(f.parent)
    expect(dirname(opened.privateProfilePath)).toBe(f.parent)
    expect((await lstat(opened.privateProfilePath)).mode & 0o777).toBe(0o700)
    expect(opened.env.HOME).toBe(opened.privateProfilePath)
    expect(Object.keys(opened.env).sort()).toEqual(['HOME', 'LANG', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'])
    expect(JSON.stringify(opened.env)).not.toContain(CANARY)
    for (const name of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'])
      expect((await lstat(opened.env[name]!)).mode & 0o777).toBe(0o700)
  })

  it.each(['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PW_TEST_DEBUG_PROTOCOL'])(
    'refuses ambient diagnostics before creating a profile: %s',
    async name => {
      vi.stubEnv(name, CANARY)
      const f = await fixture()
      await expect(f.session.viewer(signal())).rejects.toThrow('Dot browser session operation refused.')
      expect(f.factory).not.toHaveBeenCalled()
      expect(await readdir(f.parent)).toEqual([])
    },
  )

  it.each([
    'https://chatgpt.com/',
    'http://localhost:4321/',
    'http://127.0.0.1/',
    'http://user:secret@127.0.0.1:4321/',
    'http://127.0.0.1:4321/?secret=value',
    'file:///tmp/synthetic',
    'not a URL',
  ])('the explicit TEST factory rejects every non-synthetic-local origin: %s', entry => {
    expect(() => createDotBrowserLocalFixtureFactoryForTest(entry)).toThrow('Dot browser session operation refused.')
  })

  it('revokes transport before sending if ambient diagnostics become enabled later', async () => {
    const f = await fixture()
    await f.ready()
    vi.stubEnv('DEBUG', CANARY)
    await expect(f.session.fetch(URL, request())).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.request).not.toHaveBeenCalled()
    await f.session.close()
  })

  it('accepts only absolute trusted paths and exposes no URL/argv option', () => {
    expect(() => createDotBrowserSession({ chromiumExecutable: 'chrome', privateProfileParentPath: '/tmp' })).toThrow('Dot browser session operation refused.')
    expect(() => createDotBrowserSession({ chromiumExecutable: '/chrome', privateProfileParentPath: './profile' })).toThrow(
      'Dot browser session operation refused.',
    )
    expect(() => createDotBrowserSession({ chromiumExecutable: '/chrome\0private', privateProfileParentPath: '/tmp' })).toThrow(
      'Dot browser session operation refused.',
    )
  })

  it.each([
    { url: 'https://auth.openai.com/', status: 200, challenge: false, navigating: false },
    { url: 'https://chatgpt.com.evil.test/', status: 200, challenge: false, navigating: false },
    { url: 'http://chatgpt.com/', status: 200, challenge: false, navigating: false },
    { url: 'https://chatgpt.com/', status: 403, challenge: true, navigating: false },
    { url: 'https://chatgpt.com/', status: 200, challenge: true, navigating: false },
    { url: 'https://chatgpt.com/', status: 200, challenge: false, navigating: true },
  ])('does not promote an unadmitted or challenged current page: %j', async admission => {
    const f = await fixture({ admission: async () => admission })
    const viewer = await f.session.viewer(signal())
    await expect(f.session.complete(signal())).rejects.toMatchObject({ code: 'not-admitted' })
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
    expect((await viewer.frame(signal())).bytes).toEqual(JPEG)
  })

  it('lets the human complete after a security check disappears, without automated retries', async () => {
    let challenged = true
    const f = await fixture({
      admission: async () => ({ url: 'https://chatgpt.com/', status: challenged ? 403 : 200, challenge: challenged, navigating: false }),
    })
    await f.session.viewer(signal())
    await expect(f.session.complete(signal())).rejects.toMatchObject({ code: 'not-admitted' })
    challenged = false
    await f.session.complete(signal())
    await f.session.fetch(URL, request())
    expect(f.io.request).toHaveBeenCalledTimes(1)
  })

  it('closing an unpromoted borrowed viewer destroys resources and prevents reentry', async () => {
    const f = await fixture()
    const viewer = await f.session.viewer(signal())
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
    await viewer.close()
    expect(f.io.close).toHaveBeenCalledTimes(1)
    expect(await readdir(f.parent)).toEqual([])
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
  })

  it('detaches the enrollment lifetime only on promotion; manager cleanup retains ready transport', async () => {
    const f = await fixture()
    const enrollment = new AbortController()
    const viewer = await f.session.viewer(enrollment.signal)
    await f.session.complete(signal())
    enrollment.abort()
    await viewer.close()
    expect(f.io.close).not.toHaveBeenCalled()
    await f.session.fetch(URL, request())
  })

  it('aborting an enrollment revokes frame/input and destroys the profile', async () => {
    const f = await fixture()
    const enrollment = new AbortController()
    const viewer = await f.session.viewer(enrollment.signal)
    enrollment.abort()
    await f.session.close()
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.io.close).toHaveBeenCalledTimes(1)
    expect(await readdir(f.parent)).toEqual([])
  })

  it('fences a late complete result after close, before any ready transport is authorized', async () => {
    const admission = deferred<Awaited<ReturnType<DotBrowserSessionIO['admission']>>>()
    const entered = deferred<void>()
    const f = await fixture({
      admission: async () => {
        entered.resolve()
        return admission.promise
      },
    })
    await f.session.viewer(signal())
    const completing = f.session.complete(signal())
    const rejected = expect(completing).rejects.toThrow('Dot browser session operation refused.')
    await entered.promise
    await f.session.close()
    admission.resolve({ url: 'https://chatgpt.com/', status: 200, challenge: false, navigating: false })
    await rejected
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
    expect(f.io.request).not.toHaveBeenCalled()
  })

  it('fences an aborted complete even if admission ignores its signal', async () => {
    const admission = deferred<Awaited<ReturnType<DotBrowserSessionIO['admission']>>>()
    const entered = deferred<void>()
    const f = await fixture({
      admission: async () => {
        entered.resolve()
        return admission.promise
      },
    })
    await f.session.viewer(signal())
    const controller = new AbortController()
    const completing = f.session.complete(controller.signal)
    const rejected = expect(completing).rejects.toThrow('Dot browser session operation refused.')
    await entered.promise
    controller.abort()
    await rejected
    admission.resolve({ url: 'https://chatgpt.com/', status: 200, challenge: false, navigating: false })
    await f.session.close()
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
  })

  it('does not delete the private profile until close positively confirms shutdown', async () => {
    const stopped = deferred<void>()
    const entered = deferred<void>()
    const f = await fixture({
      close: async () => {
        entered.resolve()
        await stopped.promise
      },
    })
    await f.session.viewer(signal())
    const closing = f.session.close()
    await entered.promise
    expect(await readdir(f.parent)).toHaveLength(1)
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
    stopped.resolve()
    await closing
    expect(await readdir(f.parent)).toEqual([])
  })

  it('retains its private profile and blocks replacement after unconfirmed shutdown', async () => {
    const f = await fixture({
      close: async () => {
        throw new Error(CANARY)
      },
    })
    await f.session.viewer(signal())
    await expect(f.session.close()).rejects.toThrow('Dot browser cleanup unconfirmed; private profile retained.')
    expect(await readdir(f.parent)).toHaveLength(1)
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
    await expect(f.session.close()).rejects.not.toThrow(CANARY)
  })

  it('retains a profile after explicitly unconfirmed factory cleanup', async () => {
    const f = await fixture({}, async () => {
      throw new DotBrowserSessionError('cleanup-unconfirmed')
    })
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    expect(await readdir(f.parent)).toHaveLength(1)
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
  })

  it('joins a late factory result before removing the profile after cancellation', async () => {
    const opening = deferred<DotBrowserSessionIO>()
    const entered = deferred<void>()
    const f = await fixture({}, async () => {
      entered.resolve()
      return opening.promise
    })
    const enrollment = new AbortController()
    const viewing = f.session.viewer(enrollment.signal)
    const rejected = expect(viewing).rejects.toThrow('Dot browser session operation refused.')
    await entered.promise
    enrollment.abort()
    expect(await readdir(f.parent)).toHaveLength(1)
    opening.resolve(f.io)
    await rejected
    expect(f.io.close).toHaveBeenCalledTimes(1)
    expect(await readdir(f.parent)).toEqual([])
  })

  it.each([
    { kind: 'pointer', action: 'down', x: 1280, y: 0, button: 'left' },
    { kind: 'pointer', action: 'down', x: 0, y: 0, button: 'right' },
    { kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 901 },
    { kind: 'key', action: 'down', key: 'Enter', modifiers: 8 },
    { kind: 'key', action: 'down', key: 'Tab', modifiers: 2 },
    { kind: 'key', action: 'down', key: 'F12', modifiers: 0 },
    { kind: 'text', text: 'line\nbreak' },
    { kind: 'text', text: 'x'.repeat(4097) },
    { kind: 'text', text: 'test', url: 'https://evil.test' },
  ])('rejects forbidden/unbounded page input: %j', async input => {
    const f = await fixture()
    const viewer = await f.session.viewer(signal())
    // SAFETY: Intentional malformed wire input proves the real shared schema rejects it before page I/O; never a production assertion.
    await expect(viewer.input(input as AuthInput, signal())).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.input).not.toHaveBeenCalled()
  })

  it('accepts bounded page-only navigation, coordinates, wheel and literal text', async () => {
    const f = await fixture()
    const viewer = await f.session.viewer(signal())
    for (const input of [
      { kind: 'pointer', action: 'down', x: 42, y: 53, button: 'left' },
      { kind: 'wheel', x: 42, y: 53, deltaX: 0, deltaY: 300 },
      { kind: 'key', action: 'down', key: 'Tab', modifiers: 8 },
      { kind: 'text', text: 'Synthetic human text' },
    ] satisfies AuthInput[])
      await viewer.input(input, signal())
    expect(f.io.input).toHaveBeenCalledTimes(4)
  })

  it.each([
    'http://chatgpt.com/backend-api/tbo/primary',
    'https://chatgpt.com.evil.test/backend-api/tbo/primary',
    'https://user:secret@chatgpt.com/backend-api/tbo/primary',
    'https://chatgpt.com:444/backend-api/tbo/primary',
    'https://chatgpt.com/api/auth/session',
    'https://chatgpt.com/backend-api/tbo/primary#fragment',
    'https://chatgpt.com/backend-api/tbo/primary#',
    'https://chatgpt.com/backend-api/tbo/primary?',
    'https://chatgpt.com/backend-api/tbo/primary?token=secret',
    'https://chatgpt.com/backend-api/messaging/rooms/%2F/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/%01/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/%1F/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/%20/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/%7f/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/%2e%2e/messages',
    'https://chatgpt.com/backend-api/messaging/rooms/id/messages?limit=999',
    'https://chatgpt.com/backend-api/messaging/rooms/id/messages?after=id&limit=32',
    'https://chatgpt.com/backend-api/messaging/rooms/id/messages?limit=32&after=id&url=evil',
    'https://chatgpt.com/backend-api/accounts/check',
  ])('rejects arbitrary/noncanonical URL before browser transport: %s', async url => {
    const f = await fixture()
    await f.ready()
    await expect(f.session.fetch(url, request())).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.request).not.toHaveBeenCalled()
  })

  it.each([
    { method: 'DELETE' },
    { method: 'POST' },
    { body: '{}' },
    { redirect: 'follow' },
    { credentials: 'include' },
    { mode: 'no-cors' },
    { headers: { Cookie: CANARY } },
    { headers: { 'User-Agent': 'fake browser' } },
    { headers: { Authorization: 'Bearer value\nsecret' } },
    { headers: { 'X-Arbitrary': CANARY } },
    { headers: { 'Content-Type': 'text/plain' } },
    { headers: { 'X-OpenAI-Expected-Account-Id': 'other-account' } },
  ] satisfies RequestInit[])('rejects unapproved method, init or headers: %j', async patch => {
    const f = await fixture()
    await f.ready()
    const init: RequestInit = { ...request(), ...patch }
    if ('headers' in patch) init.headers = { ...HEADERS, ...patch.headers }
    await expect(f.session.fetch(URL, init)).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.request).not.toHaveBeenCalled()
  })

  it('passes only allowed Dot headers and leaves the native UA/cookies entirely to Chromium', async () => {
    const f = await fixture()
    await f.ready()
    await f.session.fetch(URL, request())
    expect(f.io.request).toHaveBeenCalledWith(
      {
        url: URL,
        method: 'GET',
        body: undefined,
        headers: [
          ['authorization', 'Bearer synthetic.token.value'],
          ['chatgpt-account-id', 'synthetic-account'],
          ['content-type', 'application/json'],
          ['x-openai-expected-account-id', 'synthetic-account'],
        ],
      },
      expect.any(AbortSignal),
    )
  })

  it.each([
    '/tbo/by-thread/synthetic-id',
    '/messaging/rooms/synthetic-id',
    '/messaging/rooms/synthetic-id/messages?limit=1',
    '/messaging/rooms/synthetic-id/messages?limit=32&after=synthetic%20cursor',
  ])('supports the existing bounded Dot GET path: %s', async path => {
    const f = await fixture()
    await f.ready()
    await f.session.fetch(`https://chatgpt.com/backend-api${path}`, request())
    expect(f.io.request).toHaveBeenCalledTimes(1)
  })

  it('allows bounded send bodies only on the exact messages POST endpoint', async () => {
    const f = await fixture()
    await f.ready()
    const url = 'https://chatgpt.com/backend-api/messaging/rooms/synthetic-id/messages'
    await f.session.fetch(url, { ...request(), method: 'POST', body: '{"content":{"text":"Synthetic message"}}' })
    expect(f.io.request).toHaveBeenCalledTimes(1)
    await expect(f.session.fetch(url, { ...request(), method: 'POST', body: 'x'.repeat(65537) })).rejects.toThrow('Dot browser session operation refused.')
    await expect(f.session.fetch(url, { ...request(), method: 'POST', body: new Uint8Array(10) })).rejects.toThrow('Dot browser session operation refused.')
    await expect(f.session.fetch(new globalThis.Request(url), request())).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.request).toHaveBeenCalledTimes(1)
  })

  it('rechecks the current origin/admission before every browser request', async () => {
    let current = 'https://chatgpt.com/'
    const f = await fixture({ admission: async () => ({ url: current, status: 200, challenge: false, navigating: false }) })
    await f.ready()
    current = 'https://auth.openai.com/'
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-admitted' })
    expect(f.io.request).not.toHaveBeenCalled()
  })

  it.each([
    { status: 302, headers: [], bytes: new Uint8Array() },
    { status: 200, headers: [['set-cookie', CANARY]], bytes: new Uint8Array() },
    { status: 200, headers: [['content-type', 'x'.repeat(513)]], bytes: new Uint8Array() },
    { status: 200, headers: [], bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
  ] satisfies Awaited<ReturnType<DotBrowserSessionIO['request']>>[])('fails closed on redirected, overlarge or unapproved response case %#', async response => {
    const f = await fixture({ request: async () => response })
    await f.ready()
    await expect(f.session.fetch(URL, request())).rejects.toThrow('Dot browser session operation refused.')
    await f.session.close()
  })

  it('preserves only content type and Cloudflare challenge status for existing DotHttp', async () => {
    const f = await fixture({
      request: async () => ({
        status: 403,
        headers: [
          ['content-type', 'text/html'],
          ['cf-mitigated', 'challenge'],
        ],
        bytes: new TextEncoder().encode('Synthetic challenge'),
      }),
    })
    await f.ready()
    const response = await f.session.fetch(URL, request())
    expect(response.status).toBe(403)
    expect(response.headers.get('cf-mitigated')).toBe('challenge')
    expect([...response.headers.keys()]).toEqual(['cf-mitigated', 'content-type'])
    expect(f.io.request).toHaveBeenCalledTimes(1)
  })

  it('allows input during a pending screenshot instead of treating independent capability work as failure', async () => {
    const frame = deferred<Awaited<ReturnType<DotBrowserSessionIO['frame']>>>()
    const entered = deferred<void>()
    const f = await fixture({
      frame: async () => {
        entered.resolve()
        return frame.promise
      },
    })
    const viewer = await f.session.viewer(signal())
    const pending = viewer.frame(signal())
    await entered.promise
    try {
      await expect(viewer.input({ kind: 'text', text: 'Synthetic' }, signal())).resolves.toBeUndefined()
      expect(f.io.input).toHaveBeenCalledTimes(1)
    } finally {
      frame.resolve({ bytes: JPEG, width: 1280, height: 900 })
      await pending
    }
  })

  it('allows a send while an independent API poll is pending', async () => {
    const response = deferred<Awaited<ReturnType<DotBrowserSessionIO['request']>>>()
    const entered = deferred<void>()
    const f = await fixture({
      request: async value => {
        if (value.method === 'GET') {
          entered.resolve()
          return response.promise
        }
        return { status: 200, headers: [], bytes: new TextEncoder().encode('{"sent":true}') }
      },
    })
    await f.ready()
    const polling = f.session.fetch(URL, request())
    await entered.promise
    try {
      const sent = await f.session.fetch('https://chatgpt.com/backend-api/messaging/rooms/synthetic/messages', { ...request(), method: 'POST', body: '{}' })
      expect(await sent.json()).toEqual({ sent: true })
    } finally {
      response.resolve({ status: 200, headers: [], bytes: new Uint8Array() })
      await polling
    }
  })

  it('bounds screenshots and input independently, then fences both pending operations on close', async () => {
    const frame = deferred<Awaited<ReturnType<DotBrowserSessionIO['frame']>>>()
    const input = deferred<void>()
    const frameEntered = deferred<void>()
    const inputEntered = deferred<void>()
    const f = await fixture({
      frame: async () => {
        frameEntered.resolve()
        return frame.promise
      },
      input: async () => {
        inputEntered.resolve()
        return input.promise
      },
    })
    const viewer = await f.session.viewer(signal())
    const pending = Promise.allSettled([viewer.frame(signal()), viewer.input({ kind: 'text', text: 'Synthetic' }, signal())])
    await Promise.all([frameEntered.promise, inputEntered.promise])
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'busy' })
    await expect(viewer.input({ kind: 'text', text: 'Synthetic second input' }, signal())).rejects.toMatchObject({ code: 'busy' })
    await expect(f.session.complete(signal())).rejects.toMatchObject({ code: 'busy' })
    expect(f.io.frame).toHaveBeenCalledTimes(1)
    expect(f.io.input).toHaveBeenCalledTimes(1)
    await f.session.close()
    expect((await pending).map(result => result.status)).toEqual(['rejected', 'rejected'])
    frame.resolve({ bytes: JPEG, width: 1280, height: 900 })
    input.resolve()
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
  })

  it('admits at most eight HTTP operations without queues, reuses a released slot, and fences all remaining requests on close', async () => {
    const slots = Array.from({ length: 8 }, () => deferred<Awaited<ReturnType<DotBrowserSessionIO['request']>>>())
    const entered = deferred<void>()
    const signals: AbortSignal[] = []
    let count = 0
    const f = await fixture({
      request: async (_value, requestSignal) => {
        signals.push(requestSignal)
        const slot = slots[count++]
        if (count === 8) entered.resolve()
        if (slot) return slot.promise
        return { status: 200, headers: [], bytes: new Uint8Array() }
      },
    })
    await f.ready()
    const requests = Array.from({ length: 8 }, () => f.session.fetch(URL, request()))
    const settled = Promise.allSettled(requests)
    await entered.promise
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'busy' })
    expect(f.io.request).toHaveBeenCalledTimes(8)
    const firstSlot = slots[0]
    const firstRequest = requests[0]
    if (!firstSlot || !firstRequest) throw new Error('Missing synthetic request')
    firstSlot.resolve({ status: 200, headers: [], bytes: new Uint8Array() })
    await firstRequest
    expect((await f.session.fetch(URL, request())).status).toBe(200)
    expect(f.io.request).toHaveBeenCalledTimes(9)
    await f.session.close()
    expect((await settled).map(result => result.status)).toEqual(['fulfilled', ...Array(7).fill('rejected')])
    expect(signals.every(value => value.aborted)).toBe(true)
    for (const slot of slots) slot.resolve({ status: 200, headers: [], bytes: new Uint8Array() })
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
  })

  it('revokes in-flight operations even when a page ignores cancellation and fences late frames', async () => {
    const frame = deferred<Awaited<ReturnType<DotBrowserSessionIO['frame']>>>()
    const entered = deferred<void>()
    const f = await fixture({
      frame: async () => {
        entered.resolve()
        return frame.promise
      },
    })
    const viewer = await f.session.viewer(signal())
    const pending = viewer.frame(signal())
    const rejected = expect(pending).rejects.toThrow('Dot browser session operation refused.')
    await entered.promise
    const close = f.session.close()
    await rejected
    frame.resolve({ bytes: JPEG, width: 1280, height: 900 })
    await close
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('bounds failed cleanup, retains the profile, and does not acknowledge replacement', async () => {
    const stop = deferred<void>()
    const entered = deferred<void>()
    const f = await fixture({
      close: async () => {
        entered.resolve()
        await stop.promise
      },
    })
    await f.session.viewer(signal())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = f.session.close()
    const rejected = expect(closing).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    await entered.promise
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(await readdir(f.parent)).toHaveLength(1)
    await expect(f.session.viewer(signal())).rejects.toMatchObject({ code: 'busy' })
    stop.resolve()
  })

  it('stops a late factory result even after cleanup timed out; the profile stays retained', async () => {
    const opening = deferred<DotBrowserSessionIO>()
    const entered = deferred<void>()
    const stopped = deferred<void>()
    const f = await fixture(
      {
        close: async () => {
          stopped.resolve()
        },
      },
      async () => {
        entered.resolve()
        return opening.promise
      },
    )
    const enrollment = new AbortController()
    const viewer = f.session.viewer(enrollment.signal)
    const rejected = expect(viewer).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    await entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    enrollment.abort()
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(await readdir(f.parent)).toHaveLength(1)
    opening.resolve(f.io)
    await stopped.promise
    expect(f.io.close).toHaveBeenCalledTimes(1)
    expect(await readdir(f.parent)).toHaveLength(1)
  })

  it.each([
    { bytes: new Uint8Array(1024 * 1024 + 1), width: 1280, height: 900 },
    { bytes: new Uint8Array([1, 2, 3, 4, 5]), width: 1280, height: 900 },
    { bytes: JPEG, width: 1281, height: 900 },
  ])('rejects malformed or oversized frames case %#', async frame => {
    const f = await fixture({ frame: async () => frame })
    const viewer = await f.session.viewer(signal())
    await expect(viewer.frame(signal())).rejects.toThrow('Dot browser session operation refused.')
    await f.session.close()
  })

  it('never exposes browser error bodies/causes or silently retries a failed send', async () => {
    const f = await fixture({
      request: async () => {
        throw new Error(CANARY)
      },
    })
    await f.ready()
    await expect(
      f.session.fetch('https://chatgpt.com/backend-api/messaging/rooms/synthetic-id/messages', { ...request(), method: 'POST', body: '{}' }),
    ).rejects.toThrow('Dot browser session operation refused.')
    expect(f.io.request).toHaveBeenCalledTimes(1)
    await f.session.close()
    await expect(f.session.fetch(URL, request())).rejects.toMatchObject({ code: 'not-ready' })
  })
})
