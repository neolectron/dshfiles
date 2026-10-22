import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { formatSecretReference, parseSecretReference } from '@dshfiles/credential-port'
import { BotAdapterError } from '@dshfiles/bots/adapter'
import { PluginApiError } from '@dshfiles/dshx/api'
import type { AdapterMessage, BotAdapter, BotAdapterRegistry, BotAdapterSession, BotSendInput } from './adapter.js'
import {
  botAdapterInfoSchema, botConnectInputSchema, botIdentitySchema, botMessageSchema,
  type BotConnectInput, type BotConnection, type BotMessage, type BotsSnapshot,
} from './contract.js'
import {
  assertMessageCapacity, retainProjection, HISTORY_FULL, MAX_BOTS, MAX_CONNECTIONS, STORAGE_FAILED,
  type BotsState, type BotsStore, type StoredBot, type StoredConnection, type StoredMessage,
} from './store.js'

const UNAVAILABLE = 'The bot operation could not be completed. Reconnect or retry explicitly.'
const CANCELLED = 'Bot synchronization was cancelled. Delivery may need reconciliation.'
const IDENTITY_CHANGED = 'The remote account, bot or conversation changed. Remove the local connection explicitly before linking a different identity.'
const UNKNOWN_DELIVERY = 'Delivery is uncertain. Reconciliation did not establish whether the message arrived; it was not sent again.'
const INVALID_MESSAGE = 'The adapter returned an unsupported message. Synchronization stopped without advancing the cursor.'
const POLL_PAGE_LIMIT = 100
const NETWORK_TIMEOUT_MS = 15000
const CLOSE_TIMEOUT_MS = 2000

class ServiceError extends PluginApiError {}
class TimedOutError extends ServiceError {}
const refusal = (message: string): never => { throw new ServiceError(message) }
const safeError = (error: unknown): string => error instanceof BotAdapterError || error instanceof ServiceError ? error.message.slice(0, 2000) : UNAVAILABLE
const bodyHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const connectionOf = (state: BotsState, id: string): StoredConnection => state.connections.find(row => row.connection.id === id) ?? refusal('The local bot connection was not found.')
const botOf = (state: BotsState, id: string): StoredBot => state.bots.find(bot => bot.id === id) ?? refusal('The local bot was not found.')
const conversationOf = (bot: StoredBot, id: string) => bot.conversations.find(conversation => conversation.id === id) ?? refusal('The local bot conversation was not found.')
const safeNativeUrl = (value: string | null): string | null => {
  if (value === null) return null
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null }
  catch { return null }
}

interface Worker {
  readonly connectionId: string
  readonly adapter: BotAdapter
  readonly controller: AbortController
  session: BotAdapterSession | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  ready: Promise<void>
  pollIndex: number
  failures: number
}
export interface BotsEngineOptions {
  readonly store: BotsStore
  readonly registry: BotAdapterRegistry
  readonly now?: () => number
  readonly id?: () => string
}

/** Host-owned actors. The panel is only a reader; each connection owns cancellation, pacing and its verified session. */
export class BotsEngine {
  private readonly store: BotsStore
  private readonly registry: BotAdapterRegistry
  private readonly now: () => number
  private readonly id: () => string
  private readonly workers = new Map<string, Worker>()
  private readonly commandVersions = new Map<string, number>()
  private readonly sends = new Map<string, { botId: string; conversationId: string; text: string; result: Promise<BotMessage> }>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly closingSessions = new WeakSet<BotAdapterSession>()
  private unsubscribe: (() => void) | undefined
  private started: Promise<void> | undefined
  private closed = false
  private closing: Promise<void> | undefined

  constructor(options: BotsEngineOptions) {
    this.store = options.store
    this.registry = options.registry
    this.now = options.now ?? Date.now
    this.id = options.id ?? randomUUID
  }

  start(): Promise<void> {
    this.started ??= this.initialize()
    return this.started
  }

  private async initialize(): Promise<void> {
    // A crash after a durable intent is intrinsically uncertain. Startup never replays a send.
    await this.store.change(state => {
      for (const row of state.messages) if (row.message.delivery === 'sending') {
        row.message.delivery = 'uncertain'
        row.message.notice = UNKNOWN_DELIVERY
      }
      for (const row of state.connections) {
        row.connection.status = row.connection.enabled ? 'connecting' : 'disconnected'
        row.connection.error = null
      }
    })
    if (this.closed) return
    this.unsubscribe = this.registry.onChange(() => this.adaptersChanged())
    this.adaptersChanged()
  }

