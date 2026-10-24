import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonText } from '@dshfiles/dshx/api'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createBotAdapterRegistry, type BotAdapter, type BotSendInput } from './adapter.js'
import { botMessageSchema, botsSnapshotSchema } from './contract.js'
import { startBotsServer } from './server.js'
import { botsDomain, BotsStorage } from './store.js'

const token = 'synthetic-service-auth-for-http-boundary-only'
const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bots-http-'))
  resources.push(async () => {
    expect(dirname(root)).toBe(tmpdir())
    expect(basename(root).startsWith('dsh-bots-http-')).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  const ctx = new Context()
  resources.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const registry = createBotAdapterRegistry()
  let opens = 0
  let closes = 0
  let polls = 0
  const sends: BotSendInput[] = []
  let failSend = false
  const adapter: BotAdapter = {
    info: { id: 'synthetic', version: 1, name: 'Synthetic HTTP fixture', description: '', risk: 'Synthetic only', fields: [] },
    pollIntervalMs: 1000,
    validateConfig: () => undefined,
    open: async () => {
      opens++
      return {
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
        poll: async () => {
          polls++
          return {
            messages: [
              { id: 'incoming', requestId: null, author: 'bot', text: 'Synthetic incoming', notice: null, nativeUrl: null, createdAt: 1, updatedAt: 1 },
            ],
            cursor: 'incoming',
            hasMore: false,
          }
        },
        send: async input => {
          sends.push(input)
          if (failSend) throw new Error('PRIVATE_PAYLOAD_SHOULD_NEVER_ESCAPE')
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
        close: async () => {
          closes++
        },
      }
    },
  }
  registry.register(adapter)
  const open = async () => {
    const domain = await ctx.storageDomain.open(botsDomain)
    const store = BotsStorage.create(domain.table('state'))
    const server = await startBotsServer({ store, registry, bearerToken: token })
    const close = async () => {
      await server.close()
      await domain.close()
    }
    resources.push(close)
    return { ...server, close, store }
  }
  const server = await open()
  const call = (path: string, body?: z.infer<ReturnType<typeof z.json>>, init?: RequestInit) => {
    const request: RequestInit = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...init,
    }
    if (body !== undefined && init?.body === undefined) request.body = JSON.stringify(body)
    return fetch(`${server.origin}${path}`, request)
  }
  const connect = async () => {
    const response = await call('/v1/connect', { adapterId: 'synthetic', label: 'Synthetic', config: {}, acceptRisks: true })
    expect(response.status).toBe(200)
    const snapshot = JsonText.parse(await response.text(), botsSnapshotSchema)
    const bot = snapshot.bots[0]
    const connection = snapshot.connections[0]
    if (bot === undefined || connection === undefined) throw new Error('Missing synthetic identity')
    return { botId: bot.id, conversationId: 'conversation', connectionId: connection.id }
  }
  return {
    server,
    open,
    call,
    connect,
    sends,
    registry,
    storeRoot: root,
    counts: () => ({ opens, closes, polls }),
    failSend: () => {
      failSend = true
    },
  }
}
const failureSchema = z
  .object({
    error: z.enum([
      'bad-request',
      'unauthorized',
      'not-found',
      'method-not-allowed',
      'unsupported-media',
      'too-large',
      'refused',
      'internal',
      'timeout',
      'unavailable',
    ]),
  })
  .strict()

describe('Bots standalone real HTTP boundary', () => {
  it('owns a real listener, authenticates before operations and exposes liveness only', async () => {
    const test = await fixture()
    expect(test.server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const health = await fetch(`${test.server.origin}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('{"status":"alive"}')
    for (const authorization of ['', 'Bearer wrong', `Bearer ${token}x`]) {
      const response = await test.call(
        '/v1/connect',
        { adapterId: 'synthetic', config: {}, acceptRisks: true },
        { headers: { authorization, 'content-type': 'application/json' } },
      )
      expect(response.status).toBe(401)
      expect(JsonText.parse(await response.text(), failureSchema)).toEqual({ error: 'unauthorized' })
    }
    expect(test.counts().opens).toBe(0)
    expect(JsonText.parse(await (await test.call('/v1/snapshot')).text(), botsSnapshotSchema).connections).toHaveLength(0)
  })

  it('connects, polls, sends once across retry/reopen and preserves the canonical consent rules', async () => {
    const test = await fixture()
    const identity = await test.connect()
    await expect
      .poll(
        async () => {
          const page = await test.call('/v1/messages', { botId: identity.botId, conversationId: identity.conversationId })
          const messages = JsonText.parse(await page.text(), z.object({ messages: z.array(botMessageSchema), hasMore: z.boolean() }))
          return messages.messages.some(message => message.text === 'Synthetic incoming')
        },
        { timeout: 2000 },
      )
      .toBe(true)
    expect(test.counts().polls).toBeGreaterThan(0)
    const input = { botId: identity.botId, conversationId: identity.conversationId, requestId: randomUUID(), text: 'Synthetic outbound' }
    const first = JsonText.parse(await (await test.call('/v1/send', input)).text(), botMessageSchema)
    expect(first.delivery).toBe('sent')
    expect(JsonText.parse(await (await test.call('/v1/send', input)).text(), botMessageSchema).id).toBe(first.id)
    expect(test.sends).toHaveLength(1)
    const changed = await test.call('/v1/send', { ...input, text: 'Changed body' })
    expect(changed.status).toBe(409)
    expect(await changed.text()).toBe('{"error":"refused"}')
    expect((await test.call('/v1/markRead', { botId: identity.botId, conversationId: identity.conversationId, throughMessageId: first.id })).status).toBe(200)
    expect((await test.call('/v1/remove', { connectionId: identity.connectionId, confirm: false })).status).toBe(400)
    expect((await test.call('/v1/setCredentialManagement', { connectionId: identity.connectionId, enabled: true })).status).toBe(409)
    expect((await test.call('/v1/disconnect', { connectionId: identity.connectionId })).status).toBe(200)
    expect((await test.call('/v1/reconnect', { connectionId: identity.connectionId })).status).toBe(200)
    await test.server.close()
    expect(test.counts().closes).toBe(test.counts().opens)
    const reopened = await test.open()
    const response = await fetch(`${reopened.origin}/v1/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(200)
    expect(JsonText.parse(await response.text(), botMessageSchema).id).toBe(first.id)
    expect(test.sends).toHaveLength(1)
    const removed = await fetch(`${reopened.origin}/v1/remove`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: identity.connectionId, confirm: true }),
    })
    expect(removed.status).toBe(200)
  })

  it('never exposes unexpected provider failure payloads and never automatically repeats an uncertain send', async () => {
    const test = await fixture()
    const identity = await test.connect()
    test.failSend()
    const input = { botId: identity.botId, conversationId: identity.conversationId, requestId: randomUUID(), text: 'Synthetic uncertain outbound' }
    const response = await test.call('/v1/send', input)
    const body = await response.text()
    expect(body).not.toContain('PRIVATE_PAYLOAD')
    const message = JsonText.parse(body, botMessageSchema)
    expect(message.delivery).toBe('uncertain')
    const retry = await test.call('/v1/send', input)
    expect(JsonText.parse(await retry.text(), botMessageSchema).delivery).toBe('uncertain')
    expect(test.sends).toHaveLength(1)
  })

  it('rejects browser origin, query credentials, unsupported transport and malformed bodies', async () => {
    const test = await fixture()
    const cases: Array<{ path: string; init: RequestInit; status: number }> = [
      { path: '/v1/snapshot?token=ignored', init: {}, status: 400 },
      { path: '/healthz', init: { headers: { origin: 'https://untrusted.invalid' } }, status: 400 },
      { path: '/v1/snapshot', init: { method: 'POST' }, status: 405 },
      { path: '/v1/missing', init: {}, status: 404 },
      { path: '/v1/connect', init: { method: 'POST', body: '{' }, status: 400 },
      { path: '/v1/connect', init: { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } }, status: 415 },
      {
        path: '/v1/connect',
        init: { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-encoding': 'gzip' } },
        status: 415,
      },
      { path: '/v1/connect', init: { method: 'POST', body: 'x'.repeat(65537) }, status: 413 },
    ]
    for (const item of cases) {
      const response = await test.call(item.path, undefined, item.init)
      expect(response.status, item.path).toBe(item.status)
      JsonText.parse(await response.text(), failureSchema)
    }
    expect(test.counts().opens).toBe(0)
    const streamed = await new Promise<number>(resolve => {
      const request = httpRequest(
        `${test.server.origin}/v1/connect`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
        response => {
          response.resume()
          response.once('end', () => resolve(response.statusCode ?? 0))
        },
      )
      request.write('x'.repeat(40000))
      request.end('x'.repeat(30000))
    })
    expect(streamed).toBe(413)
  })

  it('bounds an unfinished real HTTP request body without admitting a provider operation', async () => {
    const test = await fixture()
    const started = performance.now()
    const outcome = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${test.server.origin}/v1/connect`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
        response => {
          response.resume()
          response.once('end', () => {
            resolve(response.statusCode ?? 0)
            request.destroy()
          })
        },
      )
      request.once('error', reject)
      request.setTimeout(13000, () => {
        reject(new Error('Synthetic slow-body deadline was not enforced'))
        request.destroy()
      })
      request.write('{')
    })
    expect(outcome).toBe(408)
    expect(performance.now() - started).toBeGreaterThanOrEqual(9000)
    expect(test.counts().opens).toBe(0)
  }, 15000)

  it('rejects weak service configuration and isolates independent engines', async () => {
    const first = await fixture()
    const second = await fixture()
    await first.connect()
    const snapshot = JsonText.parse(await (await second.call('/v1/snapshot')).text(), botsSnapshotSchema)
    expect(snapshot.connections).toHaveLength(0)
    for (const bearerToken of ['short', ' '.repeat(32), '\n'.repeat(32), 'é'.repeat(32)]) {
      const revision = second.server.store.read().revision
      await expect(startBotsServer({ store: second.server.store, registry: first.registry, bearerToken })).rejects.toThrow('service token')
      expect(second.server.store.read().revision).toBe(revision)
    }
    for (const port of [-1, 65536, 1.5, Number.NaN]) {
      const revision = second.server.store.read().revision
      await expect(startBotsServer({ store: second.server.store, registry: first.registry, bearerToken: token, port })).rejects.toThrow('listen configuration')
      expect(second.server.store.read().revision).toBe(revision)
    }
  })
})
