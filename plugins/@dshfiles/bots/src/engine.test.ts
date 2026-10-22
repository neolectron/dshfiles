import { randomUUID } from 'node:crypto'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { BotAdapterError, createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterMessage, BotAdapter, BotAdapterSession, BotPollInput, BotSendInput } from './adapter.js'
import type { BotIdentity } from './contract.js'
import { BotsEngine } from './engine.js'
import { createBotsStore, MAX_MESSAGES_PER_CONVERSATION, STORAGE_FAILED, type BotsState } from './store.js'

const identity = (): BotIdentity => ({
  remoteId: 'remote-bot', name: 'Fixture bot', description: '', nativeUrl: null,
  capabilities: { text: true, attachments: false, approvals: false, activity: false },
  conversations: [{ id: 'conversation', title: 'Fixture conversation', historyScope: 'since-link', initialCursor: 'original-link' }],
})
const remote = (id: string, text = 'hello'): AdapterMessage => ({ id, text, author: 'bot', requestId: null, notice: null, nativeUrl: null, createdAt: 1, updatedAt: 1 })
const echo = (input: BotSendInput): AdapterMessage => ({ ...remote(`remote-${input.requestId}`, input.text), requestId: input.requestId, author: 'user' })
const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => { throw new Error('Deferred not ready') }
  const promise = new Promise<Value>(done => { resolve = done })
  return { promise, resolve }
}

/** A minimal second implementation: the engine knows no provider vocabulary and never resolves a credential itself. */
class FakeAdapter implements BotAdapter {
  readonly info = {
    id: 'fixture', version: 1 as const, name: 'Fixture', description: 'Test implementation', risk: 'Fixture only',
    fields: [{ key: 'credential', label: 'Credential reference', kind: 'secret-reference' as const, required: true, help: '' }],
  }
  readonly pollIntervalMs = 1000
  accountId = 'fixture-account'
  bots = [identity()]
  opens = 0
  closes = 0
  configs: Readonly<Record<string, string>>[] = []
  sends: BotSendInput[] = []
  polls: BotPollInput[] = []
  reconciles: BotSendInput[] = []
  onSend: (input: BotSendInput) => Promise<AdapterMessage> = async input => echo(input)
  onPoll: (input: BotPollInput) => ReturnType<BotAdapterSession['poll']> = async input => ({ messages: [], cursor: input.cursor, hasMore: false })
  onReconcile: (input: BotSendInput) => ReturnType<BotAdapterSession['reconcile']> = async () => ({ kind: 'unknown' })
  validateConfig(config: Readonly<Record<string, string>>): void {
    if (!config.credential?.startsWith('secret:')) throw new Error('Fixture received invalid config')
  }
  async open(input: Parameters<BotAdapter['open']>[0]): Promise<BotAdapterSession> {
    this.opens++
    this.configs.push(input.config)
    return {
      accountId: this.accountId, bots: structuredClone(this.bots),
      send: async input => { this.sends.push(input); return this.onSend(input) },
      poll: async input => { this.polls.push(input); return this.onPoll(input) },
      reconcile: async input => { this.reconciles.push(input); return this.onReconcile(input) },
      close: async () => { this.closes++ },
    }
  }
}

const memory = () => {
  const rows = new Map<string, BotsState>()
  let beforePut: (value: BotsState) => Promise<void> = async () => undefined
  const table: KvTable<string, BotsState> = {
    get: key => { const value = rows.get(key); return value === undefined ? undefined : structuredClone(value) },
    entries: () => rows.entries(), keys: () => rows.keys(), get size() { return rows.size },
    put: async (key, value) => { await beforePut(value); rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
    update: async (key, change) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('Missing fixture state')
      const next = change(structuredClone(current)); await table.put(key, next); return next
    },
  }
  return { rows, table, beforePut: (hook: typeof beforePut) => { beforePut = hook } }
}
const engines: BotsEngine[] = []
const fixture = (adapter = new FakeAdapter(), disk = memory()) => {
  const registry = createBotAdapterRegistry()
  const unregister = registry.register(adapter)
  const store = createBotsStore(disk.table, () => Date.now())
  const engine = new BotsEngine({ store, registry })
  engines.push(engine)
  return { adapter, disk, registry, unregister, store, engine }
}
const connect = async (engine: BotsEngine) => {
  const snapshot = await engine.connect({ adapterId: 'fixture', label: 'Fixture', config: { credential: 'secret:fixture' }, acceptRisks: true })
  const bot = snapshot.bots[0]
  const connection = snapshot.connections[0]
  if (bot === undefined || connection === undefined) throw new Error('Fixture failed to connect')
  return { botId: bot.id, conversationId: 'conversation', connectionId: connection.id }
}
const messages = (engine: BotsEngine, input: { botId: string; conversationId: string }) => engine.messages({ ...input, limit: 100 }).messages

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.close()))
  vi.useRealTimers()
})

