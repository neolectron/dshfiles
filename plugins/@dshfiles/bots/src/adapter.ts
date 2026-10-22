import type {} from '@deepseek-ai/cordis'
import { botAdapterInfoSchema, type BotAdapterInfo, type BotIdentity } from './contract.js'
export type { BotAdapterInfo, BotIdentity, BotCapabilities } from './contract.js'

/** Version-one neutral port. No provider payloads, credentials or UI components cross it. */
export interface AdapterMessage {
  readonly id: string
  /** An idempotent user operation; bot replies may carry it for correlation but retain their own message IDs. */
  readonly requestId: string | null
  readonly author: 'bot' | 'user'
  readonly text: string
  readonly notice: string | null
  readonly nativeUrl: string | null
  readonly createdAt: number
  readonly updatedAt: number
}
export interface BotPollInput {
  readonly remoteBotId: string
  readonly conversationId: string
  readonly cursor: string | null
  readonly signal: AbortSignal
}
export interface BotSendInput {
  readonly remoteBotId: string
  readonly conversationId: string
  /** Original persisted link boundary, not the newly discovered reconnect baseline. */
  readonly initialCursor: string | null
  readonly requestId: string
  readonly text: string
  readonly signal: AbortSignal
}
export interface BotAdapterSession {
  readonly accountId: string
  readonly bots: readonly BotIdentity[]
  /** Bounded polling is the durable source of truth; hasMore requests another bounded page. */
  poll(input: BotPollInput): Promise<{ readonly messages: readonly AdapterMessage[]; readonly cursor: string | null; readonly hasMore: boolean }>
  send(input: BotSendInput): Promise<AdapterMessage>
  /** Never turn an ambiguous outcome into an automatic new send. */
  reconcile(input: BotSendInput): Promise<{ readonly kind: 'found'; readonly message: AdapterMessage } | { readonly kind: 'not-found' | 'unknown' }>
  close(): Promise<void>
}
export interface BotAdapter {
  readonly info: BotAdapterInfo
  readonly pollIntervalMs: number
  validateConfig(config: Readonly<Record<string, string>>): void
  open(input: { readonly config: Readonly<Record<string, string>>; readonly signal: AbortSignal }): Promise<BotAdapterSession>
}
export type BotAdapterErrorCode = 'auth-required' | 'access-denied' | 'rate-limited' | 'unavailable' | 'identity-mismatch' | 'protocol-error' | 'delivery-unknown'
/** Only deliberately safe errors may be shown outside a provider adapter. */
export class BotAdapterError extends Error {
  constructor(readonly code: BotAdapterErrorCode, message: string) { super(message); this.name = 'BotAdapterError' }
}
export interface BotAdapterRegistry {
  register(adapter: BotAdapter): () => void
  list(): readonly BotAdapter[]
  get(id: string): BotAdapter | undefined
  onChange(listener: () => void): () => void
}
export const createBotAdapterRegistry = (): BotAdapterRegistry => {
  const adapters = new Map<string, BotAdapter>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    register(adapter) {
      const info = botAdapterInfoSchema.parse(adapter.info)
      if (adapters.has(info.id)) throw new Error('Bot adapter identity is already registered.')
      if (!Number.isSafeInteger(adapter.pollIntervalMs) || adapter.pollIntervalMs < 1000 || adapter.pollIntervalMs > 300000) throw new Error('Bot polling interval must be bounded between one second and five minutes.')
      if (new Set(info.fields.map(field => field.key)).size !== info.fields.length) throw new Error('Bot adapter field keys must be unique.')
      adapters.set(info.id, adapter); notify()
      return () => { if (adapters.get(adapter.info.id) === adapter) { adapters.delete(adapter.info.id); notify() } }
    },
    list: () => [...adapters.values()],
    get: id => adapters.get(id),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context { botAdapters: BotAdapterRegistry }
}
