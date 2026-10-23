// SPDX-License-Identifier: AGPL-3.0-only
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionFetchRoute, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { JsonText } from '@dshfiles/dshx/api'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthAttemptManager } from '../src/auth-attempt.js'
import type { BrowserPort } from '../src/auth-attempt.js'
import { authStartResultSchema, dotAuthCapabilityHeader, dotAuthRoutes } from '../src/auth-protocol.js'
import { registerDotAuthRoutes } from '../src/auth-transport.js'

const canary = 'SYNTHETIC_PRIVATE_AUTH_CANARY'
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(canary), 0xff, 0xd9])
const origin = 'http://127.0.0.1:3199'
const cleanups: Array<() => Promise<void>> = []
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function fixture(port: BrowserPort = { frame: async () => ({ bytes: jpeg, width: 640, height: 480 }), input: async () => {}, close: async () => {} }) {
  // Real public Peer identities, but intentionally injected native admission: this is
  // NOT proof of the production carrier's authentication or BrowserPort adapter.
  const context = new Context()
  const browser = new Peer(context, { principal: { kind: 'owner' } })
  const apiOwner = new Peer(context, { principal: { kind: 'owner' } })
  const routes = new Map<string, ConnectionFetchRoute>()
  const removals = vi.fn(async (path: string) => {
    routes.delete(path)
  })
  let admission: 'browser' | 'api-owner' | 'unauthorized' | 'untrusted' = 'browser'
  const admit = vi.fn<HostConnectionHandle['admit']>(request => {
    expect(request).toBeInstanceOf(Request)
    expect(request.headers).toBeInstanceOf(Headers)
    if (admission === 'unauthorized') return { rejection: 401 }
    if (admission === 'untrusted') return { rejection: 403 }
    return { peer: admission === 'api-owner' ? apiOwner : browser }
  })
  const connection: Pick<HostConnectionHandle, 'fetch' | 'admit' | 'browserPeer'> = {
    browserPeer: browser,
    admit,
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => removals(route.path)
      },
    },
  }
  const manager = new AuthAttemptManager({ open: async () => port })
  const dispose = registerDotAuthRoutes(connection, manager, { browserOrigin: origin })
  cleanups.push(async () => {
    await dispose().catch(() => {})
    await browser.dispose()
    await apiOwner.dispose()
  })
  async function send(
    operation: keyof typeof dotAuthRoutes,
    options: {
      cap?: string
      body?: object
      raw?: string
      origin?: string | null
      host?: string
      headers?: Record<string, string>
      method?: string
      suffix?: string
    } = {},
  ) {
    const route = routes.get(dotAuthRoutes[operation])
    if (!route) throw new Error('Expected fixture route')
    const headers = new Headers({ host: options.host ?? '127.0.0.1:3199', 'content-type': 'application/json', ...options.headers })
    if (options.origin !== null) headers.set('origin', options.origin ?? origin)
    if (options.cap) headers.set(dotAuthCapabilityHeader, options.cap)
    const method = options.method ?? 'POST'
    const init: RequestInit = { method, headers }
    if (method !== 'GET' && method !== 'HEAD') init.body = options.raw ?? JSON.stringify(options.body ?? {})
    return route.fetch(new Request(`${origin}${route.path}${options.suffix ?? ''}`, init))
  }
  async function start() {
    const response = await send('start', { body: { acceptRisks: true } })
    expect(response.status).toBe(200)
    const result = JsonText.parse(await response.text(), authStartResultSchema)
    await settle()
    return result
  }
  return {
    routes,
    admit,
    manager,
    removals,
    dispose,
    send,
    start,
    setAdmission(value: typeof admission) {
      admission = value
    },
  }
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
})

it('registers exactly the frozen routes through the native public streaming fetch seam and disposes them', async () => {
  const f = fixture()
  expect([...f.routes.keys()]).toEqual(Object.values(dotAuthRoutes))
  for (const route of f.routes.values()) {
    expect(route.requestBody).toBe('streaming')
    expect(route.methods).toEqual(['POST'])
  }
  const start = await f.start()
  await f.dispose()
  expect(f.routes.size).toBe(0)
  expect(f.removals).toHaveBeenCalledTimes(5)
  expect(() => f.manager.status(start.capability)).toThrow()
  await f.dispose()
  expect(f.removals).toHaveBeenCalledTimes(5)
})

