// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BotAdapterError } from '@dshfiles/bots/adapter'
import { JsonText } from '@dshfiles/dshx/api'
import { createDotAccountAuthorityClient, type DotAccountAuthorityClientOptions } from '../src/account-authority-client.js'
import { DotAccountAuthorityProtocol } from '../src/account-authority-contract.js'

const purposeBearer = 'SYNTHETIC_PRIVATE_AUTHORITY_BEARER_ONLY_1'
const access = 'SYNTHETIC_PRIVATE_UPSTREAM_ACCESS_ONLY_1'
const accountId = 'codex_manuel'
const origin = 'http://127.0.0.1:1'
const signal = () => new AbortController().signal
const output = (id = accountId, value = access) => ({ version: DotAccountAuthorityProtocol.version, accountId: id, accessToken: value })
const response = () => Response.json(output())
const boundPortSchema = z.object({ port: z.number().int().min(1).max(65535) })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const client = (
  options: Omit<DotAccountAuthorityClientOptions, 'origin' | 'resolveBearerToken'> &
    Partial<Pick<DotAccountAuthorityClientOptions, 'origin' | 'resolveBearerToken'>> = {},
) => {
  const value = createDotAccountAuthorityClient({ origin, resolveBearerToken: async () => purposeBearer, ...options })
  cleanups.push(() => value.close())
  return value
}
const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function refused<Result>(operation: Promise<Result>, code: 'auth-required' | 'unavailable') {
  let rejected = false
  try {
    await operation
  } catch (error) {
    rejected = true
    expect(error).toBeInstanceOf(BotAdapterError)
    expect(error).toMatchObject({ code })
    expect(error).not.toHaveProperty('cause')
    expect(String(error)).not.toContain('PRIVATE')
    expect(JSON.stringify(error)).not.toContain('PRIVATE')
    expect(String(error)).not.toContain('127.0.0.1')
  }
  expect(rejected).toBe(true)
}
interface ObservedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: IncomingMessage['headers']
  readonly body: string
}
async function serverFixture(reply: (request: ObservedRequest, response: ServerResponse) => void) {
  const requests: ObservedRequest[] = []
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected synthetic request chunk')
        chunks.push(chunk)
      }
      const request = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(request)
      reply(request, outgoing)
    })().catch(() => {
      outgoing.writeHead(500)
      outgoing.end('SYNTHETIC_PRIVATE_STUB_ERROR')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(new Error('Synthetic authority fixture cleanup failed')) : resolve())))
  })
  const address = boundPortSchema.parse(server.address())
  return { origin: `http://127.0.0.1:${address.port}`, requests }
}