describe('durable provider-neutral Bots engine', () => {
  it('accepts an injected minimal adapter and keeps capabilities honest', async () => {
    const { engine, adapter } = fixture()
    adapter.bots[0]!.capabilities.text = false
    const input = await connect(engine)
    expect(engine.snapshot().adapters[0]?.id).toBe('fixture')
    await expect(engine.send({ ...input, requestId: randomUUID(), text: 'hello' })).rejects.toThrow('does not support')
    expect(adapter.sends).toHaveLength(0)
  })

  it('receives proactively without a panel; deduplicates replay and uses local sequence read boundaries', async () => {
    const { engine, adapter } = fixture()
    adapter.onPoll = async () => ({ messages: [remote('one'), remote('one')], cursor: 'cursor-1', hasMore: false })
    const input = await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    expect(messages(engine, input)).toHaveLength(1)
    expect(engine.snapshot().bots[0]?.unread).toBe(1)
    const first = messages(engine, input)[0]!
    await engine.markRead({ ...input, throughMessageId: first.id })
    adapter.onPoll = async () => ({ messages: [remote('one'), { ...remote('two'), createdAt: -100 }], cursor: 'cursor-2', hasMore: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages(engine, input).map(message => message.remoteId)).toEqual(['one', 'two'])
    expect(engine.snapshot().bots[0]?.unread).toBe(1)
    expect(engine.messages({ ...input, before: messages(engine, input)[1]!.id, limit: 1 }).messages[0]?.id).toBe(first.id)
    await expect(engine.markRead({ ...input, throughMessageId: 'unknown' })).rejects.toThrow('read boundary')
  })

  it('durably records send intent before external effects and coalesces identical concurrent dispatch', async () => {
    const { engine, adapter, disk } = fixture()
    const input = await connect(engine)
    const gate = deferred<AdapterMessage>()
    adapter.onSend = async send => {
      expect(disk.rows.get('current')?.messages.some(row => row.message.requestId === send.requestId && row.message.delivery === 'sending')).toBe(true)
      return gate.promise
    }
    const request = { ...input, requestId: randomUUID(), text: 'same body' }
    const first = engine.send(request)
    const second = engine.send(request)
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.sends).toHaveLength(1)
    await expect(engine.send({ ...request, text: 'changed' })).rejects.toThrow('different destination or message body')
    gate.resolve(echo(adapter.sends[0]!))
    expect((await first).delivery).toBe('sent')
    expect(await second).toEqual(await first)
    expect((await engine.send(request)).delivery).toBe('sent')
    expect(adapter.sends).toHaveLength(1)
  })

  it('never blindly resends uncertain delivery and reuses request ID and original body only after not-found', async () => {
    const { engine, adapter } = fixture()
    const input = await connect(engine)
    const request = { ...input, requestId: randomUUID(), text: 'authorized body' }
    adapter.onSend = async () => { throw new Error('DO_NOT_LEAK_FIXTURE_SECRET') }
    const initial = await engine.send(request)
    expect(initial.delivery).toBe('uncertain')
    expect(initial.notice).not.toContain('DO_NOT_LEAK')
    expect((await engine.send(request)).delivery).toBe('uncertain')
    expect(adapter.sends).toHaveLength(1)
    expect(adapter.reconciles).toHaveLength(1)
    await expect(engine.send({ ...request, text: 'new body' })).rejects.toThrow('different destination or message body')
    adapter.onReconcile = async () => ({ kind: 'not-found' })
    adapter.onSend = async input => echo(input)
    expect((await engine.send(request)).delivery).toBe('sent')
    expect(adapter.sends.map(input => [input.requestId, input.text, input.initialCursor])).toEqual([[request.requestId, request.text, 'original-link'], [request.requestId, request.text, 'original-link']])
  })

  it('reconciles a retained intent after restart and never acknowledges a stale completion', async () => {
    const first = fixture()
    const input = await connect(first.engine)
    const gate = deferred<AdapterMessage>()
    first.adapter.onSend = async () => gate.promise
    const request = { ...input, requestId: randomUUID(), text: 'restart body' }
    const pending = first.engine.send(request)
    await vi.advanceTimersByTimeAsync(0)
    await first.engine.disconnect(input)
    expect((await pending).delivery).toBe('uncertain')
    await first.engine.close()
    const second = fixture(new FakeAdapter(), first.disk)
    second.adapter.bots[0]!.conversations[0]!.initialCursor = 'new-baseline'
    await second.engine.start()
    await second.engine.reconnect(input)
    second.adapter.onReconcile = async send => ({ kind: 'found', message: echo(send) })
    expect((await second.engine.send(request)).delivery).toBe('sent')
    expect(second.adapter.sends).toHaveLength(0)
    expect(second.adapter.reconciles[0]?.initialCursor).toBe('original-link')
    gate.resolve(echo(first.adapter.sends[0]!))
    await vi.advanceTimersByTimeAsync(0)
    expect(messages(first.engine, input)[0]?.delivery).toBe('uncertain')
    expect(messages(second.engine, input)[0]?.delivery).toBe('sent')
  })

  it('keeps cached history on disconnect and removes local records only after explicit confirmation', async () => {
    const { engine, adapter, store } = fixture()
    adapter.onPoll = async () => ({ messages: [remote('kept')], cursor: 'kept-cursor', hasMore: false })
    const input = await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    await engine.disconnect(input)
    const pollCount = adapter.polls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(adapter.polls).toHaveLength(pollCount)
    expect(messages(engine, input)).toHaveLength(1)
    await engine.remove({ connectionId: input.connectionId, confirm: true })
    expect(store.read().messages).toHaveLength(0)
    expect(engine.snapshot().connections).toHaveLength(0)
    expect(adapter.closes).toBe(1)
  })

  it.each(['account', 'bot', 'conversation'] as const)('refuses a %s identity swap across reconnect without mixing history', async dimension => {
    const { engine, adapter } = fixture()
    const input = await connect(engine)
    const original = engine.snapshot().bots[0]!
    if (dimension === 'account') adapter.accountId = 'different-account'
    if (dimension === 'bot') adapter.bots[0]!.remoteId = 'different-bot'
    if (dimension === 'conversation') adapter.bots[0]!.conversations[0]!.id = 'different-conversation'
    const snapshot = await engine.reconnect(input)
    expect(snapshot.connections[0]?.status).toBe('error')
    expect(snapshot.connections[0]?.error).toContain('changed')
    expect(snapshot.bots[0]?.identity).toEqual(original.identity)
    expect(adapter.sends).toHaveLength(0)
  })

  it.each(['attachments', 'approvals', 'activity'] as const)('rejects reserved unsupported %s capabilities rather than silently advertising them', async capability => {
    const { engine, adapter } = fixture()
    adapter.bots[0]!.capabilities[capability] = true
    const snapshot = await engine.connect({ adapterId: 'fixture', label: 'Unsupported', config: { credential: 'secret:fixture' }, acceptRisks: true })
    expect(snapshot.bots).toHaveLength(0)
    expect(snapshot.connections[0]?.error).toContain('does not support')
  })

  it('keeps remote edits and deletion projections separate from immutable original send fingerprints', async () => {
    const { engine, adapter } = fixture()
    const input = await connect(engine)
    const request = { ...input, requestId: randomUUID(), text: 'original authorized text' }
    const sent = await engine.send(request)
    adapter.onPoll = async () => ({ messages: [{ ...echo(adapter.sends[0]!), text: 'edited remotely', updatedAt: 2 }], cursor: 'edited', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(messages(engine, input)[0]?.text).toBe('edited remotely')
    expect(engine.snapshot().connections[0]?.status).toBe('connected')
    expect((await engine.send(request)).id).toBe(sent.id)
    await expect(engine.send({ ...request, text: 'edited remotely' })).rejects.toThrow('different destination or message body')
    adapter.onPoll = async () => ({ messages: [{ ...echo(adapter.sends[0]!), text: '', notice: 'Deleted remotely', updatedAt: 3 }], cursor: 'deleted', hasMore: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages(engine, input)[0]?.text).toBe('')
    expect(messages(engine, input)[0]?.notice).toBe('Deleted remotely')
    expect(engine.snapshot().connections[0]?.status).toBe('connected')
    expect(adapter.sends).toHaveLength(1)
  })

  it.each(['sent', 'uncertain'] as const)('retains bot replies that reference a %s outgoing request without treating them as user echoes', async delivery => {
    const { engine, adapter } = fixture()
    const input = await connect(engine)
    if (delivery === 'uncertain') adapter.onSend = async () => { throw new Error('Fixture ambiguous delivery') }
    const request = { ...input, requestId: randomUUID(), text: 'question' }
    await engine.send(request)
    adapter.onPoll = async () => ({ messages: [{ ...remote('bot-reply', 'answer'), requestId: request.requestId }], cursor: 'reply', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(messages(engine, input).map(message => [message.author, message.delivery])).toEqual([['user', delivery], ['bot', 'received']])
    expect(engine.snapshot().connections[0]?.status).toBe('connected')
    expect(engine.snapshot().bots[0]?.unread).toBe(1)
  })

  it('does not duplicate an already linked remote bot', async () => {
    const { engine } = fixture()
    await connect(engine)
    await engine.connect({ adapterId: 'fixture', label: 'Duplicate', config: { credential: 'secret:fixture' }, acceptRisks: true })
    expect(engine.snapshot().bots).toHaveLength(1)
    expect(engine.snapshot().connections[1]?.error).toContain('already linked')
  })

  it('cancels an in-flight poll and rejects its late messages and cursor after disconnect', async () => {
    const { engine, adapter, store } = fixture()
    const gate = deferred<Awaited<ReturnType<BotAdapterSession['poll']>>>()
    adapter.onPoll = async () => gate.promise
    const input = await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    const signal = adapter.polls[0]!.signal
    await engine.disconnect(input)
    expect(signal.aborted).toBe(true)
    gate.resolve({ messages: [remote('stale')], cursor: 'stale-cursor', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(messages(engine, input)).toHaveLength(0)
    expect(store.read().bots[0]?.conversations[0]?.cursor).toBe('original-link')
    expect(engine.snapshot().connections[0]?.status).toBe('disconnected')
  })

  it('refreshes mutable identity metadata and text capability while preserving the original link boundary', async () => {
    const { engine, adapter } = fixture()
    const input = await connect(engine)
    adapter.bots[0]!.name = 'Updated display name'
    adapter.bots[0]!.capabilities.text = false
    adapter.bots[0]!.conversations[0]!.initialCursor = 'new-discovery-baseline'
    adapter.bots[0]!.conversations[0]!.title = 'Updated title'
    const snapshot = await engine.reconnect(input)
    expect(snapshot.bots[0]?.identity.name).toBe('Updated display name')
    expect(snapshot.bots[0]?.identity.conversations[0]?.title).toBe('Updated title')
    expect(snapshot.bots[0]?.identity.conversations[0]?.initialCursor).toBe('original-link')
    await expect(engine.send({ ...input, requestId: randomUUID(), text: 'not supported now' })).rejects.toThrow('does not support')
  })

  it('bounds a non-cooperating poll timeout, aborts it, and requires reconnect rather than accumulating background work', async () => {
    const { engine, adapter } = fixture()
    const gate = deferred<Awaited<ReturnType<BotAdapterSession['poll']>>>()
    adapter.onPoll = async () => gate.promise
    await connect(engine)
    await vi.advanceTimersByTimeAsync(15000)
    expect(adapter.polls).toHaveLength(1)
    expect(adapter.polls[0]?.signal.aborted).toBe(true)
    expect(engine.snapshot().connections[0]?.status).toBe('error')
    expect(engine.snapshot().connections[0]?.error).toContain('timed out')
    await vi.advanceTimersByTimeAsync(120000)
    expect(adapter.polls).toHaveLength(1)
    gate.resolve({ messages: [remote('too-late')], cursor: 'too-late', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.snapshot().bots[0]?.unread).toBe(0)
  })

  it('retains an unresolved intent beyond the settled history cache limit', async () => {
    const { engine, adapter, store } = fixture()
    const input = await connect(engine)
    adapter.onSend = async () => { throw new Error('Fixture ambiguous delivery') }
    const pending = await engine.send({ ...input, requestId: randomUUID(), text: 'must survive retention' })
    let index = 0
    adapter.onPoll = async () => ({ messages: Array.from({ length: 100 }, () => remote(`pending-history-${index++}`)), cursor: `pending-page-${index}`, hasMore: index < 600 })
    await vi.advanceTimersByTimeAsync(600)
    expect(store.read().messages.some(row => row.message.id === pending.id && row.message.delivery === 'uncertain')).toBe(true)
    expect(store.read().messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION + 1)
  })

  it('handles adapter unregister/re-register lifecycle and clean shutdown', async () => {
    const { engine, adapter, registry, unregister } = fixture()
    const input = await connect(engine)
    unregister()
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.snapshot().connections[0]?.status).toBe('adapter-missing')
    expect(adapter.closes).toBe(1)
    registry.register(adapter)
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.snapshot().connections[0]?.status).toBe('connected')
    await engine.close()
    const count = adapter.polls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(adapter.polls).toHaveLength(count)
    expect(adapter.closes).toBe(2)
    await expect(engine.send({ ...input, requestId: randomUUID(), text: 'after close' })).rejects.toThrow('closed')
  })

  it('rejects raw secrets and unknown fields before opening or persisting them', async () => {
    const { engine, adapter, store } = fixture()
    await expect(engine.connect({ adapterId: 'fixture', label: 'Bad', config: { credential: 'raw-secret-fixture' }, acceptRisks: true })).rejects.toThrow('secret references')
    await expect(engine.connect({ adapterId: 'fixture', label: 'Bad', config: { credential: 'secret:fixture', token: 'raw-secret-fixture' }, acceptRisks: true })).rejects.toThrow('Unknown')
    expect(adapter.opens).toBe(0)
    expect(JSON.stringify(store.read())).not.toContain('raw-secret-fixture')
    await engine.connect({ adapterId: 'fixture', label: 'Canonical', config: { credential: ' secret:fixture@prod ' }, acceptRisks: true })
    expect(adapter.configs[0]?.credential).toBe('secret:fixture')
  })

  it('publishes only deliberately safe adapter errors', async () => {
    const { engine, adapter } = fixture()
    adapter.onPoll = async () => { throw new Error('DO_NOT_LEAK_PROVIDER_BODY') }
    await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.snapshot().connections[0]?.error).not.toContain('DO_NOT_LEAK')
    adapter.onPoll = async () => { throw new BotAdapterError('auth-required', 'Relink the fixture account.') }
    await vi.advanceTimersByTimeAsync(2000)
    expect(engine.snapshot().connections[0]?.status).toBe('auth-required')
    expect(engine.snapshot().connections[0]?.error).toBe('Relink the fixture account.')
  })

  it('honors a provider polling cadence longer than one minute', async () => {
    const provider = new FakeAdapter()
    const registry = createBotAdapterRegistry()
    registry.register({ info: provider.info, pollIntervalMs: 300000, validateConfig: config => provider.validateConfig(config), open: input => provider.open(input) })
    const engine = new BotsEngine({ registry, store: createBotsStore(memory().table) })
    engines.push(engine)
    await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.polls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(299999)
    expect(provider.polls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.polls).toHaveLength(2)
  })

  it('backs off rate-limited polling and resets after success', async () => {
    const { engine, adapter } = fixture()
    adapter.onPoll = async () => { throw new BotAdapterError('rate-limited', 'Wait before syncing.') }
    await connect(engine)
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.polls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29999)
    expect(adapter.polls).toHaveLength(1)
    adapter.onPoll = async input => ({ messages: [], cursor: input.cursor, hasMore: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.polls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.polls).toHaveLength(3)
  })

  it('does not acknowledge failed persistence or send before a durable intent', async () => {
    const { engine, adapter, disk } = fixture()
    const input = await connect(engine)
    disk.beforePut(async value => { if (value.messages.some(row => row.message.delivery === 'sending')) throw new Error('DO_NOT_LEAK_BACKEND') })
    await expect(engine.send({ ...input, requestId: randomUUID(), text: 'not delivered' })).rejects.toThrow(STORAGE_FAILED)
    expect(adapter.sends).toHaveLength(0)
    expect(messages(engine, input)).toHaveLength(0)
    expect(engine.snapshot().connections[0]?.error).toBe(STORAGE_FAILED)
    await expect(engine.markRead({ ...input, throughMessageId: 'anything' })).rejects.toThrow(STORAGE_FAILED)
  })

  it('does not commit a receive cursor when messages fail to persist', async () => {
    const { engine, adapter, disk, store } = fixture()
    const input = await connect(engine)
    disk.beforePut(async value => { if (value.messages.length > 0) throw new Error('backend fixture failure') })
    adapter.onPoll = async () => ({ messages: [remote('not-durable')], cursor: 'must-not-save', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.read().bots[0]?.conversations[0]?.cursor).toBe('original-link')
    expect(messages(engine, input)).toHaveLength(0)
    expect(engine.snapshot().connections[0]?.error).toBe(STORAGE_FAILED)
  })

  it.each([false, true])('deduplicates an evicted incoming user request ID and rejects changed-body replay (conflict=%s)', async conflict => {
    const { engine, adapter, store } = fixture()
    const input = await connect(engine)
    const requestId = randomUUID()
    adapter.onPoll = async () => ({ messages: [{ ...remote('external-user-original', 'external original body'), author: 'user', requestId }], cursor: 'external-user-linked', hasMore: false })
    await vi.advanceTimersByTimeAsync(0)
    let index = 0
    adapter.onPoll = async () => ({ messages: Array.from({ length: 100 }, () => remote(`external-history-${index++}`)), cursor: `external-history-page-${index}`, hasMore: index < 600 })
    await vi.advanceTimersByTimeAsync(1600)
    expect(store.read().messages.some(row => row.message.remoteId === 'external-user-original')).toBe(false)
    const cursor = store.read().bots[0]!.conversations[0]!.cursor
    adapter.onPoll = async () => ({ messages: [{ ...remote('external-user-new-remote-id', conflict ? 'conflicting changed body' : 'external original body'), author: 'user', requestId }], cursor: 'external-replay', hasMore: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.read().messages.some(row => row.message.remoteId === 'external-user-new-remote-id')).toBe(false)
    expect(engine.snapshot().connections[0]?.status).toBe(conflict ? 'error' : 'connected')
    expect(store.read().bots[0]!.conversations[0]!.cursor).toBe(conflict ? cursor : 'external-replay')
  })

  it('bounds settled projection history without losing pending intents or outgoing request dedupe', async () => {
    const { engine, adapter, store } = fixture()
    const input = await connect(engine)
    const request = { ...input, requestId: randomUUID(), text: 'sent before retention' }
    const sent = await engine.send(request)
    let index = 0
    adapter.onPoll = async () => ({ messages: Array.from({ length: 100 }, () => remote(`history-${index++}`)), cursor: `page-${index}`, hasMore: index < 600 })
    await vi.advanceTimersByTimeAsync(600)
    expect(store.read().messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION)
    expect(store.read().messages.some(row => row.message.id === sent.id)).toBe(false)
    expect((await engine.send(request)).delivery).toBe('sent')
    expect(adapter.sends).toHaveLength(1)
    await expect(engine.send({ ...request, text: 'different after eviction' })).rejects.toThrow('different destination or message body')
    adapter.onPoll = async () => ({ messages: [remote('history-0')], cursor: 'replayed', hasMore: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages(engine, input).some(message => message.remoteId === 'history-0')).toBe(false)
  })
})
