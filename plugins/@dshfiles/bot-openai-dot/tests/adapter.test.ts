// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError, createBotAdapterRegistry, type BotSendInput } from '@dshfiles/bots/adapter'
import { botsApi } from '@dshfiles/bots/api'
import { startBotsNodeService } from '@dshfiles/bots/node'
import { createDotAdapter } from '../src/adapter.js'
import { DotHttp, segment, type HttpFetch } from '../src/http.js'
import { DotCharacterPolicy, identifier, primarySchema } from '../src/protocol.js'

const checkpointAfterSchema = z.object({ after: z.string().min(1).max(300) })
const now = 1_800_000_000_000
const time = (n = 0) => new Date(now + n * 1000).toISOString()
const jwt = (overrides: Record<string, string> = {}, expiry = now / 1000 + 3600) =>
  `synthetic.${Buffer.from(JSON.stringify({ exp: expiry, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture', chatgpt_user_id: 'human-fixture', chatgpt_account_user_id: 'workspace-human-fixture', ...overrides } })).toString('base64url')}.not-a-signature`
const token = jwt()
const sessionToken = 'SYNTHETIC_SESSION_NEVER_REAL'
const config = { accessTokenRef: 'secret:DOT_ACCESS@prod', sessionTokenRef: 'secret:DOT_SESSION' }
const signal = () => new AbortController().signal
const primary = { selection: { thread_id: 'thread-fixture', aeon_id: 'dot-fixture', messaging_room_id: 'room-fixture', available: true } }
const profile = { status: 'active', id: 'dot-fixture', messaging_room_id: 'room-fixture', display_name: 'Fixture Dot', active_root_thread_id: 'thread-fixture' }
const room = {
  id: 'room-fixture',
  aeon_id: 'dot-fixture',
  type: 'DM',
  app_source: 'chatgpt:messaging',
  members: [{ account_user_id: 'bot-member-fixture', aeon_id: 'dot-fixture' }, { account_user_id: 'workspace-human-fixture' }],
  latest_messages: [{ id: 'baseline-fixture', created_at: time() }],
}
const message = (id = 'message-fixture', author = 'bot-member-fixture', n = 1) => ({
  id,
  account_user_id: author,
  created_at: time(n),
  updated_at: time(n),
  content: { text: 'Hello fixture' },
})
const request = (): BotSendInput => ({
  remoteBotId: 'dot-fixture',
  conversationId: 'room-fixture',
  requestId: 'c331b341-fce1-4a52-bd77-d14e8a7f0841',
  initialCursor: 'original-baseline',
  text: 'Hello fixture',
  signal: signal(),
})
// Deliberately unknown: malformed provider fixtures must reach the real zod I/O decoder unchanged.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
interface Call {
  url: URL
  init: RequestInit
}
type Handler = (call: Call) => Response | Promise<Response> | undefined
function harness(handler?: Handler, accessToken = token) {
  const calls: Call[] = []
  const resolved: string[] = []
  const fetcher: HttpFetch = async (url, init) => {
    const call = { url: new URL(url), init }
    calls.push(call)
    const custom = await handler?.(call)
    if (custom) return custom
    switch (call.url.pathname) {
      case '/backend-api/tbo/primary':
        return json(primary)
      case '/backend-api/tbo/by-thread/thread-fixture':
        return json(profile)
      case '/backend-api/messaging/rooms/room-fixture':
        return json(room)
      case '/backend-api/messaging/rooms/room-fixture/messages':
        if (init.method === 'POST') return json({ ...message('sent-fixture', 'workspace-human-fixture'), request_id: request().requestId })
        return json({ items: [], next_cursor: '' })
      default:
        throw new Error('Unexpected fixture route')
    }
  }
  const adapter = createDotAdapter({
    now: () => now,
    fetch: fetcher,
    resolveSecret: async reference => {
      resolved.push(reference)
      return reference === 'secret:DOT_ACCESS' ? accessToken : sessionToken
    },
  })
  return { adapter, calls, resolved, open: () => adapter.open({ config, signal: signal() }) }
}

