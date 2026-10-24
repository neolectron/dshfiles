// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BotCredentialReferencePublisher, BotCredentialReferenceUpdate } from '@dshfiles/bots/adapter'
import { DotCredentials, type DotCredentialStore } from '../src/credentials.js'
import { createDotAdapter } from '../src/adapter.js'
import { DotHttp, type HttpFetch } from '../src/http.js'
import { primarySchema } from '../src/protocol.js'

const now = 1_800_000_000_000
const jwt = (exp = now / 1000 + 3600, account = 'account') =>
  `synthetic.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: 'user', chatgpt_account_user_id: 'human' } })).toString('base64url')}.not-a-signature`
const pair = { accessToken: jwt(), sessionToken: 'SYNTHETIC_SESSION' }
const rotated = { accessToken: jwt(now / 1000 + 7200), sessionToken: 'SYNTHETIC_ROTATED' }
const config = { accessTokenRef: 'secret:ACCESS', sessionTokenRef: 'secret:SESSION' }
const connectionId = 'connection-fixture'
const accountId = createHash('sha256')
  .update(JSON.stringify(['account', 'user', 'human', 'human', 'dot-member']))
  .digest('hex')
const fixture = () => {
  const values = new Map<string, string>([
    ['secret:ACCESS', pair.accessToken],
    ['secret:SESSION', pair.sessionToken],
  ])
  const reads: string[] = []
  const creates: { alias: string; value: string }[] = []
  const updates: { alias: string; environment: string; value: string }[] = []
  const publications: BotCredentialReferenceUpdate[] = []
  let active = true
  const controller = new AbortController()
  const resolve = async (reference: string) => {
    reads.push(reference)
    return values.get(reference)
  }
  const store: DotCredentialStore = {
    async create(input) {
      creates.push(input)
      values.set(`secret:${input.alias}`, input.value)
    },
    async update(input) {
      updates.push(input)
      values.set(`secret:${input.alias}`, input.value)
    },
  }
  const publish: BotCredentialReferencePublisher = {
    assertActive() {
      if (!active) throw new Error('SYNTHETIC_PRIVATE_ERROR')
    },
    async replace(update) {
      publications.push(update)
    },
  }
  const make = (refs: Readonly<Record<string, string>> = config, owner: string | undefined = connectionId) =>
    new DotCredentials(refs, owner, resolve, store, controller.signal)
  const bind = (credentials: DotCredentials) => credentials.run(() => credentials.bind({ connectionId, publish, signal: controller.signal }))
  const load = async (credentials: DotCredentials) => {
    await credentials.load(config.accessTokenRef, config.sessionTokenRef)
    credentials.verifyAccount(accountId)
  }
  return {
    values,
    reads,
    creates,
    updates,
    publications,
    controller,
    store,
    publish,
    resolve,
    make,
    bind,
    load,
    revoke: () => {
      active = false
    },
  }
}
const bundleConfig = (h: ReturnType<typeof fixture>) => {
  const next = h.publications[0]?.next
  if (!next?.accessTokenRef || !next.sessionTokenRef) throw new Error('Expected fixture publication')
  return { accessTokenRef: next.accessTokenRef, sessionTokenRef: next.sessionTokenRef }
}
async function migrated(h: ReturnType<typeof fixture>) {
  const credentials = h.make()
  await h.load(credentials)
  await h.bind(credentials)
  return credentials
}
async function safeFailure(operation: Promise<unknown>) {
  const error: unknown = await operation.catch((error: unknown) => error)
  expect(error).toHaveProperty('code')
  expect(String(error)).not.toContain(pair.accessToken)
  expect(String(error)).not.toContain(pair.sessionToken)
  expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ERROR')
  expect(error).not.toHaveProperty('cause')
}

