import { defineDomain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { PluginApiError } from '@dshfiles/dshx/api'
import { botConnectionSchema, botIdentitySchema, botMessageSchema } from './contract.js'

export const MAX_CONNECTIONS = 32
export const MAX_BOTS = 32
/** Projection retention is bounded; unresolved sends are never evicted. Outgoing tombstones do not expire. */
export const MAX_MESSAGES_PER_CONVERSATION = 500
export const MAX_MESSAGES = 10000
export const MAX_PENDING_MESSAGES = 1000
export const MAX_REQUESTS = 10000
export const MAX_SEEN_REMOTE_IDS = 20000
export const HISTORY_FULL =
  'The local bot outbox or request ledger is full. Resolve pending sends or explicitly remove the local connection before linking again.'
export const STORAGE_FAILED = 'Bot storage failed. No further changes can be acknowledged until the Host is restarted.'

const storedConnectionSchema = z
  .object({
    connection: botConnectionSchema,
    config: z.record(z.string().max(80), z.string().max(4096)),
  })
  .strict()
const storedBotSchema = z
  .object({
    id: z.string(),
    connectionId: z.string(),
    identity: botIdentitySchema,
    conversations: z.array(z.object({ id: z.string(), cursor: z.string().max(2000).nullable(), readThrough: z.number().int().nonnegative() }).strict()).max(32),
  })
  .strict()
const storedMessageSchema = z.object({ message: botMessageSchema, sequence: z.number().int().positive(), remoteUpdatedAt: z.number().nullable() }).strict()
export const botsStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    connections: z.array(storedConnectionSchema).max(MAX_CONNECTIONS),
    bots: z.array(storedBotSchema).max(MAX_BOTS),
    messages: z.array(storedMessageSchema).max(MAX_MESSAGES + MAX_PENDING_MESSAGES),
    requests: z
      .array(
        z
          .object({
            requestId: z.string(),
            bodyHash: z.string(),
            botId: z.string(),
            conversationId: z.string(),
            localId: z.string(),
            remoteId: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
          })
          .strict(),
      )
      .max(MAX_REQUESTS),
    seen: z
      .array(
        z
          .object({
            botId: z.string(),
            conversationId: z.string(),
            remoteId: z.string(),
            author: z.enum(['bot', 'user']),
            requestId: z.string().nullable(),
            bodyHash: z.string(),
          })
          .strict(),
      )
      .max(MAX_SEEN_REMOTE_IDS),
  })
  .strict()

export type BotsState = z.infer<typeof botsStateSchema>
export type StoredConnection = BotsState['connections'][number]
export type StoredBot = BotsState['bots'][number]
export type StoredMessage = BotsState['messages'][number]
export type BotsStateTable = KvTable<string, BotsState>

export const botsDomain = defineDomain({
  name: 'durable_bots',
  version: 1,
  tables: { state: { valueSchema: botsStateSchema, __key: 'state' } },
})

export interface BotsStore {
  read(): BotsState
  change<Result>(operation: (draft: BotsState) => Result): Promise<Result>
  flush(): Promise<void>
  readonly failed: boolean
}

/** Cohesive internal owner of durable writes, outbox capacity and projection retention. */
export class BotsStorage {
  /** One atomic row keeps messages, outbox and receive cursor inseparable. Writes publish only after durability. */
  static create(table: BotsStateTable, now: () => number = Date.now): BotsStore {
    const loaded = botsStateSchema.safeParse(
      table.get('current') ?? {
        revision: 0,
        nextSequence: 1,
        connections: [],
        bots: [],
        messages: [],
        requests: [],
        seen: [],
      },
    )
    if (!loaded.success) throw new PluginApiError('Bot storage could not be loaded safely.')
    let current = loaded.data
    let writes = Promise.resolve()
    let failed = false
    return {
      read: () => structuredClone(current),
      get failed() {
        return failed
      },
      change(operation) {
        const result = writes.then(async () => {
          if (failed) throw new PluginApiError(STORAGE_FAILED)
          const draft = structuredClone(current)
          const value = operation(draft)
          draft.revision = Math.max(current.revision + 1, now())
          if (!botsStateSchema.safeParse(draft).success) throw new PluginApiError('The bot change exceeded a supported storage boundary.')
          try {
            await table.put('current', draft)
          } catch {
            // Even an ambiguous backend result must not be followed by a stale overwrite or a network side effect.
            failed = true
            throw new PluginApiError(STORAGE_FAILED)
          }
          current = draft
          return structuredClone(value)
        })
        writes = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      },
      flush: () => writes,
    }
  }

  static assertCapacity(state: BotsState): void {
    const unresolved = state.messages.filter(
      row => row.message.delivery === 'sending' || row.message.delivery === 'uncertain' || row.message.delivery === 'failed',
    )
    if (unresolved.length >= MAX_PENDING_MESSAGES || state.requests.length + unresolved.length >= MAX_REQUESTS) throw new PluginApiError(HISTORY_FULL)
  }

  /** Retain latest 500 settled rows/conversation and 10,000 globally, in addition to every unresolved intent. */
  static retainProjection(state: BotsState): void {
    const counts = new Map<string, Map<string, number>>()
    let settled = 0
    state.messages = [...state.messages]
      .reverse()
      .filter(row => {
        if (row.message.delivery === 'sending' || row.message.delivery === 'uncertain' || row.message.delivery === 'failed') return true
        const conversations = counts.get(row.message.botId) ?? new Map<string, number>()
        counts.set(row.message.botId, conversations)
        const count = (conversations.get(row.message.conversationId) ?? 0) + 1
        conversations.set(row.message.conversationId, count)
        return count <= MAX_MESSAGES_PER_CONVERSATION && ++settled <= MAX_MESSAGES
      })
      .reverse()
    state.seen = state.seen.slice(-MAX_SEEN_REMOTE_IDS)
  }
}