async function safeError(promise: Promise<unknown>, code: string) {
  // Rejection values are untrusted; assertions below prove redaction without assuming Error shape.
  const error: unknown = await promise.then(
    () => null,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(BotAdapterError)
  expect(error).toMatchObject({ code })
  expect(String(error)).not.toContain(token)
  expect(String(error)).not.toContain(sessionToken)
  expect(error).not.toHaveProperty('cause')
}

describe('Dot protocol and identity boundaries', () => {
  it('registers v1 with a neutral registry and honest unsupported capabilities', async () => {
    const h = harness()
    const registry = createBotAdapterRegistry()
    const dispose = registry.register(h.adapter)
    expect(registry.get('openai-dot')).toBe(h.adapter)
    expect(h.adapter.pollIntervalMs).toBe(3000)
    expect(h.adapter.info.risk).toContain('broad ChatGPT account access')
    const session = await h.open()
    expect(session.accountId).toMatch(/^[a-f0-9]{64}$/u)
    expect(session.bots[0]).toMatchObject({
      remoteId: 'dot-fixture',
      capabilities: { text: true, attachments: false, approvals: false, activity: false },
      conversations: [{ id: 'room-fixture', historyScope: 'since-link', initialCursor: 'baseline-fixture' }],
    })
    expect(h.resolved).toEqual(['secret:DOT_ACCESS', 'secret:DOT_SESSION'])
    expect(h.calls.map(call => call.url.pathname)).toEqual([
      '/backend-api/tbo/primary',
      '/backend-api/tbo/by-thread/thread-fixture',
      '/backend-api/messaging/rooms/room-fixture',
    ])
    for (const call of h.calls) {
      expect(call.url.origin).toBe('https://chatgpt.com')
      expect(call.init.redirect).toBe('error')
      expect(call.init.credentials).toBe('omit')
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
      const headers = new Headers(call.init.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('chatgpt-account-id')).toBe('account-fixture')
      expect(headers.get('x-openai-expected-account-id')).toBe('account-fixture')
      expect(headers.has('cookie')).toBe(false)
    }
    expect(JSON.stringify(session.bots)).not.toContain(token)
    await session.close()
    dispose()
    expect(registry.list()).toEqual([])
  })
  it('omits both management capabilities without a credential write port while preserving manual polling', async () => {
    const h = harness()
    expect(h.adapter.info).not.toHaveProperty('credentialManagement')
    const session = await h.open()
    try {
      expect(session).not.toHaveProperty('bindCredentialReferences')
      expect(await session.poll({ remoteBotId: 'dot-fixture', conversationId: 'room-fixture', cursor: 'baseline-fixture', signal: signal() })).toMatchObject({
        messages: [],
        hasMore: false,
      })
      expect(h.resolved).toEqual(['secret:DOT_ACCESS', 'secret:DOT_SESSION'])
    } finally {
      await session.close()
    }
  })
  it('refuses Engine management grants before opening or poisoning a no-store manual worker', async () => {
    const parent = await realpath(tmpdir())
    const root = await mkdtemp(join(parent, 'dot-capability-'))
    const identity = await lstat(root)
    const h = harness()
    const registry = createBotAdapterRegistry()
    registry.register(h.adapter)
    const bearerToken = 'synthetic-no-store-management-service-auth'
    let service: Awaited<ReturnType<typeof startBotsNodeService>> | undefined
    try {
      service = await startBotsNodeService({ storageRoot: join(root, 'service'), registry, bearerToken })
      const origin = service.origin
      const post = (path: string, value: z.infer<ReturnType<typeof z.json>>) =>
        fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(value),
        })
      const snapshot = async (response: Response) => {
        const schema = botsApi.methods.snapshot.output
        if (schema === undefined) throw new Error('Missing canonical snapshot schema')
        const parsed = await schema['~standard'].validate(JsonText.parse(await response.text(), z.json()))
        if (parsed.issues !== undefined) throw new Error('Invalid synthetic snapshot')
        return parsed.value
      }
      const input = { adapterId: h.adapter.info.id, label: 'Synthetic no-store Dot', config, acceptRisks: true }
      expect((await post('/v1/connect', { ...input, manageCredentials: true })).status).toBe(409)
      expect(h.resolved).toEqual([])
      expect(h.calls).toEqual([])
      const connected = await snapshot(await post('/v1/connect', input))
      const connection = connected.connections[0]
      const bot = connected.bots[0]
      if (connection === undefined || bot === undefined) throw new Error('Missing synthetic identity')
      expect(connection).toMatchObject({ status: 'connected', credentialManagement: false })
      expect((await post('/v1/setCredentialManagement', { connectionId: connection.id, enabled: true, acceptRisks: true })).status).toBe(409)
      const stillManual = await snapshot(await fetch(`${origin}/v1/snapshot`, { headers: { authorization: `Bearer ${bearerToken}` } }))
      expect(stillManual.connections[0]).toMatchObject({ id: connection.id, status: 'connected', credentialManagement: false })
      expect(h.resolved).toEqual(['secret:DOT_ACCESS', 'secret:DOT_SESSION'])
      const sent = await post('/v1/send', { botId: bot.id, conversationId: 'room-fixture', requestId: request().requestId, text: request().text })
      expect(sent.status).toBe(200)
      expect(JsonText.parse(await sent.text(), z.json())).toMatchObject({ delivery: 'sent', text: request().text })
    } finally {
      await service?.close()
      expect(dirname(root)).toBe(parent)
      expect(basename(root).startsWith('dot-capability-')).toBe(true)
      expect(await realpath(root)).toBe(root)
      const current = await lstat(root)
      expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    { accessTokenRef: token, sessionTokenRef: 'secret:DOT_SESSION' },
    { accessTokenRef: 'secret:DOT_ACCESS' },
    { ...config, hiddenToken: sessionToken },
  ])('refuses raw, missing or extra credential fields before resolution', async input => {
    const h = harness()
    expect(() => h.adapter.validateConfig(input)).toThrow(BotAdapterError)
    await safeError(h.adapter.open({ config: input, signal: signal() }), 'auth-required')
    expect(h.resolved).toEqual([])
    expect(h.calls).toEqual([])
  })
  it('does not resolve a second credential or contact ChatGPT after linking is canceled', async () => {
    const controller = new AbortController()
    const resolved: string[] = []
    let requests = 0
    const a = createDotAdapter({
      resolveSecret: async reference => {
        resolved.push(reference)
        controller.abort()
        return token
      },
      fetch: async () => {
        requests += 1
        throw new Error('Network must not be reached')
      },
    })
    await safeError(a.open({ config, signal: controller.signal }), 'auth-required')
    expect(resolved).toEqual(['secret:DOT_ACCESS'])
    expect(requests).toBe(0)
  })
  it('redacts resolver failures and rejects malformed JWT before network', async () => {
    const a = createDotAdapter({
      resolveSecret: async () => {
        throw new Error(`${token} ${sessionToken}`)
      },
    })
    await safeError(a.open({ config, signal: signal() }), 'auth-required')
    const h = harness(undefined, 'not-a-jwt')
    await safeError(h.open(), 'auth-required')
    expect(h.calls).toEqual([])
  })
  it.each([
    { ...profile, id: 'other-dot' },
    { ...profile, active_root_thread_id: 'other-thread' },
    { ...profile, status: 'inactive' },
  ])('rejects profile identity mismatch', async body => {
    await safeError(harness(({ url }) => (url.pathname.includes('/by-thread/') ? json(body) : undefined)).open(), 'identity-mismatch')
  })
  it.each([
    { ...room, type: 'GROUP' },
    { ...room, app_source: 'other' },
    { ...room, aeon_id: 'other-dot' },
    { ...room, members: [...room.members, { account_user_id: 'third-human' }] },
    { ...room, members: [{ account_user_id: 'bot-member-fixture', aeon_id: 'dot-fixture' }, { account_user_id: 'other-human' }] },
    { ...room, members: [{ account_user_id: 'same-member', aeon_id: 'dot-fixture' }, { account_user_id: 'same-member' }] },
  ])('rejects wrong DM, source, Dot or account-member mapping', async body => {
    await safeError(harness(({ url }) => (url.pathname === '/backend-api/messaging/rooms/room-fixture' ? json(body) : undefined)).open(), 'identity-mismatch')
  })
  it('falls back to a single latest message baseline, refuses an empty room', async () => {
    const h = harness(({ url }) =>
      url.pathname.endsWith('/room-fixture')
        ? json({ ...room, latest_messages: [] })
        : url.search === '?limit=1'
          ? json({ items: [{ id: 'fallback-baseline', created_at: time() }] })
          : undefined,
    )
    expect((await h.open()).bots[0]?.conversations[0]?.initialCursor).toBe('fallback-baseline')
    await safeError(
      harness(({ url }) => (url.pathname.endsWith('/room-fixture') ? json({ ...room, latest_messages: [] }) : undefined)).open(),
      'protocol-error',
    )
  })
  it('changes the stable reconnect binding if verified room member mapping changes', async () => {
    const original = await harness().open()
    const same = await harness().open()
    const changed = await harness(({ url }) =>
      url.pathname.endsWith('/room-fixture')
        ? json({ ...room, members: [{ account_user_id: 'different-dot-member', aeon_id: 'dot-fixture' }, room.members[1]] })
        : undefined,
    ).open()
    expect(same.accountId).toBe(original.accountId)
    expect(changed.accountId).not.toBe(original.accountId)
  })
  it('rejects unavailable primary selection', async () => {
    await safeError(harness(({ url }) => (url.pathname.endsWith('/primary') ? json({ selection: null }) : undefined)).open(), 'unavailable')
  })
  it('reverifies room membership before send and never POSTs changed identity', async () => {
    let rooms = 0
    const h = harness(({ url }) =>
      url.pathname.endsWith('/room-fixture') && ++rooms > 1
        ? json({ ...room, members: [{ account_user_id: 'changed-dot-member', aeon_id: 'dot-fixture' }, room.members[1]] })
        : undefined,
    )
    const session = await h.open()
    await safeError(session.send(request()), 'identity-mismatch')
    expect(h.calls.some(call => call.init.method === 'POST')).toBe(false)
  })
})