describe('Dot provider-owned scalar credential lifecycle', () => {
  it('defaults to memory-only without bind, even when a store is injected', async () => {
    const h = fixture()
    const credentials = h.make()
    await h.load(credentials)
    await credentials.renewed(rotated)
    expect(h.creates).toEqual([])
    expect(h.updates).toEqual([])
    expect(h.publications).toEqual([])
  })
  it('creates one fresh global bundle and publishes both references in one compare-and-replace request', async () => {
    const h = fixture()
    await migrated(h)
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]?.alias).toMatch(/^DSH_DOT_[a-f0-9_]+$/u)
    expect(h.publications).toHaveLength(1)
    expect(h.publications[0]?.previous).toEqual(config)
    const refs = bundleConfig(h)
    expect(refs.accessTokenRef).toBe(refs.sessionTokenRef)
    expect(h.creates[0]?.value).toContain(`"reference":${JSON.stringify(refs.accessTokenRef)}`)
    expect(JSON.stringify(h.publications)).not.toContain(pair.sessionToken)
    expect(h.values.get(config.accessTokenRef)).toBe(pair.accessToken)
    expect(h.values.get(config.sessionTokenRef)).toBe(pair.sessionToken)
  })
  it('reads a bundle once and renews/restarts on the same single item without another publication', async () => {
    const h = fixture()
    const credentials = await migrated(h)
    const refs = bundleConfig(h)
    await credentials.run(() => credentials.renewed(rotated))
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]?.alias).toBe(h.creates[0]?.alias)
    expect(h.updates[0]?.value).toContain(`"reference":${JSON.stringify(refs.accessTokenRef)}`)
    const restarted = h.make(refs)
    const before = h.reads.length
    expect(await restarted.load(refs.accessTokenRef, refs.sessionTokenRef)).toEqual(rotated)
    expect(h.reads.length - before).toBe(1)
    restarted.verifyAccount(accountId)
    await h.bind(restarted)
    expect(h.creates).toHaveLength(1)
    expect(h.publications).toHaveLength(1)
    await restarted.renewed(pair)
    expect(h.updates).toHaveLength(2)
  })
  it.each(['copied', 'copied-generated-name', 'self-reference-edited'])('refuses managed writes to a %s bundle under a user alias', async scenario => {
    const h = fixture()
    await migrated(h)
    const original = bundleConfig(h)
    const raw = h.values.get(original.accessTokenRef)
    if (!raw) throw new Error('Expected synthetic bundle')
    const reference = scenario === 'copied-generated-name' ? 'secret:DSH_DOT_00000000_0000_4000_8000_000000000000' : 'secret:MY_OLD_USER_ITEM'
    const copiedRaw = scenario === 'self-reference-edited' ? raw.replace(original.accessTokenRef, reference) : raw
    h.values.set(reference, copiedRaw)
    const refs = { accessTokenRef: reference, sessionTokenRef: reference }
    const copied = h.make(refs)
    await copied.load(reference, reference)
    copied.verifyAccount(accountId)
    await safeFailure(h.bind(copied))
    expect(h.creates).toHaveLength(1)
    expect(h.publications).toHaveLength(1)
    expect(h.updates).toEqual([])
    expect(h.values.get(reference)).toBe(copiedRaw)
  })
  it('preserves historical same-ref scalar configuration using one read', async () => {
    const h = fixture()
    const refs = { accessTokenRef: 'secret:ACCESS', sessionTokenRef: 'secret:ACCESS@prod' }
    const credentials = h.make(refs)
    expect(await credentials.load('secret:ACCESS', 'secret:ACCESS')).toEqual({ accessToken: pair.accessToken, sessionToken: pair.accessToken })
    expect(h.reads).toEqual(['secret:ACCESS'])
  })
  it.each(['wrong-owner', 'no-owner', 'malformed', 'wrong-account', 'wrong-binding'])('rejects %s bundle without exposing values', async scenario => {
    const h = fixture()
    await migrated(h)
    const refs = bundleConfig(h)
    const raw = h.values.get(refs.accessTokenRef)
    if (!raw) throw new Error('Expected bundle')
    if (scenario === 'malformed') h.values.set(refs.accessTokenRef, '{"formatVersion":1}')
    if (scenario === 'wrong-account') h.values.set(refs.accessTokenRef, raw.replace('"account":"account"', '"account":"different"'))
    const credentials =
      scenario === 'no-owner'
        ? new DotCredentials(refs, undefined, h.resolve, h.store, h.controller.signal)
        : h.make(refs, scenario === 'wrong-owner' ? 'other' : connectionId)
    if (scenario === 'wrong-binding') {
      await credentials.load(refs.accessTokenRef, refs.sessionTokenRef)
      expect(() => credentials.verifyAccount('a'.repeat(64))).toThrow()
    } else await safeFailure(credentials.load(refs.accessTokenRef, refs.sessionTokenRef))
  })
  it('requires verified identity, matching connection and a store before any managed IO', async () => {
    const h = fixture()
    const unverified = h.make()
    await unverified.load(config.accessTokenRef, config.sessionTokenRef)
    await safeFailure(h.bind(unverified))
    const wrongConnection = h.make()
    await h.load(wrongConnection)
    await safeFailure(wrongConnection.bind({ connectionId: 'other', publish: h.publish, signal: h.controller.signal }))
    const noStore = new DotCredentials(config, connectionId, h.resolve, undefined, h.controller.signal)
    await h.load(noStore)
    await safeFailure(h.bind(noStore))
    expect(h.creates).toEqual([])
    expect(h.publications).toEqual([])
  })
  it('queues the latest discovery rotation until verified bind', async () => {
    const h = fixture()
    const credentials = h.make()
    await credentials.load(config.accessTokenRef, config.sessionTokenRef)
    await credentials.renewed(rotated)
    await credentials.renewed(pair)
    expect(h.creates).toEqual([])
    credentials.verifyAccount(accountId)
    await h.bind(credentials)
    expect(h.creates[0]?.value).toContain(pair.sessionToken)
    expect(h.creates[0]?.value).not.toContain(rotated.sessionToken)
  })
  it.each(['create', 'publication'])('keeps old references and reports an unlinked bundle safely on failed %s', async scenario => {
    const h = fixture()
    const credentials = h.make()
    await h.load(credentials)
    if (scenario === 'create')
      h.store.create = async () => {
        throw new Error(pair.sessionToken)
      }
    else
      h.publish.replace = async () => {
        throw new Error(pair.accessToken)
      }
    await safeFailure(h.bind(credentials))
    expect(h.values.get(config.accessTokenRef)).toBe(pair.accessToken)
    expect(h.values.get(config.sessionTokenRef)).toBe(pair.sessionToken)
    await safeFailure(credentials.renewed(rotated))
    expect(h.updates).toEqual([])
  })
  it('does not roll back an ambiguous publication that was accepted', async () => {
    const h = fixture()
    const credentials = h.make()
    await h.load(credentials)
    h.publish.replace = async update => {
      h.publications.push(update)
      throw new Error('ambiguous')
    }
    await safeFailure(h.bind(credentials))
    expect(h.publications).toHaveLength(1)
    expect(h.creates).toHaveLength(1)
    await safeFailure(h.bind(credentials))
    expect(h.creates).toHaveLength(1)
  })
  it.each(['before-write', 'readback-conflict', 'readback-failure'])('stops safely after %s without a second write', async scenario => {
    const h = fixture()
    const credentials = await migrated(h)
    h.store.update = async input => {
      h.updates.push(input)
      if (scenario === 'readback-failure') h.values.set(`secret:${input.alias}`, '{malformed')
      if (scenario === 'before-write') throw new Error(pair.sessionToken)
    }
    await safeFailure(credentials.renewed(rotated))
    await safeFailure(credentials.renewed(rotated))
    expect(h.updates).toHaveLength(1)
  })
  it('accepts an ambiguous write only when guarded readback proves the exact whole next generation', async () => {
    const h = fixture()
    const credentials = await migrated(h)
    h.store.update = async input => {
      h.updates.push(input)
      h.values.set(`secret:${input.alias}`, input.value)
      throw new Error('accepted-but-lost-ack')
    }
    await credentials.renewed(rotated)
    expect(h.updates).toHaveLength(1)
    await credentials.renewed(pair)
    expect(h.updates).toHaveLength(2)
  })
  it.each(['owner', 'generation'])('checks previous %s before writing and stops on conflict', async field => {
    const h = fixture()
    const credentials = await migrated(h)
    const refs = bundleConfig(h)
    const created = h.creates[0]
    if (!created) throw new Error('Expected created fixture')
    const changed =
      field === 'owner'
        ? created.value.replace(connectionId, 'other-owner')
        : created.value.replace(/"generationId":"[^"]+"/u, '"generationId":"00000000-0000-4000-8000-000000000000"')
    h.values.set(refs.accessTokenRef, changed)
    await safeFailure(credentials.renewed(rotated))
    expect(h.updates).toEqual([])
  })
  it.each(['abort', 'revoke', 'close'])('stops new IO after %s', async scenario => {
    const h = fixture()
    const credentials = await migrated(h)
    const before = h.reads.length
    if (scenario === 'abort') h.controller.abort()
    if (scenario === 'revoke') h.revoke()
    if (scenario === 'close') credentials.close()
    await safeFailure(credentials.run(() => credentials.renewed(rotated)))
    expect(h.reads).toHaveLength(before)
    expect(h.updates).toEqual([])
  })
  it('revocation during accepted create prevents publication but does not pretend to undo the item', async () => {
    const h = fixture()
    const credentials = h.make()
    await h.load(credentials)
    const create = h.store.create
    h.store.create = async input => {
      await create(input)
      h.revoke()
    }
    await safeFailure(h.bind(credentials))
    expect(h.creates).toHaveLength(1)
    expect(h.publications).toEqual([])
  })
  it('revocation during acknowledged update prevents new reads or rollback', async () => {
    const h = fixture()
    const credentials = await migrated(h)
    const update = h.store.update
    h.store.update = async input => {
      await update(input)
      h.revoke()
    }
    await safeFailure(credentials.renewed(rotated))
    expect(h.updates).toHaveLength(1)
    expect(h.values.get(bundleConfig(h).accessTokenRef)).toContain(rotated.sessionToken)
  })
  it('serializes session work, including bind and renewal', async () => {
    const h = fixture()
    const credentials = h.make()
    await h.load(credentials)
    const first = h.bind(credentials)
    const second = credentials.run(() => credentials.renewed(rotated))
    const third = credentials.run(() => credentials.renewed(pair))
    await Promise.all([first, second, third])
    expect(h.creates).toHaveLength(1)
    expect(h.updates).toHaveLength(2)
    expect(h.values.get(bundleConfig(h).accessTokenRef)).toContain(pair.sessionToken)
  })
})