it('requires bounded strict empty JSON on status/frame and rejects GET without capturing', async () => {
  const port: BrowserPort = {
    frame: vi.fn(async () => ({ bytes: jpeg, width: 640, height: 480 })),
    input: async () => {},
    close: async () => {},
  }
  const f = fixture(port)
  const start = await f.start()
  for (const operation of ['status', 'frame'] as const) {
    for (const raw of [JSON.stringify({ command: canary }), '[]', 'null', canary, '', 'x'.repeat(8193)]) {
      const response = await f.send(operation, { cap: start.capability, raw })
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('{"error":"invalid-request"}')
    }
    expect((await f.send(operation, { cap: start.capability, method: 'GET' })).status).toBe(400)
  }
  expect(port.frame).not.toHaveBeenCalled()
  expect((await f.send('status', { cap: start.capability, body: {} })).status).toBe(200)
  expect((await f.send('frame', { cap: start.capability, body: {} })).status).toBe(200)
  expect(port.frame).toHaveBeenCalledTimes(1)
})

it('requires configured exact external origin even when native bridge Request URL uses dsh.internal', async () => {
  const f = fixture()
  const route = f.routes.get(dotAuthRoutes.start)
  if (!route) throw new Error('Expected start route')
  for (const [suppliedOrigin, status] of [
    [origin, 200],
    ['https://127.0.0.1:3199', 403],
    ['http://dsh.internal', 403],
  ] as const) {
    const response = await route.fetch(
      new Request(`http://dsh.internal${route.path}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:3199', origin: suppliedOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ acceptRisks: true }),
      }),
    )
    expect(response.status).toBe(status)
  }
})

it('requires native browser admission, rejects API-owner and forged-cookie requests before opening', async () => {
  const f = fixture()
  for (const [mode, status] of [
    ['unauthorized', 401],
    ['untrusted', 403],
    ['api-owner', 403],
  ] as const) {
    f.setAdmission(mode)
    const response = await f.send('start', { body: { acceptRisks: true }, headers: { cookie: 'dsh-session=forged; dsh-browser=forged; token=forged' } })
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('forged')
  }
  f.setAdmission('browser')
  await f.start()
  f.setAdmission('api-owner')
  expect((await f.send('status')).status).toBe(403)
  expect(f.admit).toHaveBeenCalled()
})

it('requires same-origin CSRF for every POST, Host agreement and native trust, not cookie names', async () => {
  const f = fixture()
  for (const options of [
    { origin: null },
    { origin: 'https://evil.invalid' },
    { origin: 'null' },
    { host: 'evil.invalid' },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
  ]) {
    expect((await f.send('start', { body: { acceptRisks: true }, ...options })).status).toBe(403)
  }
  const start = await f.start()
  for (const operation of ['status', 'frame', 'input', 'cancel'] as const) {
    expect((await f.send(operation, { cap: start.capability, body: {}, origin: null })).status).toBe(403)
    expect((await f.send(operation, { cap: start.capability, body: {}, origin: 'https://evil.invalid' })).status).toBe(403)
  }
  expect((await f.send('status', { cap: start.capability })).status).toBe(200)
})

it('returns capability only from browser start, rejects queries and requires header possession on every private route', async () => {
  const f = fixture()
  const start = await f.start()
  for (const operation of ['status', 'frame', 'input', 'cancel'] as const) {
    for (const options of [{}, { cap: 'forged' }, { suffix: `?capability=${canary}` }, { suffix: `?attemptId=${start.attempt.id}` }]) {
      const requestOptions: Parameters<typeof f.send>[1] = { ...options }
      if (operation === 'input' || operation === 'cancel') requestOptions.body = {}
      const response = await f.send(operation, requestOptions)
      expect(response.status).not.toBe(200)
      const raw = await response.text()
      expect(raw).not.toContain(canary)
      expect(raw).not.toContain(start.capability)
    }
  }
  const response = await f.send('status', { cap: start.capability })
  expect(response.status).toBe(200)
  expect(await response.text()).not.toContain(start.capability)
  expect(response.headers.get('cache-control')).toBe('no-store')
})

it('serves private JPEG bytes without base64/JSON and with bounded metadata and no caching', async () => {
  const f = fixture()
  const start = await f.start()
  const frame = await f.send('frame', { cap: start.capability })
  expect(frame.status).toBe(200)
  expect(frame.headers.get('content-type')).toBe('image/jpeg')
  expect(frame.headers.get('cache-control')).toBe('no-store')
  expect(frame.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(frame.headers.get('x-dot-auth-width')).toBe('640')
  expect(frame.headers.get('x-dot-auth-height')).toBe('480')
  expect(new Uint8Array(await frame.arrayBuffer())).toEqual(jpeg)
  const status = await f.send('status', { cap: start.capability })
  expect(await status.text()).not.toContain(canary)
})

it('validates strict native schemas and sanitizes malformed bodies, unknown fields and browser commands', async () => {
  const f = fixture()
  for (const body of [{ acceptRisks: false }, { acceptRisks: true, command: canary }, {}]) {
    const response = await f.send('start', { body })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(canary)
  }
  const start = await f.start()
  for (const raw of [
    canary,
    JSON.stringify({ attemptId: start.attempt.id, sequence: 1, input: { kind: 'navigate', url: canary } }),
    JSON.stringify({ attemptId: start.attempt.id, sequence: 1, input: { kind: 'text', text: canary }, command: canary }),
  ]) {
    const response = await f.send('input', { cap: start.capability, raw })
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('{"error":"invalid-request"}')
  }
  const valid = await f.send('input', { cap: start.capability, body: { attemptId: start.attempt.id, sequence: 1, input: { kind: 'text', text: canary } } })
  expect(valid.status).toBe(200)
  expect(await valid.text()).not.toContain(canary)
})

it('bounds streamed bodies to 8KiB, rejects misleading length/content type/encoding and cancels overflow', async () => {
  const f = fixture()
  for (const options of [
    { raw: 'x'.repeat(8193) },
    { body: { acceptRisks: true }, headers: { 'content-length': '8193' } },
    { body: { acceptRisks: true }, headers: { 'content-length': canary } },
    { body: { acceptRisks: true }, headers: { 'content-type': 'text/plain' } },
    { body: { acceptRisks: true }, headers: { 'content-encoding': 'gzip' } },
  ]) {
    const response = await f.send('start', options)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(canary)
  }
  const cancelled = vi.fn()
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(4096))
    },
    cancel: cancelled,
  })
  const route = f.routes.get(dotAuthRoutes.start)
  if (!route) throw new Error('Expected start route')
  const init = { method: 'POST', headers: { host: '127.0.0.1:3199', origin, 'content-type': 'application/json', 'content-length': '1' }, body, duplex: 'half' }
  const response = await route.fetch(new Request(`${origin}${route.path}`, init))
  expect(response.status).toBe(400)
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(pulls).toBeLessThanOrEqual(4)
})

it('revokes on cancel and rejects stale/cross-attempt data, double start and late private frame publication', async () => {
  let resolve!: (value: { bytes: Uint8Array; width: number; height: number }) => void
  const pending = new Promise<{ bytes: Uint8Array; width: number; height: number }>(done => {
    resolve = done
  })
  let captureStarted!: () => void
  const capture = new Promise<void>(done => {
    captureStarted = done
  })
  const port: BrowserPort = {
    frame: () => {
      captureStarted()
      return pending
    },
    input: async () => {},
    close: vi.fn(async () => {}),
  }
  const f = fixture(port)
  const start = await f.start()
  expect((await f.send('start', { body: { acceptRisks: true } })).status).toBe(409)
  const late = f.send('frame', { cap: start.capability })
  await capture
  const cancelled = await f.send('cancel', { cap: start.capability, body: {} })
  expect(cancelled.status).toBe(200)
  expect(await cancelled.text()).not.toContain(start.capability)
  resolve({ bytes: jpeg, width: 640, height: 480 })
  const lateResponse = await late
  expect(lateResponse.status).toBe(409)
  expect(await lateResponse.text()).not.toContain(canary)
  expect((await f.send('status', { cap: start.capability })).status).toBe(403)
  const fresh = await f.start()
  const crossed = await f.send('input', { cap: fresh.capability, body: { attemptId: start.attempt.id, sequence: 1, input: { kind: 'text', text: canary } } })
  expect(crossed.status).toBe(409)
  expect(await crossed.text()).not.toContain(canary)
  expect(port.close).toHaveBeenCalledTimes(1)
})

it('does not falsely acknowledge cancel or permit a second browser when close rejects', async () => {
  const port: BrowserPort = {
    frame: async () => ({ bytes: jpeg, width: 1, height: 1 }),
    input: async () => {},
    close: vi.fn(async () => {
      throw new Error(canary)
    }),
  }
  const f = fixture(port)
  const start = await f.start()
  const cancelled = await f.send('cancel', { cap: start.capability, body: {} })
  expect(cancelled.status).toBe(502)
  expect(await cancelled.text()).toBe('{"error":"failed"}')
  expect((await f.send('status', { cap: start.capability })).status).toBe(403)
  expect((await f.send('start', { body: { acceptRisks: true } })).status).toBe(409)
  expect(port.close).toHaveBeenCalledTimes(1)
})

it('never echoes a port exception, raw cause or input and never retries', async () => {
  const port: BrowserPort = {
    frame: vi.fn(async () => {
      throw new Error(canary)
    }),
    input: async () => {},
    close: async () => {
      throw new Error(canary)
    },
  }
  const f = fixture(port)
  const start = await f.start()
  const response = await f.send('frame', { cap: start.capability })
  expect(response.status).toBe(502)
  expect(await response.text()).toBe('{"error":"failed"}')
  expect(port.frame).toHaveBeenCalledTimes(1)
  expect((await f.send('frame', { cap: start.capability })).status).toBe(403)
})