describe('Dot sending and reconciliation', () => {
  it('sends the same UUID in both stable request fields and preserves user authorship', async () => {
    const h = harness()
    const session = await h.open()
    const sent = await session.send(request())
    expect(sent.author).toBe('user')
    expect(sent.requestId).toBe(request().requestId)
    const call = h.calls.at(-1)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.body).toBe(
      JSON.stringify({
        content: { text: 'Hello fixture' },
        request_id: request().requestId,
        idempotency_token: request().requestId,
      }),
    )
  })
  it('refuses unknown bot/room, non-UUID and empty send without POST', async () => {
    const h = harness()
    const session = await h.open()
    await safeError(session.send({ ...request(), conversationId: 'other-room' }), 'identity-mismatch')
    await safeError(session.send({ ...request(), requestId: 'unstable' }), 'protocol-error')
    await safeError(session.send({ ...request(), text: ' ' }), 'protocol-error')
    expect(h.calls.some(call => call.init.method === 'POST')).toBe(false)
  })
  it.each(['throw', 'malformed', 'mismatched-request', 'wrong-author', 'server-error'])(
    'keeps %s send uncertain without leaking causes or retrying POST',
    async scenario => {
      const h = harness(({ init }) => {
        if (init.method !== 'POST') return undefined
        if (scenario === 'throw') throw new Error(`Transport ${token} ${sessionToken}`)
        if (scenario === 'malformed') return json({ secret: token })
        if (scenario === 'server-error') return json({ secret: token }, 500)
        return json({
          ...message('sent', scenario === 'wrong-author' ? 'bot-member-fixture' : 'workspace-human-fixture'),
          request_id: scenario === 'mismatched-request' ? 'different-id' : request().requestId,
        })
      })
      const session = await h.open()
      await safeError(session.send(request()), 'delivery-unknown')
      expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(1)
    },
  )
  it('finds request across bounded history from original persisted baseline (not discovery baseline)', async () => {
    let pages = 0
    const h = harness(({ url }) => {
      if (!url.searchParams.has('after')) return undefined
      pages++
      if (pages === 1) {
        expect(url.searchParams.get('after')).toBe('original-baseline')
        return json({ items: [message('first')], next_cursor: 'page-two' })
      }
      expect(url.searchParams.get('after')).toBe('page-two')
      return json({ items: [{ ...message('found', 'workspace-human-fixture'), request_id: request().requestId }] })
    })
    const session = await h.open()
    expect(await session.reconcile(request())).toMatchObject({ kind: 'found', message: { id: 'found', author: 'user' } })
    expect(pages).toBe(2)
  })
  it('reports absence only after exhaustive scan; missing boundary is unknown', async () => {
    const session = await harness().open()
    expect(await session.reconcile(request())).toEqual({ kind: 'not-found' })
    expect(await session.reconcile({ ...request(), initialCursor: null })).toEqual({ kind: 'unknown' })
  })
  it('reports unknown for incomplete history, repeated cursors and scan budget exhaustion', async () => {
    const looping = await harness(({ url }) =>
      url.searchParams.has('after') ? json({ items: [message('another')], next_cursor: url.searchParams.get('after') }) : undefined,
    ).open()
    expect(await looping.reconcile(request())).toEqual({ kind: 'unknown' })
    let pages = 0
    const endless = await harness(({ url }) =>
      url.searchParams.has('after') ? json({ items: [message(`m-${++pages}`)], next_cursor: `cursor-${pages}` }) : undefined,
    ).open()
    expect(await endless.reconcile(request())).toEqual({ kind: 'unknown' })
    expect(pages).toBe(16)
  })
  it('does not reconcile a bot message or different request text as the user send', async () => {
    const bot = await harness(({ url }) =>
      url.searchParams.has('after') ? json({ items: [{ ...message(), request_id: request().requestId }] }) : undefined,
    ).open()
    expect(await bot.reconcile(request())).toEqual({ kind: 'not-found' })
    const collision = await harness(({ url }) =>
      url.searchParams.has('after')
        ? json({ items: [{ ...message('m', 'workspace-human-fixture'), request_id: request().requestId, content: { text: 'different' } }] })
        : undefined,
    ).open()
    await safeError(collision.reconcile(request()), 'identity-mismatch')
  })
})

