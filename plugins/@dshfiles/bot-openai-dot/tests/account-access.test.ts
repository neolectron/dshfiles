// SPDX-License-Identifier: AGPL-3.0-only
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAccountAccess, type OpenAIAccountAccessOptions } from '@dshfiles/ai-accounts/openai-account-access'
import { createDotAdapter as createPublicDotAdapter } from '@dshfiles/bot-openai-dot/adapter'
import { BotAdapterError, type BotAdapterErrorCode, type BotSendInput } from '@dshfiles/bots/adapter'
import { createDotAdapter, type DotAccountAccess } from '../src/adapter.js'
import { DotHttp, type HttpFetch } from '../src/http.js'
import { primarySchema } from '../src/protocol.js'

const now = 1_800_000_000_000
const timestamp = (offset = 0) => new Date(now + offset).toISOString()
const token = (options: { exp?: number; account?: string; user?: string; accountUser?: string } = {}) =>
  `synthetic.${Buffer.from(JSON.stringify({ exp: options.exp ?? now / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: options.account ?? 'account', chatgpt_user_id: options.user ?? 'user', chatgpt_account_user_id: options.accountUser ?? 'human' } })).toString('base64url')}.not-a-signature`
const message = (id: string, author = 'dot-member', requestId: string | null = null) => ({
  id,
  account_user_id: author,
  request_id: requestId,
  created_at: timestamp(1000),
  content: { text: 'Synthetic text' },
})
const send = (): BotSendInput => ({
  remoteBotId: 'dot',
  conversationId: 'room',
  initialCursor: 'baseline',
  requestId: 'c331b341-fce1-4a52-bd77-d14e8a7f0841',
  text: 'Synthetic text',
  signal: new AbortController().signal,
})
const json = <Value>(value: Value, status = 200) => Response.json(value, { status })
const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())
const fixture = () => {
  let current = token()
  let posted = false
  let deny: { method: 'GET' | 'POST'; status: 401 | 403 } | undefined
  let reader: DotAccountAccess['readAccessToken'] | undefined
  let intercepted: HttpFetch | undefined
  const reads: Array<{ accountId: string; signal: AbortSignal }> = []
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const accountAccess: DotAccountAccess = {
    readAccessToken: async (accountId, signal) => {
      reads.push({ accountId, signal })
      return reader === undefined ? current : reader(accountId, signal)
    },
  }
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url: new URL(url), init })
    expect(new URL(url).origin).toBe('https://chatgpt.com')
    expect(new Headers(init.headers).has('cookie')).toBe(false)
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    if (intercepted !== undefined) return intercepted(url, init)
    if (deny !== undefined && init.method === deny.method) return new Response('PRIVATE_PROVIDER_PAYLOAD', { status: deny.status })
    switch (new URL(url).pathname) {
      case '/backend-api/tbo/primary':
        return json({ selection: { thread_id: 'thread', aeon_id: 'dot', messaging_room_id: 'room', available: true } })
      case '/backend-api/tbo/by-thread/thread':
        return json({ status: 'active', id: 'dot', messaging_room_id: 'room', active_root_thread_id: 'thread' })
      case '/backend-api/messaging/rooms/room':
        return json({
          id: 'room',
          aeon_id: 'dot',
          type: 'DM',
          app_source: 'chatgpt:messaging',
          members: [{ account_user_id: 'dot-member', aeon_id: 'dot' }, { account_user_id: 'human' }],
          latest_messages: [{ id: 'baseline', created_at: timestamp() }],
        })
      case '/backend-api/messaging/rooms/room/messages':
        if (init.method === 'POST') {
          posted = true
          return json(message('sent', 'human', send().requestId))
        }
        return json({ items: posted ? [message('incoming'), message('sent', 'human', send().requestId)] : [message('incoming')] })
      default:
        throw new Error('Unexpected synthetic provider path')
    }
  }
  const adapter = createDotAdapter({ accountAccess, fetch, now: () => now })
  return {
    adapter,
    accountAccess,
    fetch,
    reads,
    calls,
    open: (signal = new AbortController().signal) => adapter.open({ config: { accountId: 'codex_manuel' }, signal }),
    setToken: (value: string) => {
      current = value
    },
    setReader: (value: DotAccountAccess['readAccessToken']) => {
      reader = value
    },
    intercept: (value: HttpFetch) => {
      intercepted = value
    },
    deny: (method: 'GET' | 'POST', status: 401 | 403) => {
      deny = { method, status }
    },
  }
}
async function refused<Result>(operation: Promise<Result>, code: BotAdapterErrorCode) {
  let rejected = false
  try {
    await operation
  } catch (error) {
    rejected = true
    expect(error).toBeInstanceOf(BotAdapterError)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('PRIVATE_')
    expect(String(error)).not.toContain('synthetic.')
    expect(error).not.toHaveProperty('cause')
  }
  expect(rejected).toBe(true)
}

