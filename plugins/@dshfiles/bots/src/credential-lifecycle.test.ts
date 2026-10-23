import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import type { BotAdapter, BotAdapterSession, BotCredentialReferencePublisher } from './adapter.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotsEngine } from './engine.js'
import { botsStateSchema, BotsStorage, STORAGE_FAILED, type BotsState } from './store.js'

const previous = { access: 'secret:access', refresh: 'secret:refresh', region: 'fixture' }
const next = { ...previous, access: 'secret:next-access', refresh: 'secret:next-refresh' }
const deferred = () => {
  let resolve = (): void => {
    throw new Error('Not ready')
  }
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const engines: BotsEngine[] = []
const fixture = () => {
  const rows = new Map<string, BotsState>()
  let beforePut = async (_state: BotsState): Promise<void> => undefined
  const table: KvTable<string, BotsState> = {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    put: async (key, value) => {
      await beforePut(value)
      rows.set(key, structuredClone(value))
    },
    delete: async key => rows.delete(key),
    update: async (key, change) => {
      const value = rows.get(key)
      if (!value) throw new Error('Missing fixture')
      const next = change(value)
      await table.put(key, next)
      return next
    },
  }
  const registry = createBotAdapterRegistry()
  const bindings: Parameters<NonNullable<BotAdapterSession['bindCredentialReferences']>>[0][] = []
  const sessions: BotAdapterSession[] = []
  const opens: Parameters<BotAdapter['open']>[0][] = []
  let onBind: NonNullable<BotAdapterSession['bindCredentialReferences']> = async () => undefined
  const adapter: BotAdapter = {
    info: {
      id: 'neutral-managed',
      version: 1,
      name: 'Synthetic managed adapter',
      description: '',
      risk: 'Synthetic',
      credentialManagement: { label: 'Allow synthetic vault saves', description: 'Synthetic capability; no real vault.' },
      fields: [
        { key: 'access', kind: 'secret-reference', label: 'Access', required: true, help: '' },
        { key: 'refresh', kind: 'secret-reference', label: 'Refresh', required: true, help: '' },
        { key: 'region', kind: 'text', label: 'Region', required: true, help: '' },
      ],
    },
    pollIntervalMs: 1000,
    validateConfig: config => {
      if (config.region !== 'fixture') throw new Error('Unsupported synthetic region')
    },
    open: async input => {
      opens.push(input)
      const session: BotAdapterSession = {
        accountId: 'synthetic-account',
        bots: [
          {
            remoteId: 'synthetic-bot',
            name: 'Synthetic',
            description: '',
            nativeUrl: null,
            capabilities: { text: false, activity: false, approvals: false, attachments: false },
            conversations: [{ id: 'synthetic-room', title: 'Room', historyScope: 'since-link', initialCursor: null }],
          },
        ],
        poll: async input => ({ messages: [], hasMore: false, cursor: input.cursor }),
        send: async () => {
          throw new Error('Read-only synthetic adapter')
        },
        reconcile: async () => ({ kind: 'unknown' }),
        bindCredentialReferences: async input => {
          bindings.push(input)
          await onBind(input)
        },
        close: async () => undefined,
      }
      sessions.push(session)
      return session
    },
  }
  const unregister = registry.register(adapter)
  const store = BotsStorage.create(table)
  const engine = new BotsEngine({ store, registry })
  engines.push(engine)
  const connect = (manageCredentials?: boolean) => {
    const input: Parameters<BotsEngine['connect']>[0] = {
      adapterId: adapter.info.id,
      label: 'Synthetic',
      config: previous,
      acceptRisks: true,
    }
    if (manageCredentials !== undefined) input.manageCredentials = manageCredentials
    return engine.connect(input)
  }
  const publisher = (): BotCredentialReferencePublisher => {
    const value = bindings.at(-1)?.publish
    if (!value) throw new Error('No publisher')
    return value
  }
  return {
    adapter,
    store,
    engine,
    rows,
    sessions,
    opens,
    bindings,
    unregister,
    connect,
    publisher,
    onBind: (value: typeof onBind) => {
      onBind = value
    },
    beforePut: (value: typeof beforePut) => {
      beforePut = value
    },
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.close()))
  vi.useRealTimers()
})