  private track(task: Promise<unknown>): void {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
  }

  private active(worker: Worker): boolean {
    return !this.closed && !this.store.failed && !worker.controller.signal.aborted && this.workers.get(worker.connectionId) === worker && this.registry.get(worker.adapter.info.id) === worker.adapter && this.store.read().connections.some(row => row.connection.id === worker.connectionId && row.connection.enabled)
  }

  /** Aborting and racing also bounds a broken adapter that ignores AbortSignal. Late results are never committed. */
  private async network<Result>(worker: Worker, operation: (signal: AbortSignal) => Promise<Result>, onLate?: (value: Result) => void): Promise<Result> {
    if (!this.active(worker)) return refusal(CANCELLED)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    worker.controller.signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejected = false
    let timedOut = false
    const cancelled = new Promise<never>((_resolve, reject) => {
      const fail = (): void => { rejected = true; reject(timedOut ? new TimedOutError('The bot request timed out. Delivery may need reconciliation.') : new ServiceError(CANCELLED)) }
      controller.signal.addEventListener('abort', fail, { once: true })
      timer = setTimeout(() => { timedOut = true; abort() }, NETWORK_TIMEOUT_MS)
      timer.unref?.()
    })
    const running = Promise.resolve().then(() => operation(controller.signal))
    void running.then(value => { if (rejected || !this.active(worker)) onLate?.(value) }, () => undefined)
    try {
      const value = await Promise.race([running, cancelled])
      if (!this.active(worker)) { onLate?.(value); return refusal(CANCELLED) }
      return value
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      worker.controller.signal.removeEventListener('abort', abort)
    }
  }