// Provider fixture serialization is the injected HTTP I/O boundary; DotHttp performs the real decoding.
// eslint-disable-next-line antislop/no-unknown-parameters
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function httpFixture(h: ReturnType<typeof fixture>, expiring = false) {
  if (expiring) h.values.set(config.accessTokenRef, jwt(now / 1000 + 10))
  let deny = false
  let refreshes = 0
  let posts = 0
  const fetch: HttpFetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/auth/session') {
      refreshes++
      return response(rotated)
    }
    if (deny) {
      deny = false
      return response({}, 401)
    }
    if (init.method === 'POST') posts++
    if (path.endsWith('/primary')) return response({ selection: { thread_id: 'thread', aeon_id: 'dot', messaging_room_id: 'room', available: true } })
    if (path.includes('/by-thread/')) return response({ status: 'active', id: 'dot', messaging_room_id: 'room', active_root_thread_id: 'thread' })
    if (path.endsWith('/room'))
      return response({
        id: 'room',
        aeon_id: 'dot',
        type: 'DM',
        app_source: 'chatgpt:messaging',
        members: [{ account_user_id: 'dot-member', aeon_id: 'dot' }, { account_user_id: 'human' }],
        latest_messages: [{ id: 'baseline', created_at: new Date(now).toISOString() }],
      })
    return response({ items: [] })
  }
  const adapter = createDotAdapter({ resolveSecret: h.resolve, store: h.store, fetch, now: () => now })
  return {
    adapter,
    deny: () => {
      deny = true
    },
    counts: () => ({ refreshes, posts }),
  }
}
describe('Dot adapter grant and HTTP persistence integration', () => {
  it('offers store-backed management metadata and session binding without writing before an explicit grant', async () => {
    const h = fixture()
    const http = httpFixture(h)
    expect(http.adapter.info.credentialManagement).toBeDefined()
    const session = await http.adapter.open({ config, connectionId, signal: h.controller.signal })
    try {
      expect(session.bindCredentialReferences).toBeTypeOf('function')
      expect(h.creates).toEqual([])
      expect(h.updates).toEqual([])
      expect(h.publications).toEqual([])
    } finally {
      await session.close()
    }
  })
  it('singleflights concurrent HTTP refresh and invokes one whole-pair persistence callback', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let refreshes = 0
    const committed: (typeof pair)[] = []
    const http = new DotHttp(
      { ...pair, accessToken: jwt(now / 1000 + 10) },
      async url => {
        if (new URL(url).pathname === '/api/auth/session') {
          refreshes++
          await gate
          return response(rotated)
        }
        return response({ selection: null })
      },
      () => now,
      {
        assertActive() {},
        async renewed(next) {
          committed.push(next)
        },
      },
    )
    const signal = new AbortController().signal
    const pending = Promise.all([http.api('/tbo/primary', primarySchema, signal), http.api('/tbo/primary', primarySchema, signal)])
    release?.()
    await pending
    expect(refreshes).toBe(1)
    expect(committed).toEqual([rotated])
    http.close()
  })
  it('never publishes discovery renewal before identity verification and explicit Core bind', async () => {
    const h = fixture()
    const http = httpFixture(h, true)
    const session = await http.adapter.open({ config, connectionId, signal: h.controller.signal })
    expect(h.creates).toEqual([])
    expect(h.publications).toEqual([])
    expect(session.accountId).toBe(accountId)
    await session.bindCredentialReferences?.({ connectionId, publish: h.publish, signal: h.controller.signal })
    expect(h.creates[0]?.value).toContain(rotated.sessionToken)
    expect(JSON.stringify(session.bots)).not.toContain(rotated.sessionToken)
    expect(JSON.stringify(http.adapter.info)).not.toContain(pair.accessToken)
  })
  it('renews and restarts through the adapter on the same bundle, while unbound sessions remain write-free', async () => {
    const h = fixture()
    const http = httpFixture(h)
    const session = await http.adapter.open({ config, connectionId, signal: h.controller.signal })
    const poll = { remoteBotId: 'dot', conversationId: 'room', cursor: 'baseline', signal: h.controller.signal }
    http.deny()
    await session.poll(poll)
    expect(h.creates).toEqual([])
    expect(h.updates).toEqual([])
    await session.bindCredentialReferences?.({ connectionId, publish: h.publish, signal: h.controller.signal })
    http.deny()
    await session.poll(poll)
    expect(h.creates).toHaveLength(1)
    expect(h.updates).toHaveLength(1)
    const refs = bundleConfig(h)
    await session.close()
    const reads = h.reads.length
    const restarted = await http.adapter.open({ config: refs, connectionId, signal: h.controller.signal })
    expect(h.reads.length - reads).toBe(1)
    await restarted.bindCredentialReferences?.({ connectionId, publish: h.publish, signal: h.controller.signal })
    expect(h.creates).toHaveLength(1)
    expect(h.updates).toHaveLength(1)
    expect(h.publications).toHaveLength(1)
    await restarted.close()
  })
  it('stops a send before POST and never blindly repeats renewal after a managed write failure', async () => {
    const h = fixture()
    const http = httpFixture(h)
    const session = await http.adapter.open({ config, connectionId, signal: h.controller.signal })
    await session.bindCredentialReferences?.({ connectionId, publish: h.publish, signal: h.controller.signal })
    h.store.update = async () => {
      throw new Error(pair.sessionToken)
    }
    http.deny()
    const send = () =>
      session.send({
        remoteBotId: 'dot',
        conversationId: 'room',
        requestId: 'c331b341-fce1-4a52-bd77-d14e8a7f0841',
        text: 'test',
        initialCursor: 'baseline',
        signal: h.controller.signal,
      })
    await safeFailure(send())
    await safeFailure(send())
    expect(http.counts()).toEqual({ refreshes: 1, posts: 0 })
  })
})