describe('Dot externally owned account access', () => {
  it('composes the public owner broker and Dot factory without default I/O, cookies or management', async () => {
    type OwnerSource = NonNullable<OpenAIAccountAccessOptions['source']>
    type OwnerAccounts = Awaited<ReturnType<OwnerSource['readAccounts']>>
    const root = join(userInfo().homedir, '.synthetic-public-dot-owner')
    const selected: OwnerAccounts['accounts'][number] = {
      instanceId: 'codex_manuel',
      kind: 'codex',
      displayName: 'Synthetic selected account',
      enabled: true,
      homePath: join(root, 'shared'),
      shadowHomePath: join(root, 'selected'),
      apiKeyEnv: '',
      apiBaseUrl: '',
      badge: '',
      accentColor: '',
      providerIcon: '',
      additionalModelIds: [],
      reasoningDefaults: {},
      hiddenModelIds: [],
      favoriteModelIds: [],
      modelOrder: [],
    }
    let enabled = true
    let ownedToken = token()
    let ownerReads = 0
    let metadataReads = 0
    const source: OwnerSource = {
      readAccounts: async signal => {
        expect(signal.aborted).toBe(false)
        metadataReads++
        return { distribution: 'sticky', cooldownMs: 300000, shadowRoot: join(root, 'implicit'), accounts: [{ ...selected, enabled }] }
      },
      readAccessToken: async (home, signal) => {
        expect(home).toBe(selected.shadowHomePath)
        expect(signal.aborted).toBe(false)
        ownerReads++
        return ownedToken
      },
    }
    const broker = OpenAIAccountAccess.create({ accountId: selected.instanceId, purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    const h = fixture()
    const requestedIds: string[] = []
    const adapter = createPublicDotAdapter({
      accountAccess: {
        readAccessToken: async (accountId, signal) => {
          expect(accountId).toBe(broker.accountId)
          requestedIds.push(accountId)
          return broker.withAccessToken(signal, async access => access)
        },
      },
      fetch: h.fetch,
      now: () => now,
    })
    const open = () => adapter.open({ config: { accountId: broker.accountId }, signal: new AbortController().signal })
    let session: Awaited<ReturnType<typeof adapter.open>> | undefined
    try {
      expect(ownerReads).toBe(0)
      expect(adapter.info).not.toHaveProperty('credentialManagement')
      session = await open()
      expect(session).not.toHaveProperty('bindCredentialReferences')
      expect(
        (await session.poll({ remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: new AbortController().signal })).messages,
      ).toHaveLength(1)
      expect(await session.send(send())).toMatchObject({ author: 'user', requestId: send().requestId })
      expect(broker.accountId).toBe(selected.instanceId)
      expect(requestedIds.every(accountId => accountId === selected.instanceId)).toBe(true)
      expect(h.calls.every(call => !new Headers(call.init.headers).has('cookie'))).toBe(true)
      expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(1)
      const before = h.calls.length
      ownedToken = token({ exp: now / 1000 + 30 }) // Owner's 60-second safety margin refuses before provider I/O.
      await refused(session.poll({ remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: new AbortController().signal }), 'auth-required')
      expect(h.calls).toHaveLength(before)
      ownedToken = token()
      enabled = false
      const beforeDisabled = { ownerReads, providerCalls: h.calls.length }
      await refused(open(), 'auth-required')
      expect({ ownerReads, providerCalls: h.calls.length }).toEqual(beforeDisabled)
      enabled = true
      broker.close()
      const readsBeforeClose = { ownerReads, metadataReads }
      await refused(open(), 'auth-required')
      expect({ ownerReads, metadataReads }).toEqual(readsBeforeClose)
      expect(h.calls).toHaveLength(before)
    } finally {
      await session?.close()
      broker.close()
    }
  })

  it('advertises exactly one account reference and rejects mixed auth/config before credentials or network', async () => {
    const h = fixture()
    expect(h.adapter.info.fields).toEqual([{ key: 'accountId', label: 'DSH OpenAI account ID', kind: 'text', required: true, help: expect.any(String) }])
    expect(h.adapter.info).not.toHaveProperty('credentialManagement')
    for (const config of [
      {},
      { accountId: '' },
      { accountId: 'x'.repeat(65) },
      { accountId: 'codex_manuel', accessTokenRef: 'secret:OTHER' },
      { accessTokenRef: 'secret:ACCESS', sessionTokenRef: 'secret:SESSION' },
    ]) {
      expect(() => h.adapter.validateConfig(config)).toThrow(BotAdapterError)
      await refused(h.adapter.open({ config, signal: new AbortController().signal }), 'auth-required')
    }
    // @ts-expect-error Runtime callers must not mix two credential authorities either.
    expect(() => createDotAdapter({ accountAccess: h.accountAccess, resolveSecret: async () => token() })).toThrow('cannot be combined')
    // @ts-expect-error An externally owned account never receives credential write authority.
    expect(() => createDotAdapter({ accountAccess: h.accountAccess, store: { create: async () => undefined, update: async () => undefined } })).toThrow(
      'cannot be combined',
    )
    expect(h.reads).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('shares discovery, polling, sending and reconciliation with fresh access and no cookie or management', async () => {
    const h = fixture()
    const session = await h.open()
    try {
      expect(session).not.toHaveProperty('bindCredentialReferences')
      expect(h.reads).toHaveLength(4) // Initial binding plus one fresh read per discovery request.
      const poll = { remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: new AbortController().signal }
      expect((await session.poll(poll)).messages).toHaveLength(1)
      expect(await session.send(send())).toMatchObject({ author: 'user', requestId: send().requestId })
      expect(await session.reconcile(send())).toMatchObject({ kind: 'found', message: { id: 'sent' } })
      expect(h.reads.every(read => read.accountId === 'codex_manuel')).toBe(true)
      expect(h.reads).toHaveLength(h.calls.length + 1)
      expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(1)
      expect(h.calls.some(call => call.url.pathname === '/api/auth/session')).toBe(false)
    } finally {
      await session.close()
    }
  })

  it('accepts fresh same-identity token rotation without mutating the owner or reusing the initial bearer', async () => {
    const h = fixture()
    const session = await h.open()
    const rotated = token({ exp: now / 1000 + 7200 })
    h.setToken(rotated)
    const before = h.calls.length
    try {
      await session.poll({ remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: new AbortController().signal })
      for (const call of h.calls.slice(before)) expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${rotated}`)
    } finally {
      await session.close()
    }
  })

  it.each([{ account: 'other' }, { user: 'other' }, { accountUser: 'other' }])('refuses changed identity before another provider request', async identity => {
    const h = fixture()
    const session = await h.open()
    const before = h.calls.length
    h.setToken(token(identity))
    try {
      await refused(session.send(send()), 'identity-mismatch')
      await refused(session.send(send()), 'unavailable')
      expect(h.calls).toHaveLength(before)
    } finally {
      await session.close()
    }
  })

  it.each([token({ exp: now / 1000 - 1 }), 'synthetic.eyJleHAiOiJ1bmtub3duIn0.not-a-signature', 'not-a-jwt'])(
    'requires known unexpired initial access without provider I/O',
    async access => {
      const h = fixture()
      h.setToken(access)
      await refused(h.open(), 'auth-required')
      expect(h.calls).toHaveLength(0)
      expect(h.reads).toHaveLength(1)
    },
  )

  it('never performs legacy cookie renewal even inside its five-minute refresh threshold', async () => {
    const h = fixture()
    h.setToken(token({ exp: now / 1000 + 10 }))
    const session = await h.open()
    try {
      expect(h.calls.some(call => call.url.pathname === '/api/auth/session')).toBe(false)
      expect(h.calls).toHaveLength(3)
    } finally {
      await session.close()
    }
  })

  it('refuses an unavailable or newly expired selected account without another account or provider fallback', async () => {
    for (const expired of [false, true]) {
      const h = fixture()
      const session = await h.open()
      const before = h.calls.length
      if (expired) h.setToken(token({ exp: now / 1000 - 1 }))
      else
        h.setReader(async () => {
          throw new Error('PRIVATE_OWNER_PAYLOAD')
        })
      try {
        await refused(session.send(send()), 'auth-required')
        expect(h.calls).toHaveLength(before)
        expect(h.reads.every(read => read.accountId === 'codex_manuel')).toBe(true)
      } finally {
        await session.close()
      }
    }
  })

  it.each([401, 403] as const)('stops after GET %i without refresh or retry', async status => {
    const h = fixture()
    const session = await h.open()
    const before = h.calls.length
    h.deny('GET', status)
    try {
      await refused(
        session.poll({ remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: new AbortController().signal }),
        status === 401 ? 'auth-required' : 'access-denied',
      )
      await refused(session.send(send()), 'unavailable')
      expect(h.calls).toHaveLength(before + 1)
      expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
    } finally {
      await session.close()
    }
  })

  it.each([401, 403] as const)('never repeats an authorized POST after %i', async status => {
    const h = fixture()
    const session = await h.open()
    h.deny('POST', status)
    try {
      await refused(session.send(send()), status === 401 ? 'auth-required' : 'access-denied')
      await refused(session.send(send()), 'unavailable')
      expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(1)
      expect(h.calls.some(call => call.url.pathname === '/api/auth/session')).toBe(false)
    } finally {
      await session.close()
    }
  })

  it('cancels initial access resolution and rejects its late token before provider I/O', async () => {
    const h = fixture()
    const waiting = deferred<string>()
    const started = deferred<void>()
    h.setReader(async () => {
      started.resolve()
      return waiting.promise
    })
    const controller = new AbortController()
    const result = refused(h.open(controller.signal), 'unavailable')
    await started.promise
    controller.abort()
    await result
    waiting.resolve(token())
    await Promise.resolve()
    expect(h.calls).toHaveLength(0)
    expect(h.reads[0]?.signal.aborted).toBe(true)
  })

  it('close aborts pending per-operation access and prevents its late token from authorizing a request', async () => {
    const h = fixture()
    const session = await h.open()
    const waiting = deferred<string>()
    const started = deferred<void>()
    const before = h.calls.length
    h.setReader(async () => {
      started.resolve()
      return waiting.promise
    })
    const result = refused(session.send(send()), 'unavailable')
    await started.promise
    await session.close()
    await result
    waiting.resolve(token())
    await Promise.resolve()
    expect(h.calls).toHaveLength(before)
    expect(h.reads.at(-1)?.signal.aborted).toBe(true)
  })

  it('close cancels an active external response reader', async () => {
    const h = fixture()
    const http = await DotHttp.openAccount('codex_manuel', h.accountAccess, h.fetch, () => now, new AbortController().signal)
    const reading = deferred<void>()
    const cancellation = deferred<void>()
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve()
        },
        cancel() {
          cancellation.resolve()
        },
      },
      { highWaterMark: 0 },
    )
    h.intercept(async () => new Response(stream))
    const result = refused(http.api('/tbo/primary', primarySchema, new AbortController().signal), 'unavailable')
    await reading.promise
    http.close()
    await result
    await cancellation.promise
    expect(h.calls).toHaveLength(1)
  })

  it('bounds an owner that ignores cancellation at 15s and rejects a late token', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const waiting = deferred<string>()
    h.setReader(async () => waiting.promise)
    const result = refused(h.open(), 'unavailable')
    await vi.advanceTimersByTimeAsync(15000)
    await result
    waiting.resolve(token())
    await Promise.resolve()
    expect(h.calls).toHaveLength(0)
    expect(h.reads[0]?.signal.aborted).toBe(true)
  })

  it('bounds a noncooperative provider fetch and cancels its late response without auth retry', async () => {
    const h = fixture()
    const http = await DotHttp.openAccount('codex_manuel', h.accountAccess, h.fetch, () => now, new AbortController().signal)
    const waiting = deferred<Response>()
    const started = deferred<void>()
    let cancelled = 0
    const cancellation = deferred<void>()
    h.intercept(async () => {
      started.resolve()
      return waiting.promise
    })
    vi.useFakeTimers()
    const result = refused(http.api('/tbo/primary', primarySchema, new AbortController().signal), 'unavailable')
    await started.promise
    await vi.advanceTimersByTimeAsync(15000)
    await result
    waiting.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++
            cancellation.resolve()
          },
        }),
      ),
    )
    await cancellation.promise
    expect(h.calls).toHaveLength(1)
    expect(cancelled).toBe(1)
    http.close()
  })
})
