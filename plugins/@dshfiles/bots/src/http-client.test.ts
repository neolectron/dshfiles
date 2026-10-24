import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAdapterRegistry, type BotAdapter } from './adapter.js'
import { createBotsHttpClient } from './http-client.js'
import { startBotsNodeService } from './node.js'

const token = 'synthetic-http-client-service-token-only'
const origin = 'http://127.0.0.1:1'
const safeFailure = 'The Bots service request was refused or interrupted. Delivery may be unknown; retry only the original request ID.'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bots-http-client-'))
  const identity = await lstat(root)
  cleanups.push(async () => {
    expect(dirname(root)).toBe(tmpdir())
    expect(basename(root).startsWith('dsh-bots-http-client-')).toBe(true)
    expect(await realpath(root)).toBe(root)
    const current = await lstat(root)
    expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
    await rm(root, { recursive: true, force: true })
  })
  let sends = 0
  const registry = createBotAdapterRegistry()
  const adapter: BotAdapter = {
    info: { id: 'synthetic-client', version: 1, name: 'Synthetic', description: '', risk: 'Synthetic only', fields: [] },
    pollIntervalMs: 1000,
    validateConfig: () => undefined,
    open: async () => ({
      accountId: 'synthetic-account',
      bots: [
        {
          remoteId: 'synthetic-bot',
          name: 'Synthetic',
          description: '',
          nativeUrl: null,
          capabilities: { text: true, attachments: false, approvals: false, activity: false },
          conversations: [{ id: 'conversation', title: 'Synthetic', historyScope: 'since-link', initialCursor: 'baseline' }],
        },
      ],
      poll: async () => ({
        messages: [{ id: 'incoming', requestId: null, author: 'bot', text: 'Synthetic incoming', notice: null, nativeUrl: null, createdAt: 1, updatedAt: 1 }],
        cursor: 'incoming',
        hasMore: false,
      }),
      send: async input => {
        sends++
        return {
          id: `remote-${input.requestId}`,
          requestId: input.requestId,
          author: 'user',
          text: input.text,
          notice: null,
          nativeUrl: null,
          createdAt: 2,
          updatedAt: 2,
        }
      },
      reconcile: async () => ({ kind: 'unknown' }),
      close: async () => undefined,
    }),
  }
  registry.register(adapter)
  const service = await startBotsNodeService({ storageRoot: join(root, 'service'), registry, bearerToken: token })
  cleanups.push(service.close)
  let resolutions = 0
  const client = createBotsHttpClient({
    origin: service.origin,
    resolveBearerToken: async () => {
      resolutions++
      return token
    },
  })
  cleanups.push(client.close)
  return { service, client, counts: () => ({ sends, resolutions }) }
}
const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Bots HTTP service client', () => {
  it('uses real Node HTTP for all nine canonical operations without duplicating workers or sends', async () => {
    const test = await fixture()
    expect((await test.client.snapshot()).bots).toHaveLength(0)
    const connected = await test.client.connect({ adapterId: 'synthetic-client', label: 'Synthetic', config: {}, acceptRisks: true })
    const bot = connected.bots[0]
    const connection = connected.connections[0]
    if (bot === undefined || connection === undefined) throw new Error('Synthetic identity missing')
    const conversation = { botId: bot.id, conversationId: 'conversation', limit: 50 }
    await expect.poll(async () => (await test.client.messages(conversation)).messages.some(message => message.text === 'Synthetic incoming')).toBe(true)
    const send = { botId: bot.id, conversationId: 'conversation', requestId: randomUUID(), text: 'Synthetic outbound' }
    const first = await test.client.send(send)
    expect((await test.client.send(send)).id).toBe(first.id)
    expect(test.counts().sends).toBe(1)
    await expect(test.client.send({ ...send, text: 'Changed body' })).rejects.toThrow(safeFailure)
    await test.client.markRead({ botId: bot.id, conversationId: 'conversation', throughMessageId: first.id })
    await expect(test.client.setCredentialManagement({ connectionId: connection.id, enabled: true })).rejects.toThrow(safeFailure)
    expect((await test.client.setCredentialManagement({ connectionId: connection.id, enabled: false })).connections[0]?.credentialManagement).toBe(false)
    // @ts-expect-error An untrusted JavaScript caller cannot bypass the canonical confirmation literal.
    await expect(test.client.remove({ connectionId: connection.id, confirm: false })).rejects.toThrow(safeFailure)
    await test.client.disconnect({ connectionId: connection.id })
    await test.client.reconnect({ connectionId: connection.id })
    expect((await test.client.remove({ connectionId: connection.id, confirm: true })).connections).toHaveLength(0)
    expect(test.counts().resolutions).toBeGreaterThan(10)
  })

  it('does not resend when a real accepted send loses its HTTP response', async () => {
    const test = await fixture()
    const connected = await test.client.connect({ adapterId: 'synthetic-client', label: 'Synthetic', config: {}, acceptRisks: true })
    const bot = connected.bots[0]
    if (bot === undefined) throw new Error('Synthetic identity missing')
    let loseResponse = true
    const client = createBotsHttpClient({
      origin: test.service.origin,
      resolveBearerToken: async () => token,
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init)
        if (loseResponse && input === `${test.service.origin}/v1/send`) {
          loseResponse = false
          await response.body?.cancel()
          throw new Error('PRIVATE_SYNTHETIC_LOST_RESPONSE')
        }
        return response
      },
    })
    cleanups.push(client.close)
    const input = { botId: bot.id, conversationId: 'conversation', requestId: randomUUID(), text: 'Synthetic response loss' }
    await expect(client.send(input)).rejects.toThrow(safeFailure)
    expect(test.counts().sends).toBe(1)
    expect((await client.send(input)).delivery).toBe('sent')
    expect(test.counts().sends).toBe(1)
  })

  it('validates origins before resolving credentials and rejects nonliteral HTTP or URL metadata', async () => {
    const resolveBearerToken = vi.fn(async () => token)
    for (const value of [
      'http://localhost:3000',
      'http://192.168.1.1',
      'http://2130706433',
      'http://127.1',
      'http://0x7f000001',
      'ftp://127.0.0.1',
      'https://user:pass@example.invalid',
      'https://example.invalid/path',
      'https://example.invalid?token=x',
      'https://example.invalid#x',
      ' https://example.invalid',
      'https://example.invalid\\',
    ]) {
      expect(() => createBotsHttpClient({ origin: value, resolveBearerToken })).toThrow('root HTTPS origin')
    }
    for (const value of ['http://127.0.0.1:3000/', 'http://[::1]:3000', 'https://service.example.invalid:443/']) {
      const client = createBotsHttpClient({ origin: value, resolveBearerToken })
      await client.close()
    }
    expect(resolveBearerToken).not.toHaveBeenCalled()
  })

  it('validates input and the 64KiB encoded request before credentials or network', async () => {
    const resolveBearerToken = vi.fn(async () => token)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createBotsHttpClient({ origin, resolveBearerToken, fetch })
    cleanups.push(client.close)
    await expect(client.send({ botId: 'synthetic', conversationId: 'conversation', text: 'Synthetic', requestId: 'not-a-uuid' })).rejects.toThrow(safeFailure)
    const config = Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`field-${index}`, 'x'.repeat(4000)]))
    await expect(client.connect({ adapterId: 'synthetic', label: 'Synthetic', config, acceptRisks: true })).rejects.toThrow(safeFailure)
    expect(resolveBearerToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts resolver, credential format and transport failures without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('PRIVATE_FETCH_PAYLOAD')
    })
    for (const resolveBearerToken of [
      async () => {
        throw new Error('PRIVATE_RESOLVER_PAYLOAD')
      },
      async () => 'short',
      async () => token,
    ]) {
      const client = createBotsHttpClient({ origin, resolveBearerToken, fetch })
      cleanups.push(client.close)
      await expect(client.snapshot()).rejects.toThrow(safeFailure)
    }
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects, status bodies, malformed JSON, invalid UTF8 and output shape without exposing raw data', async () => {
    const responses = [
      new Response('PRIVATE_STATUS_BODY', { status: 401, headers: { 'content-type': 'application/json' } }),
      new Response('PRIVATE_REDIRECT_BODY', { status: 302, headers: { location: 'https://untrusted.invalid', 'content-type': 'application/json' } }),
      new Response('PRIVATE_INVALID_JSON', { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'text/plain' } }),
      new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    ]
    for (const response of responses) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        expect(init?.redirect).toBe('error')
        return response
      })
      const client = createBotsHttpClient({ origin, resolveBearerToken: async () => token, fetch })
      cleanups.push(client.close)
      await expect(client.snapshot()).rejects.toThrow(safeFailure)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('caps declared and streamed response bytes at 8MiB and cancels oversized streams', async () => {
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index++) controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        cancelled++
      },
    })
    for (const response of [
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }),
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
    ]) {
      const client = createBotsHttpClient({ origin, resolveBearerToken: async () => token, fetch: async () => response })
      cleanups.push(client.close)
      await expect(client.snapshot()).rejects.toThrow(safeFailure)
    }
    expect(cancelled).toBe(1)
  })

  it('resolves a fresh token each request and never resolves again after close', async () => {
    let resolutions = 0
    const resolveBearerToken = async () => {
      resolutions++
      return resolutions === 1 ? token : `${token}-rotated`
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${resolutions === 1 ? token : `${token}-rotated`}`)
      return Response.json({ revision: 1, adapters: [], connections: [], bots: [] })
    })
    const client = createBotsHttpClient({ origin, resolveBearerToken, fetch })
    await client.snapshot()
    await client.snapshot()
    await client.close()
    await expect(client.snapshot()).rejects.toThrow(safeFailure)
    expect(resolutions).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('close aborts an active fetch even when its implementation ignores cancellation', async () => {
    const started = deferred<void>()
    let signal: AbortSignal | null | undefined
    const client = createBotsHttpClient({
      origin,
      resolveBearerToken: async () => token,
      fetch: async (_input, init) => {
        signal = init?.signal
        started.resolve()
        return new Promise(() => undefined)
      },
    })
    const result = expect(client.snapshot()).rejects.toThrow(safeFailure)
    await started.promise
    await client.close()
    await result
    expect(signal?.aborted).toBe(true)
  })

  it('close cancels a pending response body reader', async () => {
    const reading = deferred<void>()
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve()
        },
        cancel() {
          cancelled++
        },
      },
      { highWaterMark: 0 },
    )
    const client = createBotsHttpClient({
      origin,
      resolveBearerToken: async () => token,
      fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    })
    const result = expect(client.snapshot()).rejects.toThrow(safeFailure)
    await reading.promise
    await client.close()
    await result
    expect(cancelled).toBe(1)
  })

  it('bounds a stalled token resolver at 15s and never sends after its late resolution', async () => {
    vi.useFakeTimers()
    const secret = deferred<string>()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createBotsHttpClient({ origin, resolveBearerToken: () => secret.promise, fetch })
    const result = expect(client.snapshot()).rejects.toThrow(safeFailure)
    await vi.advanceTimersByTimeAsync(15000)
    await result
    secret.resolve(token)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    await client.close()
  })
})
