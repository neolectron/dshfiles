// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Route } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFixtureBrowserFactory } from '../src/auth-browser.js'
import type { FixtureBrowserIO, FixtureBrowserOptions, FixtureBrowserPolicy } from '../src/auth-browser.js'
import type { BrowserPort } from '../src/auth-attempt.js'
import type { AuthInput } from '../src/auth-protocol.js'

const policy: FixtureBrowserPolicy = {
  kind: 'synthetic-local-fixture',
  entryUrl: 'http://127.0.0.1:43210/synthetic-auth',
  chromiumExecutable: '/synthetic/chromium',
}
const endpoint = 'ws://127.0.0.1:43211/devtools/browser/11111111-2222-3333-4444-555555555555'
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 0xff, 0xd9])
const canary = 'SYNTHETIC_PRIVATE_BROWSER_CANARY'
type PointerEventFixture = { type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'; x: number; y: number }
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}
// Every directory below is created by the factory under test, never an existing profile.
const ownedDirectories = new Set<string>()
afterEach(async () => {
  for (const directory of ownedDirectories) {
    try {
      // Fakes own no OS process: retained-profile failure tests can safely remove
      // their own validated directory after verifying that production left it alone.
      const absolute = await realpath(directory)
      if (absolute !== directory || dirname(directory) !== (await realpath(tmpdir())) || !basename(directory).startsWith('dsh-dot-fixture-'))
        throw new Error('Unexpected test profile')
      await rm(directory, { recursive: true, force: false })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  ownedDirectories.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.doUnmock('playwright-core')
  vi.resetModules()
  vi.useRealTimers()
})

function fixture(options: { endpointLine?: string; rangeEmpty?: boolean; port?: BrowserPort } = {}) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const done = deferred<SubprocessOutcome>()
  const spawned = deferred<SubprocessSpawnSpec>()
  let spec: SubprocessSpawnSpec | undefined
  const terminate = vi.fn(() => done.resolve({ exitCode: null, signal: 'SIGTERM' }))
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected: {},
    done: done.promise,
    terminate,
    waitForExit: vi.fn(async () => options.rangeEmpty ?? true),
  }
  const runtime: FixtureBrowserOptions['runtime'] = {
    resolveExecutable: vi.fn(async command => command),
    spawn: vi.fn(input => {
      spec = input
      ownedDirectories.add(input.cwd)
      spawned.resolve(input)
      input.signal?.addEventListener('abort', terminate, { once: true })
      queueMicrotask(() => {
        const line = options.endpointLine ?? `DevTools listening on ${endpoint}\n`
        if (options.endpointLine !== undefined) stderr.end(line)
        else stderr.write(line)
      })
      return handle
    }),
  }
  const port = options.port ?? {
    frame: vi.fn(async () => ({ bytes: jpeg, width: 1280, height: 900 })),
    input: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const browserIO: FixtureBrowserIO = { connect: vi.fn(async () => port) }
  const confirmLocalExecutionWorld = vi.fn(async () => true)
  const create = (patch: Partial<FixtureBrowserOptions> = {}) =>
    createFixtureBrowserFactory({ runtime, policy, browserIO, confirmLocalExecutionWorld, ...patch })
  return {
    runtime,
    handle,
    port,
    browserIO,
    confirmLocalExecutionWorld,
    create,
    spawned: spawned.promise,
    spec: () => {
      if (spec === undefined) throw new Error('No spawn')
      return spec
    },
  }
}
const signal = () => new AbortController().signal

// Source/fixture-only: this suite never starts Chromium or contacts any provider.
describe('explicit synthetic managed browser factory', () => {
  it.each([
    'https://chatgpt.com/auth/login',
    'http://localhost:43210/synthetic-auth',
    'file:///tmp/synthetic-auth',
    'http://127.0.0.1/synthetic-auth',
    'http://user:password@127.0.0.1:43210/synthetic-auth',
    'http://127.0.0.1:43210/synthetic-auth?token=private',
    'not a URL',
  ])('refuses non-fixture policy without spawning: %s', entryUrl => {
    const f = fixture()
    expect(() => f.create({ policy: { ...policy, entryUrl } })).toThrow('Synthetic fixture browser failed.')
    expect(f.runtime.spawn).not.toHaveBeenCalled()
    expect(f.confirmLocalExecutionWorld).not.toHaveBeenCalled()
  })

  it.each(['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PW_TEST_DEBUG_PROTOCOL'])(
    'fails closed before initialization when diagnostics are enabled: %s',
    async name => {
      vi.stubEnv(name, canary)
      const f = fixture()
      await expect(f.create()(signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
      expect(f.confirmLocalExecutionWorld).not.toHaveBeenCalled()
      expect(f.runtime.spawn).not.toHaveBeenCalled()
      expect(f.browserIO.connect).not.toHaveBeenCalled()
    },
  )

  it('requires positive same-world proof BEFORE executable resolution, profile creation or spawn', async () => {
    const f = fixture()
    const open = f.create({ confirmLocalExecutionWorld: async () => false })
    await expect(open(signal())).rejects.toThrow('Synthetic fixture browser failed.')
    expect(f.runtime.resolveExecutable).not.toHaveBeenCalled()
    expect(f.runtime.spawn).not.toHaveBeenCalled()
    // @ts-expect-error missing proof is rejected at the typed boundary and at runtime
    const missing = f.create({ confirmLocalExecutionWorld: undefined })
    await expect(missing(signal())).rejects.toThrow('Synthetic fixture browser failed.')
    const throwing = f.create({
      confirmLocalExecutionWorld: async () => {
        throw new Error(canary)
      },
    })
    await expect(throwing(signal())).rejects.toThrow('Synthetic fixture browser failed.')
  })

  it('creates fresh private profiles; raw pipes, sandbox on and no ambient environment values', async () => {
    vi.stubEnv('HTTP_PROXY', `http://${canary}.invalid`)
    vi.stubEnv('SYNTHETIC_CREDENTIAL', canary)
    vi.stubEnv('ARBITRARY_PARENT_CONFIG', canary)
    const f = fixture()
    const browser = await f.create()(signal())
    const spec = f.spec()
    expect(f.confirmLocalExecutionWorld).toHaveBeenCalledBefore(vi.mocked(f.runtime.resolveExecutable))
    expect(spec.stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    expect(spec.cwd).toBe(await realpath(spec.cwd))
    const info = await lstat(spec.cwd)
    expect(info.mode & 0o777).toBe(0o700)
    expect(spec.env?.HOME).toBe(spec.cwd)
    expect(spec.env?.XDG_CONFIG_HOME).toBe(`${spec.cwd}/config`)
    expect(spec.env?.TMPDIR).toBe(`${spec.cwd}/tmp`)
    expect(spec.env).toHaveProperty('HTTP_PROXY', undefined)
    expect(spec.env).toHaveProperty('SYNTHETIC_CREDENTIAL', undefined)
    expect(spec.env).toHaveProperty('ARBITRARY_PARENT_CONFIG', undefined)
    expect(JSON.stringify(spec.env)).not.toContain(canary)
    expect(spec.argv).toContain('--headless')
    expect(spec.argv).toContain('--remote-debugging-address=127.0.0.1')
    expect(spec.argv).toContain('--remote-debugging-port=0')
    expect(spec.argv.join(' ')).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|--proxy|--load-extension|--user-agent/u)
    expect(spec.argv).not.toContain(policy.entryUrl)
    expect(f.browserIO.connect).toHaveBeenCalledWith(endpoint, policy, expect.any(Function))
    expect(f.handle.collected).toEqual({})
    await browser.close()
    expect(spec.signal?.aborted).toBe(true)
    expect(f.handle.terminate).toHaveBeenCalled()
    expect(f.handle.waitForExit).toHaveBeenCalled()
    expect(f.port.close).toHaveBeenCalledTimes(1)
    await expect(lstat(spec.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await browser.close()
    expect(f.port.close).toHaveBeenCalledTimes(1)
    const second = fixture()
    const next = await second.create()(signal())
    expect(second.spec().cwd).not.toBe(spec.cwd)
    await next.close()
  })

  it.each([
    'DevTools listening on ws://203.0.113.1:43211/devtools/browser/11111111-2222-3333-4444-555555555555\n',
    `DevTools listening on ${endpoint}/extra\n`,
    `DevTools listening on ${endpoint.replace(':43211/', ':99999/')}\n`,
    'x'.repeat(64 * 1024 + 1),
    `${canary}\n`,
  ])('bounds and refuses invalid private stderr readiness', async endpointLine => {
    const f = fixture({ endpointLine })
    await expect(f.create()(signal())).rejects.toThrow('Synthetic fixture browser failed.')
    expect(f.browserIO.connect).not.toHaveBeenCalled()
    expect(f.handle.terminate).toHaveBeenCalled()
    await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not expose private connection errors and cleans setup failures', async () => {
    const f = fixture()
    const open = f.create({
      browserIO: {
        connect: async () => {
          throw new Error(`${canary} ${endpoint}`)
        },
      },
    })
    await expect(open(signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
    await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds an unresponsive startup connection, kills its range and leaves its profile until close can be proved', async () => {
    vi.useFakeTimers()
    const connection = deferred<BrowserPort>()
    const connecting = deferred<void>()
    const f = fixture()
    const pending = f.create({
      browserIO: {
        connect: () => {
          connecting.resolve()
          return connection.promise
        },
      },
    })(signal())
    // Attach rejection observation before advancing the startup and close deadlines.
    const result = pending.then(
      () => 'unexpected-success',
      error => (error instanceof Error ? error.message : 'unknown'),
    )
    await connecting.promise
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toContain('cleanup unconfirmed; private temporary profile retained')
    expect(f.handle.terminate).toHaveBeenCalled()
    expect((await lstat(f.spec().cwd)).mode & 0o777).toBe(0o700)
    connection.resolve(f.port)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.port.close).toHaveBeenCalledTimes(1)
    // A late connection is closed, but a previously unconfirmed deletion is never retried.
    expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
  })

  it('revokes input/frame immediately and awaits browser close AND managed range before deleting', async () => {
    const browserJoined = deferred<void>()
    const rangeJoined = deferred<boolean>()
    const f = fixture({
      port: {
        frame: async () => ({ bytes: jpeg, width: 1280, height: 900 }),
        input: async () => {},
        close: () => browserJoined.promise,
      },
    })
    vi.spyOn(f.handle, 'waitForExit').mockImplementation(() => rangeJoined.promise)
    const browser = await f.create()(signal())
    const closing = browser.close()
    await expect(browser.input({ kind: 'text', text: canary }, signal())).rejects.toThrow()
    await expect(browser.frame(signal())).rejects.toThrow()
    expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
    browserJoined.resolve()
    expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
    rangeJoined.resolve(true)
    await closing
    await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the private profile when whole-range quiescence is unknown', async () => {
    const f = fixture({ rangeEmpty: false })
    const browser = await f.create()(signal())
    await expect(browser.close()).rejects.toThrow('cleanup unconfirmed; private temporary profile retained')
    expect((await lstat(f.spec().cwd)).mode & 0o777).toBe(0o700)
    await expect(browser.frame(signal())).rejects.toThrow()
  })

  it('retains the profile and redacts a failed browser close even if the range is empty', async () => {
    const f = fixture({
      port: {
        frame: async () => ({ bytes: jpeg, width: 1280, height: 900 }),
        input: async () => {},
        close: async () => {
          throw new Error(canary)
        },
      },
    })
    const browser = await f.create()(signal())
    await expect(browser.close()).rejects.toThrow('cleanup unconfirmed; private temporary profile retained')
    expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
  })

  it.each([
    { rangeEmpty: true, childDone: true },
    { rangeEmpty: false, childDone: true },
    { rangeEmpty: true, childDone: false },
  ])('joins an expected native transport disconnect only with positive native joins: %j', async ({ rangeEmpty, childDone }) => {
    const f = fixture({ rangeEmpty })
    if (!childDone) {
      vi.useFakeTimers()
      vi.mocked(f.handle.terminate).mockImplementation(() => {})
    }
    let connected = true
    const context = {
      newPage: async () => ({
        on: vi.fn(),
        goto: async () => {},
      }),
      close: vi.fn(async () => {
        if (!connected) throw new Error(`${canary} ${endpoint}`)
      }),
      newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => {}) })),
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async () => {}),
      routeWebSocket: vi.fn(async () => {}),
    }
    const publicBrowser = {
      newContext: async () => context,
      isConnected: () => connected,
      close: vi.fn(async () => {
        if (!connected) throw new Error(`${canary} ${endpoint}`)
        connected = false
      }),
    }
    vi.doMock('playwright-core', () => ({ chromium: { connectOverCDP: async () => publicBrowser } }))
    const browser = await createFixtureBrowserFactory({ runtime: f.runtime, policy, confirmLocalExecutionWorld: f.confirmLocalExecutionWorld })(signal())
    // Native abort starts termination; CDP disappears before Playwright can
    // acknowledge its context/browser close. No real process or socket exists.
    f.spec().signal?.addEventListener(
      'abort',
      () => {
        connected = false
      },
      { once: true },
    )
    const closing = browser.close()
    if (rangeEmpty && childDone) {
      await expect(closing).resolves.toBeUndefined()
      await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      const rejected = expect(closing).rejects.toThrow(/^Synthetic fixture browser cleanup unconfirmed; private temporary profile retained\.$/u)
      if (!childDone) await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
    }
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(publicBrowser.close).toHaveBeenCalledTimes(1)
    expect(f.handle.waitForExit).toHaveBeenCalled()
  })

  it('refuses deletion after its directory identity/mode changes', async () => {
    const { chmod } = await import('node:fs/promises')
    const f = fixture()
    const browser = await f.create()(signal())
    await chmod(f.spec().cwd, 0o750)
    await expect(browser.close()).rejects.toThrow('cleanup unconfirmed; private temporary profile retained')
    expect((await lstat(f.spec().cwd)).isDirectory()).toBe(true)
  })

  it('joins automatic close on caller abort and never sends new input afterwards', async () => {
    const f = fixture()
    const controller = new AbortController()
    const browser = await f.create()(controller.signal)
    controller.abort()
    await expect(browser.input({ kind: 'text', text: canary }, signal())).rejects.toThrow()
    expect(f.port.input).not.toHaveBeenCalled()
    await browser.close()
    await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts only closed page input; rejects context menus, browser/clipboard chords and oversized text', async () => {
    const f = fixture()
    const browser = await f.create()(signal())
    const accepted: AuthInput[] = [
      { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' },
      { kind: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 300 },
      { kind: 'key', action: 'down', key: 'Tab', modifiers: 8 },
      { kind: 'text', text: canary },
    ]
    for (const input of accepted) await browser.input(input, signal())
    expect(f.port.input).toHaveBeenCalledTimes(accepted.length)
    const refused: AuthInput[] = [
      { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'right' },
      { kind: 'pointer', action: 'move', x: 1280, y: 20, button: 'left' },
      { kind: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 901 },
      { kind: 'key', action: 'down', key: 'Home', modifiers: 2 },
      { kind: 'key', action: 'down', key: 'Escape', modifiers: 8 },
      { kind: 'key', action: 'down', key: 'Delete', modifiers: 8 },
      { kind: 'text', text: 'x'.repeat(4097) },
      { kind: 'text', text: '\u0000' },
    ]
    for (const input of refused) await expect(browser.input(input, signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
    expect(f.port.input).toHaveBeenCalledTimes(accepted.length)
    await browser.close()
  })

  it.each([
    { bytes: jpeg, width: 1441, height: 900 },
    { bytes: jpeg, width: 1280, height: 1001 },
    { bytes: jpeg, width: 0, height: 900 },
    { bytes: new Uint8Array(1024 * 1024 + 1), width: 1280, height: 900 },
    { bytes: new Uint8Array([1, 2, 3, 4, 5]), width: 1280, height: 900 },
  ])('bounds frame bytes/dimensions and accepts JPEG only', async frame => {
    const f = fixture({ port: { frame: async () => frame, input: async () => {}, close: async () => {} } })
    const browser = await f.create()(signal())
    await expect(browser.frame(signal())).rejects.toThrow()
    await browser.close()
  })

  it('releases repeat-coordinate UP without entering Playwright left-down move', async () => {
    let leftDown = false
    let position = { x: 0, y: 0 }
    const dragEntered = deferred<'blocked'>()
    const unblock = deferred<void>()
    const releases: { x: number; y: number }[] = []
    const mouse = {
      move: vi.fn(async (x: number, y: number) => {
        if (leftDown) {
          dragEntered.resolve('blocked')
          await unblock.promise
        }
        position = { x, y }
      }),
      down: vi.fn(async () => {
        leftDown = true
      }),
      up: vi.fn(async () => {
        leftDown = false
        releases.push(position)
      }),
    }
    const send = vi.fn(async (_method: string, event: PointerEventFixture) => {
      position = { x: event.x, y: event.y }
      if (event.type === 'mousePressed') leftDown = true
      if (event.type === 'mouseReleased') {
        leftDown = false
        releases.push(position)
      }
    })
    const page = { on: vi.fn(), goto: async () => {}, url: () => policy.entryUrl, mouse }
    const context = {
      newPage: async () => page,
      newCDPSession: vi.fn(async () => ({ send })),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async () => {}),
      routeWebSocket: vi.fn(async () => {}),
    }
    vi.doMock('playwright-core', () => ({ chromium: { connectOverCDP: async () => ({ newContext: async () => context, close: async () => {} }) } }))
    const f = fixture()
    const browser = await createFixtureBrowserFactory({ runtime: f.runtime, policy, confirmLocalExecutionWorld: f.confirmLocalExecutionWorld })(signal())
    await browser.input({ kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' }, signal())
    const release = browser.input({ kind: 'pointer', action: 'up', x: 10, y: 20, button: 'left' }, signal())
    try {
      expect(await Promise.race([release.then(() => 'released'), dragEntered.promise])).toBe('released')
      expect(releases).toEqual([{ x: 10, y: 20 }])
      expect(leftDown).toBe(false)
      expect(context.newCDPSession).toHaveBeenCalledWith(page)
      expect(mouse.move).not.toHaveBeenCalled()
    } finally {
      unblock.resolve()
      await release
      await browser.close()
    }
  })

  it('redacts a rejected pointer dispatch, revokes uncertain state and never retries', async () => {
    const send = vi.fn(async () => {
      throw new Error(`${canary} ${endpoint}`)
    })
    const page = { on: vi.fn(), goto: async () => {}, url: () => policy.entryUrl }
    const context = {
      newPage: async () => page,
      newCDPSession: vi.fn(async () => ({ send })),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async () => {}),
      routeWebSocket: vi.fn(async () => {}),
    }
    const publicBrowser = { newContext: async () => context, close: vi.fn(async () => {}) }
    vi.doMock('playwright-core', () => ({ chromium: { connectOverCDP: async () => publicBrowser } }))
    const f = fixture()
    const browser = await createFixtureBrowserFactory({ runtime: f.runtime, policy, confirmLocalExecutionWorld: f.confirmLocalExecutionWorld })(signal())
    const down: AuthInput = { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' }
    await expect(browser.input(down, signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
    await expect(browser.input(down, signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
    expect(send).toHaveBeenCalledTimes(1)
    await browser.close()
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(publicBrowser.close).toHaveBeenCalledTimes(1)
    expect(f.handle.waitForExit).toHaveBeenCalled()
    await expect(lstat(f.spec().cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('configures the public Playwright boundary with fresh context, default-deny routes, no JS and no disk capture', async () => {
    // A module fake at the maintained library boundary: no browser process or socket exists.
    type RouteFixture = {
      request(): { url(): string; method(): string; resourceType(): string; frame(): object }
      abort(reason: string): Promise<void>
      fetch(options: { maxRedirects: number; timeout: number }): Promise<{ status(): number; headers(): Record<string, string> }>
      fulfill(options: Parameters<Route['fulfill']>[0]): Promise<void>
    }
    let routed: ((route: RouteFixture) => Promise<void>) | undefined
    let socketHandler: ((socket: { close(): Promise<void> }) => Promise<void>) | undefined
    const mainFrame = {}
    let url = 'about:blank'
    const page = {
      on: vi.fn(),
      mainFrame: () => mainFrame,
      url: () => url,
      goto: vi.fn(async (entry: string) => {
        url = entry
      }),
      screenshot: vi.fn(async () => jpeg),
      close: vi.fn(async () => {}),
      mouse: { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
      keyboard: { insertText: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    }
    const send = vi.fn(async (_method: 'Input.dispatchMouseEvent', _event: PointerEventFixture) => {})
    const context = {
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({ send })),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      route: vi.fn(async (_pattern: string, handler: (route: RouteFixture) => Promise<void>) => {
        routed = handler
      }),
      routeWebSocket: vi.fn(async (_pattern: string, handler: (socket: { close(): Promise<void> }) => Promise<void>) => {
        socketHandler = handler
      }),
    }
    const publicBrowser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) }
    const connectOverCDP = vi.fn(async () => publicBrowser)
    vi.doMock('playwright-core', () => ({ chromium: { connectOverCDP } }))
    const f = fixture()
    // Undefined means use the maintained default IO, not our high-level fake seam.
    const open = createFixtureBrowserFactory({ runtime: f.runtime, policy, confirmLocalExecutionWorld: f.confirmLocalExecutionWorld })
    const browser = await open(signal())
    expect(connectOverCDP).toHaveBeenCalledWith(endpoint, { timeout: 10_000 })
    expect(publicBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      javaScriptEnabled: false,
    })
    expect(context.newPage).toHaveBeenCalledTimes(1)
    expect(page.goto).toHaveBeenCalledWith(policy.entryUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    await expect(browser.frame(signal())).resolves.toEqual({ bytes: jpeg, width: 1280, height: 900 })
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 65, fullPage: false, timeout: 10_000 })
    await browser.input({ kind: 'text', text: canary }, signal())
    expect(page.keyboard.insertText).toHaveBeenCalledWith(canary)
    const completedDown = new AbortController()
    await browser.input({ kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' }, completedDown.signal)
    completedDown.abort()
    await browser.input({ kind: 'pointer', action: 'up', x: 10, y: 20, button: 'left' }, signal())
    expect(context.newCDPSession).toHaveBeenCalledExactlyOnceWith(page)
    await browser.input({ kind: 'pointer', action: 'move', x: 15, y: 25, button: 'left' }, signal())
    await browser.input({ kind: 'pointer', action: 'down', x: 15, y: 25, button: 'left' }, signal())
    await browser.input({ kind: 'pointer', action: 'move', x: 30, y: 40, button: 'left' }, signal())
    await browser.input({ kind: 'wheel', x: 35, y: 45, deltaX: 1, deltaY: 20 }, signal())
    await browser.input({ kind: 'pointer', action: 'up', x: 50, y: 60, button: 'left' }, signal())
    await browser.input({ kind: 'wheel', x: 55, y: 65, deltaX: 0, deltaY: -20 }, signal())
    expect(send.mock.calls).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 15, y: 25, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 15, y: 25, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 40, button: 'left', buttons: 1, clickCount: 0, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 35, y: 45, buttons: 1, modifiers: 0, deltaX: 1, deltaY: 20 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 60, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 55, y: 65, buttons: 0, modifiers: 0, deltaX: 0, deltaY: -20 }],
    ])
    expect(page.mouse.move).not.toHaveBeenCalled()
    expect(page.mouse.down).not.toHaveBeenCalled()
    expect(page.mouse.up).not.toHaveBeenCalled()
    expect(page.mouse.wheel).not.toHaveBeenCalled()
    const sent = send.mock.calls.length
    for (const input of [
      { kind: 'pointer', action: 'down', x: 10, y: 20, button: 'right' },
      { kind: 'pointer', action: 'up', x: 1280, y: 20, button: 'left' },
      { kind: 'pointer', action: 'move', x: -1, y: 20, button: 'left' },
      { kind: 'wheel', x: 10, y: 900, deltaX: 0, deltaY: 1 },
    ] satisfies AuthInput[]) {
      await expect(browser.input(input, signal())).rejects.toThrow(/^Synthetic fixture browser failed\.$/u)
    }
    expect(send).toHaveBeenCalledTimes(sent)
    const aborted = new AbortController()
    aborted.abort()
    await expect(browser.input({ kind: 'pointer', action: 'down', x: 10, y: 20, button: 'left' }, aborted.signal)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(sent)
    expect(context.close).not.toHaveBeenCalled()
    expect(publicBrowser.close).not.toHaveBeenCalled()
    if (routed === undefined || socketHandler === undefined) throw new Error('Missing default-deny routes')
    for (const requested of [
      policy.entryUrl,
      'https://provider.invalid/private',
      'file:///etc/passwd',
      'chrome://settings',
      'http://127.0.0.1:43212/elsewhere',
    ]) {
      const abort = vi.fn(async () => {})
      const fetch = vi.fn(async () => ({ status: () => 200, headers: () => ({}) }))
      const fulfill = vi.fn(async () => {})
      await routed({
        request: () => ({ url: () => requested, method: () => 'GET', resourceType: () => 'document', frame: () => mainFrame }),
        abort,
        fetch,
        fulfill,
      })
      if (requested === policy.entryUrl) {
        expect(fetch).toHaveBeenCalledWith({ maxRedirects: 0, timeout: 10_000 })
        expect(fulfill).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expect.objectContaining({
              'content-security-policy': expect.stringContaining("form-action 'self'"),
              'referrer-policy': 'no-referrer',
            }),
          }),
        )
      } else {
        expect(abort).toHaveBeenCalledWith('blockedbyclient')
        expect(fetch).not.toHaveBeenCalled()
      }
    }
    const abort = vi.fn(async () => {})
    const fulfill = vi.fn(async () => {})
    await routed({
      request: () => ({ url: () => policy.entryUrl, method: () => 'GET', resourceType: () => 'document', frame: () => mainFrame }),
      abort,
      fetch: async () => ({ status: () => 302, headers: () => ({ location: 'https://provider.invalid' }) }),
      fulfill,
    })
    expect(abort).toHaveBeenCalledWith('blockedbyclient')
    expect(fulfill).not.toHaveBeenCalled()
    const socketClose = vi.fn(async () => {})
    await socketHandler({ close: socketClose })
    expect(socketClose).toHaveBeenCalledTimes(1)
    await browser.close()
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(publicBrowser.close).toHaveBeenCalledTimes(1)
  })

  it('allows only one operation in flight and discards late frames after close', async () => {
    const pending = deferred<{ bytes: Uint8Array; width: number; height: number }>()
    const f = fixture({ port: { frame: () => pending.promise, input: async () => {}, close: async () => {} } })
    const browser = await f.create()(signal())
    const frame = browser.frame(signal())
    await expect(browser.frame(signal())).rejects.toThrow()
    await expect(browser.input({ kind: 'text', text: canary }, signal())).rejects.toThrow()
    await browser.close()
    pending.resolve({ bytes: jpeg, width: 1280, height: 900 })
    await expect(frame).rejects.toThrow()
  })
})