describe('Dot incoming messages and pagination', () => {
  it('requests limit=32 and after, normalizes chronological distinct authors with safe unsupported handoff', async () => {
    const h = harness(({ url }) =>
      url.searchParams.has('after')
        ? json({
            items: [
              {
                ...message('bot-rich', 'bot-member-fixture', 2),
                content: { text: 'Bot text', attachments: [{ url: 'https://evil.invalid/private' }], elicitation: { approval: 'execute' } },
              },
              message('human', 'workspace-human-fixture', 1),
            ],
          })
        : undefined,
    )
    const session = await h.open()
    const page = await session.poll({ ...request(), cursor: 'baseline-fixture' })
    expect(h.calls.at(-1)?.url.search).toBe('?limit=32&after=baseline-fixture')
    expect(page.messages.map(m => [m.id, m.author])).toEqual([
      ['human', 'user'],
      ['bot-rich', 'bot'],
    ])
    expect(page).toMatchObject({ cursor: expect.stringMatching(/^dot:v1:/u), hasMore: false })
    expect(page.messages[1]).toMatchObject({ text: 'Bot text', notice: expect.stringContaining('nothing was approved'), nativeUrl: 'https://chatgpt.com/dots' })
    expect(JSON.stringify(page)).not.toContain('evil.invalid')
  })
  it('rejects unknown message authors, malformed payloads and null checkpoints', async () => {
    const unknown = await harness(({ url }) => (url.searchParams.has('after') ? json({ items: [message('unknown', 'intruder')] }) : undefined)).open()
    await safeError(unknown.poll({ ...request(), cursor: 'baseline' }), 'identity-mismatch')
    const malformed = await harness(({ url }) =>
      url.searchParams.has('after') ? json({ items: [{ ...message(), created_at: 'garbage' }] }) : undefined,
    ).open()
    await safeError(malformed.poll({ ...request(), cursor: 'baseline' }), 'protocol-error')
    await safeError(malformed.poll({ ...request(), cursor: null }), 'protocol-error')
  })
  it.each([
    { items: [message('baseline')], next_cursor: 'baseline' },
    { items: [], next_cursor: 'new-cursor' },
    { items: [message('duplicate'), message('duplicate')] },
  ])('rejects pagination that cannot safely advance', async body => {
    const session = await harness(({ url }) => (url.searchParams.has('after') ? json(body) : undefined)).open()
    await safeError(session.poll({ ...request(), cursor: 'baseline' }), 'protocol-error')
  })
  it('uses provider next_cursor and treats full pages as potentially incomplete', async () => {
    const session = await harness(({ url }) =>
      url.searchParams.has('after')
        ? json({ items: Array.from({ length: 32 }, (_, i) => message(`m-${i}`, 'bot-member-fixture', i + 1)), next_cursor: 'opaque-cursor' })
        : undefined,
    ).open()
    const result = await session.poll({ ...request(), cursor: 'baseline' })
    expect(result.hasMore).toBe(true)
    if (!result.cursor) throw new Error('Expected encoded cursor')
    expect(JsonText.parse(Buffer.from(result.cursor.slice('dot:v1:'.length), 'base64url').toString('utf8'), checkpointAfterSchema)).toMatchObject({
      after: 'opaque-cursor',
    })
  })
})