  private closeSession(session: BotAdapterSession): void {
    if (this.closingSessions.has(session)) return
    this.closingSessions.add(session)
    // Teardown must not hang if a provider's close never settles; do not expose close errors.
    const close = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
      timer.unref?.()
      void Promise.resolve().then(() => session.close()).then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); resolve() })
    })
    this.track(close)
  }

  private stopWorker(id: string): void {
    const worker = this.workers.get(id)
    if (worker === undefined) return
    this.workers.delete(id)
    worker.controller.abort()
    if (worker.timer !== undefined) clearTimeout(worker.timer)
    if (worker.session !== undefined) this.closeSession(worker.session)
  }

  private adaptersChanged(): void {
    if (this.closed) return
    for (const row of this.store.read().connections) {
      const connection = row.connection
      const adapter = this.registry.get(connection.adapterId)
      const worker = this.workers.get(connection.id)
      if (worker !== undefined && worker.adapter !== adapter) this.stopWorker(connection.id)
      if (!connection.enabled) continue
      if (adapter === undefined) {
        this.track(this.store.change(state => {
          const current = state.connections.find(value => value.connection.id === connection.id)?.connection
          if (current?.enabled && this.registry.get(current.adapterId) === undefined) {
            current.status = 'adapter-missing'; current.error = 'The bot adapter is not registered.'
            this.makeUncertain(state, connection.id)
          }
        }))
      } else if (!this.workers.has(connection.id)) this.track(this.launch(connection.id, adapter))
    }
  }

  private launch(connectionId: string, adapter: BotAdapter): Promise<void> {
    this.stopWorker(connectionId)
    const worker: Worker = { connectionId, adapter, controller: new AbortController(), session: undefined, timer: undefined, ready: Promise.resolve(), pollIndex: 0, failures: 0 }
    this.workers.set(connectionId, worker)
    worker.ready = this.openWorker(worker)
    this.track(worker.ready)
    return worker.ready
  }

  private async openWorker(worker: Worker): Promise<void> {
    try {
      await this.store.change(state => {
        if (!this.active(worker)) return
        const connection = connectionOf(state, worker.connectionId).connection
        connection.status = 'connecting'; connection.error = null
      })
      if (!this.active(worker)) return
      const row = connectionOf(this.store.read(), worker.connectionId)
      const config = this.validatedConfig(worker.adapter, row.config)
      const session = await this.network(worker, signal => worker.adapter.open({ config, signal }), late => this.closeSession(late))
      worker.session = session
      const discovered = session.bots.map(identity => {
        const result = botIdentitySchema.safeParse(identity)
        if (!result.success) return refusal('The adapter returned an unsupported bot identity.')
        if (result.data.capabilities.attachments || result.data.capabilities.approvals || result.data.capabilities.activity) return refusal('This adapter advertises rich bot capabilities that the current Bots contract does not support.')
        result.data.nativeUrl = safeNativeUrl(result.data.nativeUrl)
        return result.data
      })
      if (!session.accountId || session.accountId.length > 300 || discovered.length === 0 || discovered.length > MAX_BOTS || new Set(discovered.map(bot => bot.remoteId)).size !== discovered.length || discovered.some(bot => new Set(bot.conversations.map(conversation => conversation.id)).size !== bot.conversations.length)) {
        return refusal('The adapter returned an unsupported account or bot identity.')
      }
      await this.store.change(state => {
        if (!this.active(worker)) return
        const current = connectionOf(state, worker.connectionId).connection
        const existing = state.bots.filter(bot => bot.connectionId === worker.connectionId)
        if (current.accountId !== null) {
          if (current.accountId !== session.accountId || existing.length !== discovered.length || existing.some(bot => {
            const match = discovered.find(remote => remote.remoteId === bot.identity.remoteId)
            return match === undefined || match.conversations.length !== bot.conversations.length || bot.conversations.some(conversation => !match.conversations.some(value => value.id === conversation.id))
          })) return refusal(IDENTITY_CHANGED)
          // Identity continuity does not freeze presentation or capabilities; only the original history boundary is immutable.
          for (const bot of existing) {
            const match = discovered.find(remote => remote.remoteId === bot.identity.remoteId)
            if (match === undefined) return refusal(IDENTITY_CHANGED)
            bot.identity = { ...match, conversations: bot.identity.conversations.map(original => ({ ...original, title: match.conversations.find(current => current.id === original.id)?.title ?? original.title })) }
          }
        } else {
          const duplicateConnections = new Set(state.connections.filter(row => row.connection.id !== worker.connectionId && row.connection.adapterId === current.adapterId && row.connection.accountId === session.accountId).map(row => row.connection.id))
          if (state.bots.some(bot => duplicateConnections.has(bot.connectionId) && discovered.some(remote => remote.remoteId === bot.identity.remoteId))) return refusal('This remote bot is already linked through another local connection.')
          if (state.bots.length + discovered.length > MAX_BOTS) return refusal('At most 32 local bots can be connected.')
          for (const identity of discovered) state.bots.push({
            id: this.id(), connectionId: worker.connectionId, identity,
            conversations: identity.conversations.map(conversation => ({ id: conversation.id, cursor: conversation.initialCursor, readThrough: 0 })),
          })
          current.accountId = session.accountId
        }
        current.status = 'connected'; current.error = null
      })
      if (this.active(worker)) this.schedule(worker, 0)
    } catch (error) {
      if (this.active(worker)) {
        await this.recordError(worker, error)
        this.stopWorker(worker.connectionId)
      }
    }
  }

  private schedule(worker: Worker, delay: number): void {
    if (!this.active(worker)) return
    worker.timer = setTimeout(() => {
      worker.timer = undefined
      this.track(this.poll(worker))
    }, delay)
    worker.timer.unref?.()
  }

  private async poll(worker: Worker): Promise<void> {
    let more = false
    let delayAfterFailure = 0
    try {
      const session = worker.session
      if (session === undefined) return
      // At most four bounded pages per turn, round-robin across conversations; independent connections never block one another.
      const conversations = this.store.read().bots.filter(bot => bot.connectionId === worker.connectionId).flatMap(bot => bot.conversations.map(conversation => ({ bot, conversation })))
      const pageCount = Math.min(4, conversations.length)
      for (let index = 0; index < pageCount; index++) {
        const target = conversations[worker.pollIndex % conversations.length]
        worker.pollIndex++
        if (target === undefined) break
        const { bot, conversation } = target
        if (!this.active(worker)) return
        const current = conversationOf(botOf(this.store.read(), bot.id), conversation.id)
        const page = await this.network(worker, signal => session.poll({ remoteBotId: bot.identity.remoteId, conversationId: conversation.id, cursor: current.cursor, signal }))
        if (!Array.isArray(page.messages) || page.messages.length > POLL_PAGE_LIMIT || (page.cursor !== null && (typeof page.cursor !== 'string' || page.cursor.length > 2000)) || typeof page.hasMore !== 'boolean' || (page.hasMore && page.cursor === current.cursor)) return refusal(INVALID_MESSAGE)
        await this.store.change(state => {
          if (!this.active(worker)) return
          const localBot = botOf(state, bot.id)
          const localConversation = conversationOf(localBot, conversation.id)
          for (const message of page.messages) this.receive(state, localBot, conversation.id, message)
          retainProjection(state)
          // Empty provider pages are legitimate progress. Cursor and all (possibly zero) messages are one durable write.
          localConversation.cursor = page.cursor
          const connection = connectionOf(state, worker.connectionId).connection
          connection.lastSyncAt = this.now(); connection.status = 'connected'; connection.error = null
        })
        more ||= page.hasMore
      }
      worker.failures = 0
    } catch (error) {
      if (this.store.failed) { this.stopWorker(worker.connectionId); return }
      if (!this.active(worker)) return
      worker.failures++
      delayAfterFailure = Math.min(120000, 1000 * 2 ** Math.min(worker.failures, 7))
      if (error instanceof BotAdapterError && error.code === 'rate-limited') delayAfterFailure = Math.max(30000, delayAfterFailure)
      await this.recordError(worker, error)
      if (this.store.failed || error instanceof ServiceError || (error instanceof BotAdapterError && ['auth-required', 'access-denied', 'identity-mismatch', 'protocol-error'].includes(error.code))) {
        this.stopWorker(worker.connectionId)
        return
      }
    }
    const interval = Math.max(1000, Math.min(300000, Number.isFinite(worker.adapter.pollIntervalMs) ? worker.adapter.pollIntervalMs : 5000))
    this.schedule(worker, delayAfterFailure > 0 ? Math.max(interval, delayAfterFailure) : more ? 100 : interval)
  }

  private async recordError(worker: Worker, error: unknown): Promise<void> {
    if (this.store.failed) return
    await this.store.change(state => {
      if (!this.active(worker)) return
      const connection = connectionOf(state, worker.connectionId).connection
      connection.status = error instanceof BotAdapterError && error.code === 'auth-required' ? 'auth-required' : 'error'
      connection.error = safeError(error)
    })
  }

  private validatedConfig(adapter: BotAdapter, supplied: Readonly<Record<string, string>>): Record<string, string> {
    const info = botAdapterInfoSchema.safeParse(adapter.info)
    if (!info.success || new Set(adapter.info.fields.map(field => field.key)).size !== adapter.info.fields.length) return refusal('The bot adapter configuration is unsupported.')
    if (Object.keys(supplied).some(key => !adapter.info.fields.some(field => field.key === key))) return refusal('Unknown bot configuration fields are not accepted.')
    const pairs: [string, string][] = []
    for (const field of adapter.info.fields) {
      const value = supplied[field.key]?.trim() ?? ''
      if (!value && field.required) return refusal('A required bot configuration field is missing.')
      if (!value) continue
      if (field.kind === 'secret-reference') {
        const parsed = parseSecretReference(value)
        if (parsed === null) return refusal('Bot credentials must be secret references, never credential values.')
        pairs.push([field.key, formatSecretReference(parsed)])
      } else pairs.push([field.key, value])
    }
    const config = Object.fromEntries(pairs)
    try { adapter.validateConfig(config) }
    catch (error) { return refusal(safeError(error)) }
    return config
  }

  snapshot(): BotsSnapshot {
    const state = this.store.read()
    return {
      revision: state.revision,
      adapters: this.registry.list().map(adapter => botAdapterInfoSchema.parse(adapter.info)),
      connections: state.connections.map(row => this.store.failed ? { ...row.connection, status: 'error', error: STORAGE_FAILED } : row.connection),
      bots: state.bots.map(bot => {
        const messages = state.messages.filter(row => row.message.botId === bot.id)
        const connection = connectionOf(state, bot.connectionId).connection
        return {
          id: bot.id, connectionId: bot.connectionId, provider: connection.adapterId, identity: bot.identity,
          unread: messages.filter(row => row.message.author === 'bot' && row.sequence > conversationOf(bot, row.message.conversationId).readThrough).length,
          lastMessageAt: messages.at(-1)?.message.createdAt ?? null, activity: 'unknown',
        }
      }),
    }
  }

  async connect(input: BotConnectInput): Promise<BotsSnapshot> {
    await this.start()
    this.assertOpen()
    const parsed = botConnectInputSchema.safeParse(input)
    if (!parsed.success) return refusal('Bot connection input is invalid; explicit risk acceptance is required.')
    const adapter = this.registry.get(input.adapterId) ?? refusal('The requested bot adapter is not registered.')
    const config = this.validatedConfig(adapter, parsed.data.config)
    const id = this.id()
    await this.store.change(state => {
      if (state.connections.length >= MAX_CONNECTIONS) return refusal('At most 32 local bot connections can be configured.')
      state.connections.push({ config, connection: { id, adapterId: adapter.info.id, label: parsed.data.label, status: 'connecting', error: null, lastSyncAt: null, enabled: true, accountId: null, createdAt: this.now() } })
    })
    if (!this.closed) await this.launch(id, adapter)
    return this.snapshot()
  }

  async reconnect(input: { connectionId: string }): Promise<BotsSnapshot> {
    await this.start()
    this.assertOpen()
    const row = connectionOf(this.store.read(), input.connectionId)
    const version = this.nextCommand(input.connectionId)
    this.stopWorker(input.connectionId)
    await this.store.change(state => {
      const connection = connectionOf(state, input.connectionId).connection
      connection.enabled = true; connection.status = 'connecting'; connection.error = null
      this.makeUncertain(state, input.connectionId)
    })
    if (this.commandVersions.get(input.connectionId) !== version) return this.snapshot()
    const adapter = this.registry.get(row.connection.adapterId)
    if (adapter === undefined) {
      await this.store.change(state => {
        if (this.commandVersions.get(input.connectionId) !== version) return
        const connection = connectionOf(state, input.connectionId).connection; connection.status = 'adapter-missing'; connection.error = 'The bot adapter is not registered.'
      })
    } else if (!this.closed) await this.launch(input.connectionId, adapter)
    return this.snapshot()
  }

  private nextCommand(connectionId: string): number {
    const version = (this.commandVersions.get(connectionId) ?? 0) + 1
    this.commandVersions.set(connectionId, version)
    return version
  }

  private makeUncertain(state: BotsState, connectionId: string): void {
    const botIds = new Set(state.bots.filter(bot => bot.connectionId === connectionId).map(bot => bot.id))
    for (const row of state.messages) if (botIds.has(row.message.botId) && row.message.delivery === 'sending') {
      row.message.delivery = 'uncertain'; row.message.notice = UNKNOWN_DELIVERY; row.message.updatedAt = this.now()
    }
  }

  async disconnect(input: { connectionId: string }): Promise<BotsSnapshot> {
    await this.start()
    this.assertOpen()
    this.nextCommand(input.connectionId)
    this.stopWorker(input.connectionId)
    await this.store.change(state => {
      const connection = connectionOf(state, input.connectionId).connection
      connection.enabled = false; connection.status = 'disconnected'; connection.error = null
      this.makeUncertain(state, input.connectionId)
    })
    return this.snapshot()
  }

  async remove(input: { connectionId: string; confirm: true }): Promise<BotsSnapshot> {
    await this.start()
    this.assertOpen()
    if (input.confirm !== true) return refusal('Removing local bot data requires explicit confirmation.')
    connectionOf(this.store.read(), input.connectionId)
    this.nextCommand(input.connectionId)
    this.stopWorker(input.connectionId)
    await this.store.change(state => {
      const ids = new Set(state.bots.filter(bot => bot.connectionId === input.connectionId).map(bot => bot.id))
      state.connections = state.connections.filter(row => row.connection.id !== input.connectionId)
      state.bots = state.bots.filter(bot => bot.connectionId !== input.connectionId)
      state.messages = state.messages.filter(row => !ids.has(row.message.botId))
      state.requests = state.requests.filter(row => !ids.has(row.botId))
      state.seen = state.seen.filter(row => !ids.has(row.botId))
    })
    return this.snapshot()
  }

  messages(input: { botId: string; conversationId: string; before?: string | undefined; limit: number }): { messages: BotMessage[]; hasMore: boolean } {
    const state = this.store.read()
    conversationOf(botOf(state, input.botId), input.conversationId)
    const rows = state.messages.filter(row => row.message.botId === input.botId && row.message.conversationId === input.conversationId)
    const boundary = input.before === undefined ? rows.length : rows.findIndex(row => row.message.id === input.before)
    if (boundary < 0) return refusal('The message pagination boundary was not found in this conversation.')
    const limit = Math.max(1, Math.min(100, input.limit))
    const start = Math.max(0, boundary - limit)
    return { messages: rows.slice(start, boundary).map(row => row.message), hasMore: start > 0 }
  }

  async markRead(input: { botId: string; conversationId: string; throughMessageId: string }): Promise<BotsSnapshot> {
    await this.start()
    this.assertOpen()
    await this.store.change(state => {
      const conversation = conversationOf(botOf(state, input.botId), input.conversationId)
      const through = state.messages.find(row => row.message.id === input.throughMessageId && row.message.botId === input.botId && row.message.conversationId === input.conversationId) ?? refusal('The local read boundary was not found in this conversation.')
      conversation.readThrough = Math.max(conversation.readThrough, through.sequence)
    })
    return this.snapshot()
  }

  send(input: { botId: string; conversationId: string; requestId: string; text: string }): Promise<BotMessage> {
    const active = this.sends.get(input.requestId)
    if (active !== undefined) {
      if (active.botId !== input.botId || active.conversationId !== input.conversationId || active.text !== input.text) return Promise.reject(new ServiceError('A request ID cannot be reused with a different destination or message body.'))
      return active.result
    }
    if (this.sends.size >= 32) return Promise.reject(new ServiceError('At most 32 bot sends may be in progress. Wait for one to settle before sending again.'))
    const result = this.sendOnce(input)
    this.sends.set(input.requestId, { ...input, result })
    void result.then(() => { if (this.sends.get(input.requestId)?.result === result) this.sends.delete(input.requestId) }, () => { if (this.sends.get(input.requestId)?.result === result) this.sends.delete(input.requestId) })
    this.track(result)
    return result
  }

  private async sendOnce(input: { botId: string; conversationId: string; requestId: string; text: string }): Promise<BotMessage> {
    await this.start()
    this.assertOpen()
    if (!z.string().uuid().safeParse(input.requestId).success || !input.text.trim() || input.text.length > 16000) return refusal('The bot message body or request ID is invalid.')
    let state = this.store.read()
    const bot = botOf(state, input.botId)
    conversationOf(bot, input.conversationId)
    if (!bot.identity.capabilities.text) return refusal('This bot does not support sending text messages.')
    const tombstone = state.requests.find(row => row.requestId === input.requestId)
    if (tombstone !== undefined) {
      if (tombstone.botId !== input.botId || tombstone.conversationId !== input.conversationId || tombstone.bodyHash !== bodyHash(input.text)) return refusal('A request ID cannot be reused with a different destination or message body.')
      return { id: tombstone.localId, botId: tombstone.botId, conversationId: tombstone.conversationId, remoteId: tombstone.remoteId, requestId: tombstone.requestId, author: 'user', text: input.text, notice: null, nativeUrl: null, createdAt: tombstone.createdAt, updatedAt: tombstone.updatedAt, delivery: 'sent' }
    }
    const existing = state.messages.find(row => row.message.requestId === input.requestId && row.message.author === 'user')
    if (existing !== undefined && (existing.message.botId !== input.botId || existing.message.conversationId !== input.conversationId || existing.message.text !== input.text)) return refusal('A request ID cannot be reused with a different destination or message body.')
    if (existing?.message.delivery === 'sent') return existing.message
    const worker = this.workers.get(bot.connectionId)
    if (worker !== undefined) await worker.ready
    if (!botOf(this.store.read(), input.botId).identity.capabilities.text) return refusal('This bot does not support sending text messages.')
    if (worker === undefined || !this.active(worker) || worker.session === undefined || connectionOf(this.store.read(), bot.connectionId).connection.status !== 'connected') return refusal('Reconnect this bot before sending a message.')
    const session = worker.session
    const original = bot.identity.conversations.find(conversation => conversation.id === input.conversationId) ?? refusal('The original bot conversation was not found.')
    const networkInput = (signal: AbortSignal): BotSendInput => ({ remoteBotId: bot.identity.remoteId, conversationId: input.conversationId, initialCursor: original.initialCursor, text: input.text, requestId: input.requestId, signal })
    let localId = existing?.message.id ?? this.id()
    if (existing !== undefined) {
      const reconciliation = await this.network(worker, signal => session.reconcile(networkInput(signal))).catch(error => {
        if (this.store.failed) throw new PluginApiError(STORAGE_FAILED)
        return { kind: 'unknown' as const }
      })
      if (!this.active(worker)) return this.localMessage(localId, input.text)
      if (reconciliation.kind === 'found') {
        await this.store.change(draft => {
          if (!this.active(worker)) return
          this.confirm(draft, bot, input.conversationId, localId, reconciliation.message)
        })
        return this.localMessage(localId, input.text)
      }
      if (reconciliation.kind !== 'not-found') {
        await this.store.change(draft => {
          const message = draft.messages.find(row => row.message.id === localId)?.message
          if (message !== undefined && message.delivery !== 'sent') { message.delivery = 'uncertain'; message.notice = UNKNOWN_DELIVERY; message.updatedAt = this.now() }
        })
        return this.localMessage(localId, input.text)
      }
    }
    // The state may have changed while reconciliation ran (e.g. a poll echo confirmed it).
    state = this.store.read()
    const confirmed = state.messages.find(row => row.message.id === localId)?.message
    if (confirmed?.delivery === 'sent') return confirmed
    await this.store.change(draft => {
      if (!this.active(worker)) return refusal(CANCELLED)
      const prior = draft.messages.find(row => row.message.requestId === input.requestId && row.message.author === 'user')
      if (prior === undefined) {
        try { assertMessageCapacity(draft) } catch { return refusal(HISTORY_FULL) }
        draft.messages.push({ sequence: draft.nextSequence++, remoteUpdatedAt: null, message: {
          id: localId, botId: input.botId, conversationId: input.conversationId, remoteId: null, requestId: input.requestId,
          author: 'user', text: input.text, notice: null, nativeUrl: null, createdAt: this.now(), updatedAt: this.now(), delivery: 'sending',
        } })
      } else { localId = prior.message.id; if (prior.message.delivery !== 'sent') { prior.message.delivery = 'sending'; prior.message.notice = null; prior.message.updatedAt = this.now() } }
    })
    if (!this.active(worker)) return this.localMessage(localId, input.text)
    if (this.localMessage(localId, input.text).delivery === 'sent') return this.localMessage(localId, input.text)
    try {
      const remote = await this.network(worker, signal => session.send(networkInput(signal)))
      await this.store.change(draft => {
        if (!this.active(worker)) return
        this.confirm(draft, bot, input.conversationId, localId, remote)
      })
    } catch (error) {
      if (this.store.failed) throw new PluginApiError(STORAGE_FAILED)
      await this.store.change(draft => {
        const message = draft.messages.find(row => row.message.id === localId)?.message
        if (message === undefined || message.delivery === 'sent') return
        message.delivery = error instanceof BotAdapterError && ['auth-required', 'access-denied', 'rate-limited'].includes(error.code) ? 'failed' : 'uncertain'
        message.notice = this.active(worker) ? safeError(error) : UNKNOWN_DELIVERY
        message.updatedAt = this.now()
      })
    }
    return this.localMessage(localId, input.text)
  }

  private localMessage(id: string, text: string): BotMessage {
    const state = this.store.read()
    const message = state.messages.find(row => row.message.id === id)?.message
    if (message !== undefined) return message
    const settled = state.requests.find(row => row.localId === id) ?? refusal('The local message was removed before the operation completed.')
    return { id, botId: settled.botId, conversationId: settled.conversationId, requestId: settled.requestId, remoteId: settled.remoteId, author: 'user', text, notice: null, nativeUrl: null, createdAt: settled.createdAt, updatedAt: settled.updatedAt, delivery: 'sent' }
  }

  private normalized(bot: StoredBot, conversationId: string, input: AdapterMessage): BotMessage {
    const parsed = botMessageSchema.safeParse({ ...input, id: this.id(), botId: bot.id, conversationId, remoteId: input.id, delivery: input.author === 'user' ? 'sent' : 'received', nativeUrl: safeNativeUrl(input.nativeUrl) })
    if (!parsed.success || !input.id || input.id.length > 600 || (input.requestId !== null && input.requestId.length > 300) || !Number.isFinite(input.createdAt) || !Number.isFinite(input.updatedAt)) return refusal(INVALID_MESSAGE)
    return parsed.data
  }

  private confirm(state: BotsState, bot: StoredBot, conversationId: string, localId: string, remote: AdapterMessage): void {
    const localRow = state.messages.find(row => row.message.id === localId) ?? refusal('The local send intent was not found.')
    const local = localRow.message
    const incoming = this.normalized(bot, conversationId, remote)
    if (incoming.author !== 'user' || incoming.text !== local.text || (incoming.requestId !== null && incoming.requestId !== local.requestId) || (local.remoteId !== null && local.remoteId !== incoming.remoteId)) return refusal(INVALID_MESSAGE)
    const duplicate = state.messages.find(row => row.message.id !== localId && row.message.botId === bot.id && row.message.conversationId === conversationId && row.message.remoteId === incoming.remoteId)
    if (duplicate !== undefined) {
      if (duplicate.message.author !== 'user' || duplicate.message.text !== local.text) return refusal(INVALID_MESSAGE)
      state.messages = state.messages.filter(row => row !== duplicate)
    }
    localRow.remoteUpdatedAt = incoming.updatedAt
    local.remoteId = incoming.remoteId; local.delivery = 'sent'; local.updatedAt = this.now(); local.notice = incoming.notice; local.nativeUrl = incoming.nativeUrl
    if (local.requestId !== null && incoming.remoteId !== null && !state.requests.some(row => row.requestId === local.requestId)) state.requests.push({
      requestId: local.requestId, bodyHash: bodyHash(local.text), botId: bot.id, conversationId, localId: local.id, remoteId: incoming.remoteId, createdAt: local.createdAt, updatedAt: local.updatedAt,
    })
    retainProjection(state)
  }

  private receive(state: BotsState, bot: StoredBot, conversationId: string, remote: AdapterMessage): void {
    const incoming = this.normalized(bot, conversationId, remote)
    const byRemote = state.messages.find(row => row.message.botId === bot.id && row.message.conversationId === conversationId && row.message.remoteId === remote.id)
    if (byRemote !== undefined) {
      if (byRemote.message.author !== incoming.author) return refusal(INVALID_MESSAGE)
      // A verified remote identity owns later edits/deletions. Its mutable projection is not the immutable send fingerprint.
      if (incoming.updatedAt > (byRemote.remoteUpdatedAt ?? Number.NEGATIVE_INFINITY)) {
        byRemote.message.text = incoming.text; byRemote.message.notice = incoming.notice; byRemote.message.nativeUrl = incoming.nativeUrl
        byRemote.message.updatedAt = Math.max(byRemote.message.updatedAt, incoming.updatedAt)
        byRemote.remoteUpdatedAt = incoming.updatedAt
      }
      return
    }
    // A bot reply can legitimately refer to the user's request ID. Only user-authored echoes reconcile outgoing intent.
    const settled = state.requests.find(row => (incoming.author === 'user' && incoming.requestId !== null && row.requestId === incoming.requestId) || (row.botId === bot.id && row.conversationId === conversationId && row.remoteId === remote.id))
    if (settled !== undefined) {
      if (settled.botId !== bot.id || settled.conversationId !== conversationId || incoming.author !== 'user' || settled.remoteId !== remote.id) return refusal(INVALID_MESSAGE)
      return
    }
    const byRequest = incoming.author === 'user' && incoming.requestId !== null ? state.messages.find(row => row.message.author === 'user' && row.message.requestId === incoming.requestId) : undefined
    if (byRequest !== undefined) {
      if (byRequest.message.botId !== bot.id || byRequest.message.conversationId !== conversationId) return refusal(INVALID_MESSAGE)
      this.confirm(state, bot, conversationId, byRequest.message.id, remote)
      return
    }
    const seen = state.seen.find(row => row.botId === bot.id && row.conversationId === conversationId && (row.remoteId === remote.id || (incoming.author === 'user' && row.author === 'user' && incoming.requestId !== null && row.requestId === incoming.requestId)))
    if (seen !== undefined) {
      // Stable remote IDs may be edited. A different remote ID reusing one user request ID must retain its original body fingerprint.
      if (seen.author !== incoming.author || (seen.remoteId !== remote.id && seen.bodyHash !== bodyHash(incoming.text))) return refusal(INVALID_MESSAGE)
      return
    }
    const row: StoredMessage = { message: incoming, sequence: state.nextSequence++, remoteUpdatedAt: incoming.updatedAt }
    state.messages.push(row)
    state.seen.push({ botId: bot.id, conversationId, remoteId: remote.id, author: incoming.author, requestId: incoming.requestId, bodyHash: bodyHash(incoming.text) })
  }

  private assertOpen(): void {
    if (this.closed) return refusal('The Bots Host is closed.')
    if (this.store.failed) throw new PluginApiError(STORAGE_FAILED)
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    for (const id of [...this.workers.keys()]) this.stopWorker(id)
    await this.started?.catch(() => undefined)
    // Aborted operations settle through their bounded races; their late provider callbacks cannot publish.
    await Promise.allSettled([...this.tasks])
    if (!this.store.failed) await this.store.change(state => { for (const connection of state.connections) this.makeUncertain(state, connection.connection.id) })
    await this.store.flush()
  }
}