describe('private backend account authority client', () => {
  it('uses actual loopback HTTP with fresh separate purpose credentials and canonical account input/output', async () => {
    let currentBearer = purposeBearer
    let currentAccess = access
    const fixture = await serverFixture((request, res) => {
      const input = JsonText.parse(request.body, DotAccountAuthorityProtocol.input)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(output(input.accountId, currentAccess)))
    })
    const reads: AbortSignal[] = []
    const test = client({
      origin: fixture.origin,
      resolveBearerToken: async cancellation => {
        expect(cancellation.aborted).toBe(false)
        reads.push(cancellation)
        return currentBearer
      },
      fetch: async (url, init) => {
        expect(url).toBe(`${fixture.origin}${DotAccountAuthorityProtocol.path}`)
        expect(init.redirect).toBe('error')
        expect(init.credentials).toBe('omit')
        expect(init.signal?.aborted).toBe(false)
        return globalThis.fetch(url, init)
      },
    })
    expect(await test.readAccessToken(accountId, signal())).toBe(access)
    currentBearer = 'SYNTHETIC_PRIVATE_AUTHORITY_BEARER_ONLY_2'
    currentAccess = 'SYNTHETIC_PRIVATE_UPSTREAM_ACCESS_ONLY_2'
    expect(await test.readAccessToken(accountId, signal())).toBe(currentAccess)
    expect(reads).toHaveLength(2)
    expect(reads.every(cancellation => cancellation.aborted)).toBe(true)
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests.map(request => request.headers.authorization)).toEqual([`Bearer ${purposeBearer}`, `Bearer ${currentBearer}`])
    for (const request of fixture.requests) {
      expect(request.url).toBe(DotAccountAuthorityProtocol.path)
      expect(request.method).toBe('POST')
      expect(request.body).toBe(JSON.stringify({ accountId }))
      expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(2048)
      expect(request.headers.origin).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers['accept-encoding']).toBe('identity')
      expect(request.headers.authorization).not.toContain(currentAccess)
    }
  })

  it('rejects unsafe or noncanonical origins before resolving a key or issuing HTTP', () => {
    const resolveBearerToken = vi.fn(async () => purposeBearer)
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    for (const value of [
      'http://localhost:3000',
      'http://192.168.1.2',
      'http://127.1',
      'http://2130706433',
      'http://0x7f000001',
      'http://127.0.0.2',
      'ftp://127.0.0.1',
      'https://user:PRIVATE_PASSWORD@example.invalid',
      'https://example.invalid/path',
      'https://example.invalid?PRIVATE=x',
      'https://example.invalid#PRIVATE',
      ' https://example.invalid',
      'https://example.invalid\\',
      'https://example.invalid/.',
    ])
      expect(() => createDotAccountAuthorityClient({ origin: value, resolveBearerToken, fetch })).toThrow(BotAdapterError)
    for (const value of ['http://127.0.0.1:3000/', 'http://[::1]:3000', 'https://authority.example.invalid/'])
      client({ origin: value, resolveBearerToken, fetch })
    expect(resolveBearerToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates canonical account input before any credential read', async () => {
    const resolveBearerToken = vi.fn(async () => purposeBearer)
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    const test = client({ resolveBearerToken, fetch })
    for (const value of ['', ' '.repeat(5), 'x'.repeat(65)]) await refused(test.readAccessToken(value, signal()), 'auth-required')
    expect(resolveBearerToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses missing, malformed and failing purpose credentials without requests or leaked causes', async () => {
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    for (const value of [undefined, 'short', 'x'.repeat(513), `${purposeBearer}\r\nPRIVATE_HEADER`]) {
      await refused(client({ resolveBearerToken: async () => value, fetch }).readAccessToken(accountId, signal()), 'auth-required')
    }
    const foreign = new BotAdapterError('auth-required', 'PRIVATE_OWNER_MESSAGE')
    foreign.cause = new Error('PRIVATE_OWNER_CAUSE')
    await refused(
      client({
        resolveBearerToken: async () => {
          throw foreign
        },
        fetch,
      }).readAccessToken(accountId, signal()),
      'auth-required',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts network and foreign same-class errors without retrying', async () => {
    const foreign = new BotAdapterError('auth-required', 'PRIVATE_FETCH_MESSAGE')
    foreign.cause = new Error('PRIVATE_FETCH_CAUSE')
    for (const error of [new Error('PRIVATE_NETWORK_URL_TOKEN'), foreign]) {
      const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => {
        throw error
      })
      await refused(client({ fetch }).readAccessToken(accountId, signal()), error === foreign ? 'auth-required' : 'unavailable')
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('does not follow a real HTTP redirect or retry another route', async () => {
    const fixture = await serverFixture((_request, res) => {
      res.writeHead(302, { location: '/PRIVATE_REDIRECT_TARGET', connection: 'close' })
      res.end('PRIVATE_REDIRECT_BODY')
    })
    await refused(client({ origin: fixture.origin }).readAccessToken(accountId, signal()), 'unavailable')
    expect(fixture.requests).toHaveLength(1)
  })

  it('rejects actual truncated HTTP responses instead of returning a partial access value', async () => {
    const body = JSON.stringify(output())
    const fixture = await serverFixture((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) + 1, connection: 'close' })
      res.end(body)
    })
    await refused(client({ origin: fixture.origin }).readAccessToken(accountId, signal()), 'unavailable')
    expect(fixture.requests).toHaveLength(1)
  })

  it('rejects wrong content type, status, JSON, UTF8, schema, binding and byte-length without exposing payloads', async () => {
    for (const make of [
      () => new Response('PRIVATE_HTML', { headers: { 'content-type': 'text/html' } }),
      () => new Response('PRIVATE_401', { status: 401, headers: { 'content-type': 'application/json' } }),
      () => new Response('PRIVATE_403', { status: 403, headers: { 'content-type': 'application/json' } }),
      () => new Response('PRIVATE_JSON', { headers: { 'content-type': 'application/json' } }),
      () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      () => Response.json({ ...output(), refreshToken: 'PRIVATE_REFRESH' }),
      () => Response.json({ ...output(), version: 2 }),
      () => Response.json({ ...output(), accessToken: 'PRIVATE\nTOKEN' }),
      () => Response.json(output('OTHER_PRIVATE_ACCOUNT')),
      () => new Response(JSON.stringify(output()), { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
      () => new Response(JSON.stringify(output()), { headers: { 'content-type': 'application/json', 'content-length': 'invalid' } }),
      () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    ]) {
      const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => make())
      await refused(client({ fetch }).readAccessToken(accountId, signal()), 'auth-required')
      expect(fetch).toHaveBeenCalledTimes(1)
    }
    for (const status of [201, 302, 500])
      await refused(client({ fetch: async () => new Response('PRIVATE_STATUS', { status }) }).readAccessToken(accountId, signal()), 'unavailable')
  })

  it('refuses an injected redirected response and cancels its body unread', async () => {
    const redirected = new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled++
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-type': 'application/json' } },
    )
    let cancelled = 0
    Object.defineProperty(redirected, 'redirected', { value: true })
    await refused(client({ fetch: async () => redirected }).readAccessToken(accountId, signal()), 'auth-required')
    expect(cancelled).toBe(1)
  })

  it('enforces the declared and actual 64KiB cap, accepts its exact boundary and cancels rejected streams', async () => {
    const exact = JSON.stringify(output()).padEnd(65536, ' ')
    expect(
      await client({ fetch: async () => new Response(exact, { headers: { 'content-type': 'application/json', 'content-length': '65536' } }) }).readAccessToken(
        accountId,
        signal(),
      ),
    ).toBe(access)
    let canceled = 0
    let pulls = 0
    const oversized = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(65537))
          },
          cancel() {
            canceled++
          },
        },
        { highWaterMark: 0 },
      )
    await refused(
      client({ fetch: async () => new Response(oversized(), { headers: { 'content-type': 'application/json', 'content-length': '65537' } }) }).readAccessToken(
        accountId,
        signal(),
      ),
      'auth-required',
    )
    expect(pulls).toBe(0)
    expect(canceled).toBe(1)
    await refused(
      client({ fetch: async () => new Response(oversized(), { headers: { 'content-type': 'application/json' } }) }).readAccessToken(accountId, signal()),
      'auth-required',
    )
    expect(pulls).toBe(1)
    expect(canceled).toBe(2)
  })

  it('aborts with the caller and rejects a late purpose key before fetching', async () => {
    const waiting = deferred<string>()
    const started = deferred<void>()
    const cancellation = new AbortController()
    let observed: AbortSignal | undefined
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    const test = client({
      resolveBearerToken: async bounded => {
        observed = bounded
        started.resolve()
        return waiting.promise
      },
      fetch,
    })
    const result = refused(test.readAccessToken(accountId, cancellation.signal), 'unavailable')
    await started.promise
    cancellation.abort('PRIVATE_ABORT_REASON')
    await result
    waiting.resolve(purposeBearer)
    await Promise.resolve()
    expect(observed?.aborted).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('close interrupts key resolution and rejects subsequent reads without a new key or request', async () => {
    const waiting = deferred<string>()
    const started = deferred<void>()
    const resolveBearerToken = vi.fn(async () => {
      started.resolve()
      return waiting.promise
    })
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    const test = client({ resolveBearerToken, fetch })
    const result = refused(test.readAccessToken(accountId, signal()), 'unavailable')
    await started.promise
    test.close()
    await result
    waiting.resolve(purposeBearer)
    await refused(test.readAccessToken(accountId, signal()), 'unavailable')
    expect(resolveBearerToken).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds an uncooperative key resolver at 15 seconds and aborts its signal', async () => {
    vi.useFakeTimers()
    const waiting = deferred<string>()
    let observed: AbortSignal | undefined
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => response())
    const test = client({
      resolveBearerToken: async bounded => {
        observed = bounded
        return waiting.promise
      },
      fetch,
    })
    const result = refused(test.readAccessToken(accountId, signal()), 'unavailable')
    await vi.advanceTimersByTimeAsync(15000)
    await result
    waiting.resolve(purposeBearer)
    await Promise.resolve()
    expect(observed?.aborted).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds an uncooperative fetch and cancels its late response without reading it', async () => {
    vi.useFakeTimers()
    const waiting = deferred<Response>()
    const started = deferred<void>()
    const canceled = deferred<void>()
    let pulls = 0
    const fetch = vi.fn<NonNullable<DotAccountAuthorityClientOptions['fetch']>>(async () => {
      started.resolve()
      return waiting.promise
    })
    const test = client({ fetch })
    const result = refused(test.readAccessToken(accountId, signal()), 'unavailable')
    await started.promise
    await vi.advanceTimersByTimeAsync(15000)
    await result
    waiting.resolve(
      new Response(
        new ReadableStream(
          {
            pull() {
              pulls++
            },
            cancel() {
              canceled.resolve()
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    )
    await canceled.promise
    expect(pulls).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled response body even when its cancellation promise never settles', async () => {
    vi.useFakeTimers()
    const reading = deferred<void>()
    let cancellations = 0
    const stream = new ReadableStream(
      {
        pull() {
          reading.resolve()
        },
        cancel() {
          cancellations++
          return new Promise<void>(() => undefined)
        },
      },
      { highWaterMark: 0 },
    )
    const test = client({ fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) })
    const result = refused(test.readAccessToken(accountId, signal()), 'unavailable')
    await reading.promise
    await vi.advanceTimersByTimeAsync(15000)
    await result
    expect(cancellations).toBe(1)
  })
})