describe('Dot bounded recent reconciliation', () => {
  it('rejects cross-page cursor cycles and chronology regressions without publishing a checkpoint', async () => {
    let reads = 0
    const cyclic = harness(({ url }) => {
      if (!url.searchParams.has('after')) return undefined
      if (++reads === 1) return json({ items: [message('m1')], next_cursor: 'next-page' })
      return json({ items: [message('m2', 'bot-member-fixture', 2)], next_cursor: 'original-baseline' })
    })
    const session = await cyclic.open()
    const first = await session.poll({ ...request(), cursor: 'original-baseline' })
    await safeError(session.poll({ ...request(), cursor: first.cursor }), 'protocol-error')
    let pages = 0
    const regressing = await harness(({ url }) =>
      url.searchParams.has('after') ? json({ items: [message(`m-${++pages}`, 'bot-member-fixture', pages === 1 ? 10 : 1)] }) : undefined,
    ).open()
    const latest = await regressing.poll({ ...request(), cursor: 'baseline-fixture' })
    await safeError(regressing.poll({ ...request(), cursor: latest.cursor }), 'protocol-error')
  })

  it('replays edited and deleted recently-seen stable IDs with deletion time and bounded overlap', async () => {
    let reads = 0
    const h = harness(({ url }) => {
      if (!url.searchParams.has('after')) return undefined
      if (url.searchParams.get('after') === 'recent-last') return json({ items: [] })
      reads++
      const original = [message('recent-edit', 'bot-member-fixture', 1), message('recent-last', 'workspace-human-fixture', 2)]
      return json({
        items:
          reads === 1
            ? original
            : [
                { ...original[0], updated_at: time(4), content: { text: 'Edited in native ChatGPT' } },
                { ...original[1], deleted_at: time(5) },
              ],
      })
    })
    const session = await h.open()
    const first = await session.poll({ ...request(), cursor: 'baseline-fixture' })
    const second = await session.poll({ ...request(), cursor: first.cursor })
    expect(second.messages.map(m => m.id)).toEqual(first.messages.map(m => m.id))
    expect(second.messages[0]).toMatchObject({ text: 'Edited in native ChatGPT', updatedAt: now + 4000 })
    expect(second.messages[1]).toMatchObject({ text: '', notice: 'This message was deleted in ChatGPT.', updatedAt: now + 5000 })
    expect(h.calls.filter(call => call.url.searchParams.has('after'))).toHaveLength(3)
    expect(second.hasMore).toBe(false)
    expect(second.cursor).toBe(first.cursor)
  })
  it('deduplicates overlap with fresh messages and advances only by the fresh page', async () => {
    let polls = 0
    const h = harness(({ url }) => {
      if (!url.searchParams.has('after')) return undefined
      if (++polls === 1) return json({ items: [message('m1')] })
      return json({ items: [message('m2', 'bot-member-fixture', 2)], next_cursor: polls === 2 ? '' : 'ignored-overlap-cursor' })
    })
    const session = await h.open()
    const first = await session.poll({ ...request(), cursor: 'baseline-fixture' })
    const second = await session.poll({ ...request(), cursor: first.cursor })
    expect(second.messages.map(m => m.id)).toEqual(['m2'])
    expect(second.hasMore).toBe(false)
    if (!second.cursor) throw new Error('Expected opaque poll cursor')
    expect(JsonText.parse(Buffer.from(second.cursor.slice('dot:v1:'.length), 'base64url').toString('utf8'), checkpointAfterSchema)).toMatchObject({
      after: 'm2',
    })
  })
  it('retains checkpoints when the bounded overlap page fails', async () => {
    let polls = 0
    const h = harness(({ url }) => {
      if (!url.searchParams.has('after')) return undefined
      if (++polls === 1) return json({ items: [message('m1')] })
      if (polls === 2) return json({ items: [message('m2')] })
      return json({ items: [message('intruder', 'unknown-author')] })
    })
    const session = await h.open()
    const first = await session.poll({ ...request(), cursor: 'baseline-fixture' })
    await safeError(session.poll({ ...request(), cursor: first.cursor }), 'identity-mismatch')
  })
})