describe('managed credential-reference lifecycle', () => {
  it('migrates old persisted rows to manual mode and never binds by default', async () => {
    const f = fixture()
    const connected = await f.connect()
    expect(connected.connections[0]?.credentialManagement).toBe(false)
    expect(f.bindings).toHaveLength(0)
    expect(f.opens[0]?.connectionId).toBe(connected.connections[0]?.id)
    const old = f.store.read()
    const oldConnection = old.connections[0]!.connection
    const { credentialManagement: _grant, ...withoutGrant } = oldConnection
    expect(
      botsStateSchema.parse({ ...old, connections: [{ config: previous, connection: withoutGrant }] }).connections[0]?.connection.credentialManagement,
    ).toBe(false)
  })

  it('requires advertised support and explicit additional acceptance for a grant', async () => {
    const f = fixture()
    const id = (await f.connect()).connections[0]!.id
    await expect(f.engine.setCredentialManagement({ connectionId: id, enabled: true })).rejects.toThrow('explicit additional')
    delete f.adapter.info.credentialManagement
    await expect(f.connect(true)).rejects.toThrow('does not support')
    await expect(f.engine.setCredentialManagement({ connectionId: id, enabled: true, acceptRisks: true })).rejects.toThrow('adapter support')
    expect(f.bindings).toHaveLength(0)
    await expect(f.engine.setCredentialManagement({ connectionId: id, enabled: false })).resolves.toBeDefined()
  })

  it('binds only after durable identity validation and atomically commits both references before connected', async () => {
    const f = fixture()
    const gate = deferred()
    const entered = deferred()
    let settled = false
    f.beforePut(async state => {
      if (state.connections[0]?.config.access === next.access) {
        entered.resolve()
        await gate.promise
      }
    })
    f.onBind(async input => {
      expect(f.rows.get('current')?.connections[0]?.connection.accountId).toBe('synthetic-account')
      expect(f.engine.snapshot().connections[0]?.status).toBe('connecting')
      input.publish.assertActive()
      // Even an adapter forgetting to await its publication cannot acknowledge readiness early.
      void input.publish.replace({ previous, next })
    })
    const connecting = f.connect(true).then(value => {
      settled = true
      return value
    })
    await entered.promise
    expect(f.store.read().connections[0]?.config).toEqual(previous)
    expect(f.engine.snapshot().connections[0]?.status).toBe('connecting')
    expect(settled).toBe(false)
    gate.resolve()
    expect((await connecting).connections[0]?.status).toBe('connected')
    expect(f.rows.get('current')?.connections[0]?.config).toEqual(next)
    expect(f.store.read().connections[0]?.config).toEqual(next)
  })

  it.each([
    ['raw secret', { ...next, access: 'RAW_SYNTHETIC_NEVER_A_SECRET' }],
    ['noncanonical reference', { ...next, access: ' secret:next-access ' }],
    ['non-secret change', { ...next, region: 'different' }],
    ['extra key', { ...next, extra: 'secret:extra' }],
    ['missing key', { access: next.access, region: 'fixture' }],
  ])('rejects %s without changing either reference', async (_label, replacement) => {
    const f = fixture()
    await f.connect(true)
    await expect(f.publisher().replace({ previous, next: replacement })).rejects.toThrow()
    expect(f.store.read().connections[0]?.config).toEqual(previous)
    expect(f.rows.get('current')?.connections[0]?.config).toEqual(previous)
  })

  it('compares expected full maps in serialized storage and safely accepts committed retries', async () => {
    const f = fixture()
    await f.connect(true)
    const publish = f.publisher()
    const other = { ...next, access: 'secret:other-access' }
    const first = publish.replace({ previous, next })
    const stale = publish.replace({ previous, next: other })
    await first
    await expect(stale).rejects.toThrow('changed before')
    await expect(publish.replace({ previous, next })).resolves.toBeUndefined()
    expect(f.store.read().connections[0]?.config).toEqual(next)
    await expect(publish.replace({ previous: { ...previous, region: 'changed' }, next })).rejects.toThrow('non-secret')
  })

  it.each(['revoke', 'disconnect', 'remove', 'unregister', 'close', 'account-mismatch'] as const)('rejects old publishers after %s', async operation => {
    const f = fixture()
    const id = (await f.connect(true)).connections[0]!.id
    const binding = f.bindings[0]!
    if (operation === 'revoke') await f.engine.setCredentialManagement({ connectionId: id, enabled: false })
    if (operation === 'disconnect') await f.engine.disconnect({ connectionId: id })
    if (operation === 'remove') await f.engine.remove({ connectionId: id, confirm: true })
    if (operation === 'unregister') f.unregister()
    if (operation === 'close') await f.engine.close()
    if (operation === 'account-mismatch') Object.defineProperty(f.sessions[0], 'accountId', { value: 'different-account' })
    expect(() => binding.publish.assertActive()).toThrow()
    await expect(binding.publish.replace({ previous, next })).rejects.toThrow()
    if (operation !== 'remove') expect(f.store.read().connections[0]?.config).toEqual(previous)
    if (operation !== 'account-mismatch') expect(binding.signal.aborted).toBe(true)
  })

  it('rejects queued stale writes but acknowledges an already accepted durable commit despite cancellation', async () => {
    const f = fixture()
    const id = (await f.connect(true)).connections[0]!.id
    const entered = deferred()
    const gate = deferred()
    f.beforePut(async state => {
      if (state.connections[0]?.config.access === next.access) {
        entered.resolve()
        await gate.promise
      }
    })
    const publish = f.publisher()
    const committed = publish.replace({ previous, next })
    await entered.promise
    const queued = publish.replace({ previous: next, next: { ...next, access: 'secret:stale' } })
    const disconnected = f.engine.disconnect({ connectionId: id })
    gate.resolve()
    await expect(committed).resolves.toBeUndefined()
    await expect(queued).rejects.toThrow('cancelled')
    await disconnected
    expect(f.store.read().connections[0]?.config).toEqual(next)
  })

  it('revokes without deleting data or reconnecting a disabled connection; enabling rebinds only enabled connections', async () => {
    const f = fixture()
    const id = (await f.connect(true)).connections[0]!.id
    const old = f.publisher()
    await f.engine.setCredentialManagement({ connectionId: id, enabled: false })
    expect(f.opens).toHaveLength(2)
    expect(f.bindings).toHaveLength(1)
    expect(() => old.assertActive()).toThrow()
    expect(f.store.read().connections[0]?.config).toEqual(previous)
    expect(f.store.read().bots).toHaveLength(1)
    await f.engine.disconnect({ connectionId: id })
    await f.engine.setCredentialManagement({ connectionId: id, enabled: true, acceptRisks: true })
    await f.engine.setCredentialManagement({ connectionId: id, enabled: false })
    expect(f.opens).toHaveLength(2)
    expect(f.engine.snapshot().connections[0]?.enabled).toBe(false)
    await f.engine.reconnect({ connectionId: id })
    await f.engine.setCredentialManagement({ connectionId: id, enabled: true, acceptRisks: true })
    expect(f.bindings).toHaveLength(2)
  })

  it('does not bind when persisted account, bot or room continuity changes', async () => {
    for (const boundary of ['account', 'bot', 'room']) {
      const f = fixture()
      const id = (await f.connect(true)).connections[0]!.id
      await f.store.change(state => {
        if (boundary === 'account') state.connections[0]!.connection.accountId = 'different-account'
        if (boundary === 'bot') state.bots[0]!.identity.remoteId = 'different-bot'
        if (boundary === 'room') state.bots[0]!.conversations[0]!.id = 'different-room'
      })
      expect((await f.engine.reconnect({ connectionId: id })).connections[0]?.status).toBe('error')
      expect(f.bindings).toHaveLength(1)
    }
  })

  it('fails closed on storage failure and never exposes submitted values', async () => {
    const f = fixture()
    await f.connect(true)
    f.beforePut(async () => {
      throw new Error('SYNTHETIC_PRIVATE_BACKEND_BODY')
    })
    await expect(f.publisher().replace({ previous, next })).rejects.toThrow(STORAGE_FAILED)
    expect(f.store.read().connections[0]?.config).toEqual(previous)
    expect(() => f.publisher().assertActive()).toThrow()
    expect(f.engine.snapshot().connections[0]?.error).toBe(STORAGE_FAILED)
  })

  it('cancels a pending binding on disconnect and never publishes its late result', async () => {
    const f = fixture()
    const entered = deferred()
    const gate = deferred()
    let late: Promise<void> | undefined
    f.onBind(async ({ publish }) => {
      entered.resolve()
      await gate.promise
      late = publish.replace({ previous, next })
      await late.catch(() => undefined)
    })
    const connecting = f.connect(true)
    await entered.promise
    const id = f.engine.snapshot().connections[0]!.id
    await f.engine.disconnect({ connectionId: id })
    expect((await connecting).connections[0]?.status).toBe('disconnected')
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(late).rejects.toThrow('cancelled')
    expect(f.store.read().connections[0]?.config).toEqual(previous)
  })

  it('does not mark a granted connection connected when its session lacks binding support', async () => {
    const f = fixture()
    const open = f.adapter.open
    f.adapter.open = async input => {
      const session = await open(input)
      delete session.bindCredentialReferences
      return session
    }
    const connected = await f.connect(true)
    expect(connected.connections[0]?.status).toBe('error')
    expect(connected.connections[0]?.error).toContain('does not support')
    expect(f.bindings).toHaveLength(0)
  })

  it('validates replacement configuration inside the serialized mutation', async () => {
    const f = fixture()
    await f.connect(true)
    const entered = deferred()
    const gate = deferred()
    f.beforePut(async () => {
      entered.resolve()
      await gate.promise
    })
    const blocking = f.store.change(() => undefined)
    await entered.promise
    const replacement = f.publisher().replace({ previous, next })
    const validate = vi.fn(() => {
      throw new Error('SYNTHETIC_VALIDATOR_PRIVATE_BODY')
    })
    f.adapter.validateConfig = validate
    gate.resolve()
    await blocking
    await expect(replacement).rejects.toThrow('could not be completed')
    expect(validate).toHaveBeenCalled()
    expect(f.store.read().connections[0]?.config).toEqual(previous)
  })
})
