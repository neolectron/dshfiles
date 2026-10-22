import { describe, expect, it } from 'vitest'
import { createBotAdapterRegistry, type BotAdapter } from './adapter.js'
import { botIdentitySchema } from './contract.js'

const adapter = (id = 'independent-provider'): BotAdapter => ({
  info: { id, version: 1, name: 'Independent provider', description: 'No OpenAI policy in the registry.', risk: '', fields: [] },
  pollIntervalMs: 1000,
  validateConfig: () => undefined,
  open: async () => ({ accountId: 'account', bots: [], poll: async () => ({ messages: [], cursor: null, hasMore: false }), send: async () => { throw new Error('Not supported') }, reconcile: async () => ({ kind: 'unknown' }), close: async () => undefined }),
})

describe('versioned bot adapter registration', () => {
  it('registers independent providers without provider branches and disposes only its own registration', () => {
    const registry = createBotAdapterRegistry()
    let changes = 0
    const unsubscribe = registry.onChange(() => { changes += 1 })
    const first = adapter()
    const remove = registry.register(first)
    expect(registry.get(first.info.id)).toBe(first)
    expect(registry.list()).toEqual([first])
    expect(() => registry.register(adapter())).toThrow('already registered')
    remove()
    const replacement = adapter()
    registry.register(replacement)
    remove()
    expect(registry.get(first.info.id)).toBe(replacement)
    unsubscribe()
    expect(changes).toBe(3)
  })
  it('keeps registry ownership isolated between Host instances', () => {
    const first = createBotAdapterRegistry()
    const second = createBotAdapterRegistry()
    first.register(adapter())
    expect(second.list()).toEqual([])
  })
  it('rejects unbounded polling and duplicate configuration field keys', () => {
    const registry = createBotAdapterRegistry()
    expect(() => registry.register({ ...adapter(), pollIntervalMs: 0 })).toThrow('bounded')
    const field = { key: 'secretRef', label: 'Reference', kind: 'secret-reference' as const, required: true, help: '' }
    expect(() => registry.register({ ...adapter(), info: { ...adapter().info, fields: [field, field] } })).toThrow('unique')
  })
})

it('rejects executable and credential-bearing application links at the shared boundary', () => {
  const identity = { remoteId: 'remote', name: 'Bot', description: '', nativeUrl: 'https://example.com/bot', capabilities: { text: true, attachments: false, approvals: false, activity: false }, conversations: [{ id: 'main', title: 'Main', historyScope: 'full', initialCursor: null }] }
  expect(botIdentitySchema.safeParse(identity).success).toBe(true)
  expect(botIdentitySchema.safeParse({ ...identity, nativeUrl: 'javascript:alert(1)' }).success).toBe(false)
  expect(botIdentitySchema.safeParse({ ...identity, nativeUrl: 'https://user:password@example.com/bot' }).success).toBe(false)
})