describe('Dot auth, HTTP and credential confinement', () => {
  it('preserves the explicit ASCII control, space and DEL rejection policy at every token boundary', () => {
    const rejectedCodes = [...Array.from({ length: 33 }, (_, code) => code), 127]
    for (const code of rejectedCodes) {
      const value = `fixture${String.fromCharCode(code)}value`
      expect(DotCharacterPolicy.hasForbiddenAscii(value)).toBe(true)
      expect(identifier.safeParse(value).success).toBe(false)
      expect(() => segment(value)).toThrow(BotAdapterError)
      expect(
        () =>
          new DotHttp(
            { accessToken: token, sessionToken: value },
            async () => json(primary),
            () => now,
          ),
      ).toThrow(BotAdapterError)
    }
    expect(DotCharacterPolicy.hasForbiddenAscii('fixture-id:é')).toBe(false)
    expect(identifier.safeParse('fixture-id:é').success).toBe(true)
    expect(segment('fixture-id:é')).toBe('fixture-id%3A%C3%A9')
  })

  it.each([
    [403, 'access-denied'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [302, 'access-denied'],
  ] as const)('redacts HTTP %i and never follows challenges/redirects', async (status, code) => {
    const h = harness(() => json({ details: `${token} ${sessionToken}` }, status))
    await safeError(h.open(), code)
    expect(h.calls).toHaveLength(1)
  })
  it('refreshes on 401 in memory, applies only session cookie at auth endpoint and reuses stable UUID', async () => {
    let posts = 0
    const renewed = jwt({}, now / 1000 + 7200)
    const h = harness(({ url, init }) => {
      if (url.pathname === '/api/auth/session') {
        expect(new Headers(init.headers).get('cookie')).toBe(`__Secure-next-auth.session-token=${sessionToken}`)
        return json({ accessToken: renewed, sessionToken: 'ROTATED_SYNTHETIC_SESSION' })
      }
      if (init.method === 'POST' && ++posts === 1) return json({}, 401)
      return undefined
    })
    const session = await h.open()
    expect((await session.send(request())).author).toBe('user')
    const posted = h.calls.filter(call => call.init.method === 'POST')
    expect(posted).toHaveLength(2)
    expect(posted[0]?.init.body).toBe(posted[1]?.init.body)
    expect(new Headers(posted[1]?.init.headers).get('authorization')).toBe(`Bearer ${renewed}`)
    expect(h.resolved).toHaveLength(2)
    expect(JSON.stringify(session.bots)).not.toContain('ROTATED_SYNTHETIC_SESSION')
    await session.close()
    await h.open()
    expect(h.resolved).toHaveLength(4)
  })
  it('refreshes expiring credentials before discovery and stops at refresh denial', async () => {
    const h = harness(({ url }) => (url.pathname === '/api/auth/session' ? json({}, 401) : undefined), jwt({}, now / 1000 + 10))
    await safeError(h.open(), 'auth-required')
    expect(h.calls.map(call => call.url.pathname)).toEqual(['/api/auth/session'])
  })
  it.each([{ chatgpt_account_id: 'other-account' }, { chatgpt_user_id: 'other-user' }, { chatgpt_account_user_id: 'other-mapping' }])(
    'rejects identity-changing session refresh',
    async claims => {
      const h = harness(
        ({ url }) => (url.pathname === '/api/auth/session' ? json({ accessToken: jwt(claims), sessionToken: 'ROTATED_SYNTHETIC_SESSION' }) : undefined),
        jwt({}, now / 1000 + 10),
      )
      await safeError(h.open(), 'identity-mismatch')
      expect(h.calls).toHaveLength(1)
    },
  )
  it('rejects expired, malformed and injection-bearing renewed credentials', async () => {
    for (const body of [
      { accessToken: jwt({}, now / 1000 - 1), sessionToken },
      { accessToken: 'bad-jwt', sessionToken },
      { accessToken: token, sessionToken: 'x; malicious-cookie=y' },
      { accessToken: token },
    ]) {
      const h = harness(({ url }) => (url.pathname === '/api/auth/session' ? json(body) : undefined), jwt({}, now / 1000 + 10))
      const failure = await h.open().then(
        () => null,
        (e: unknown) => e,
      )
      expect(failure).toBeInstanceOf(BotAdapterError)
      expect(h.calls).toHaveLength(1)
    }
  })
  it('bounds malformed JSON, advertised length and streaming bodies without exposing payloads', async () => {
    const cases = [
      () => new Response(`not-json ${token} ${sessionToken}`),
      () => new Response('{}', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
              controller.close()
            },
          }),
        ),
      () => json({ selection: { ...primary.selection, messaging_room_id: token } }),
    ]
    for (const body of cases.slice(0, 3)) await safeError(harness(() => body()).open(), 'protocol-error')
  })
  it('confines allowlisted fixed HTTPS endpoints and rejects path traversal before network', async () => {
    const calls: string[] = []
    const http = new DotHttp(
      { accessToken: token, sessionToken },
      async url => {
        calls.push(url)
        return json(primary)
      },
      () => now,
    )
    await safeError(http.api('/other-unscoped-endpoint', primarySchema, signal()), 'protocol-error')
    expect(calls).toEqual([])
    for (const bad of ['..', '.', 'a/b', 'a\\b', 'a\n']) expect(() => segment(bad)).toThrow(BotAdapterError)
  })
  it('cancels an in-flight request through its bounded AbortSignal without leaking transport causes', async () => {
    const controller = new AbortController()
    const http = new DotHttp(
      { accessToken: token, sessionToken },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error(`${token} ${sessionToken}`)), { once: true })
        }),
      () => now,
    )
    const pending = http.api('/tbo/primary', primarySchema, controller.signal)
    controller.abort()
    await safeError(pending, 'unavailable')
    http.close()
  })
  it('aborts a closed connection without calling HTTP and redacts transport errors', async () => {
    const h = harness()
    const session = await h.open()
    const before = h.calls.length
    await session.close()
    await safeError(session.poll({ ...request(), cursor: 'baseline' }), 'unavailable')
    expect(h.calls).toHaveLength(before)
    await safeError(
      harness(() => {
        throw new Error(`${token} ${sessionToken}`)
      }).open(),
      'unavailable',
    )
  })
})
