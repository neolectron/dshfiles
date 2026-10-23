import { isApiOwnerMissing } from '@dshfiles/dshx/api'
import { createApiClient } from '@dshfiles/dshx/client'
import { QueryClient } from '@dshfiles/plugin-ui/query'
import { describe, expect, it, vi } from 'vitest'
import { botsApi } from './api.js'
import { botsKeys, messagesQuery, snapshotQuery, type BotsClient } from './bots-queries.js'
import type { BotsSnapshot } from './contract.js'
type Messages = Awaited<ReturnType<BotsClient['messages']>>

const emptySnapshot = { revision: 1, adapters: [], connections: [], bots: [] }

describe('Bots query ownership', () => {
  it('forwards Query abort signals to snapshot and conversation reads', async () => {
    const call = vi.fn(async (_channel: string, method: string, _input: unknown, _signal?: AbortSignal) => ({
      ok: true,
      value: { version: 1, output: method.endsWith('/snapshot') ? emptySnapshot : { messages: [], hasMore: false } },
    }))
    const api = createApiClient({ get: name => (name === 'connection' ? { rpc: { call } } : undefined) }, botsApi)
    const client = new QueryClient()
    await client.fetchQuery(snapshotQuery(api))
    await client.fetchQuery(messagesQuery(api, 'bot-one', 'main', 'older-message'))
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.every(args => args[3] instanceof AbortSignal)).toBe(true)
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 1, input: { botId: 'bot-one', conversationId: 'main', limit: 100, before: 'older-message' } })
    expect(botsKeys.messages('one', 'main')).not.toEqual(botsKeys.messages('two', 'main'))
    expect(botsKeys.messages('one', 'main')).not.toEqual(botsKeys.messages('one', 'project'))
    client.clear()
  })

  it('stops polling and retries when the Bots Host owner is missing', async () => {
    const call = vi.fn(async () => {
      throw new Error('Connection request failed: HTTP 404')
    })
    const api = createApiClient({ get: name => (name === 'connection' ? { rpc: { call } } : undefined) }, botsApi)
    const client = new QueryClient()
    const options = snapshotQuery(api)
    const query = client.getQueryCache().build<BotsSnapshot, Error, BotsSnapshot, typeof botsKeys.snapshot>(client, options)
    await expect(query.fetch()).rejects.toSatisfy(isApiOwnerMissing)
    if (typeof options.refetchInterval !== 'function' || typeof options.retry !== 'function') throw new Error('Expected query-owned policy functions.')
    expect(options.refetchInterval(query)).toBe(false)
    expect(options.retry(0, query.state.error ?? new Error('Missing error'))).toBe(false)
    const conversationOptions = messagesQuery(api, 'one', 'main')
    const conversation = client.getQueryCache().build<Messages, Error, Messages, ReturnType<typeof botsKeys.messages>>(client, conversationOptions)
    await expect(conversation.fetch()).rejects.toSatisfy(isApiOwnerMissing)
    if (typeof conversationOptions.refetchInterval !== 'function' || typeof conversationOptions.retry !== 'function')
      throw new Error('Expected query-owned conversation policy functions.')
    expect(conversationOptions.refetchInterval(conversation)).toBe(false)
    expect(conversationOptions.retry(0, conversation.state.error ?? new Error('Missing error'))).toBe(false)
    expect(call).toHaveBeenCalledTimes(2)
    client.clear()
  })

  it('uses bounded Query refetch intervals rather than browser-owned polling loops', () => {
    const api = createApiClient(undefined, botsApi)
    const client = new QueryClient()
    const snapshot = snapshotQuery(api)
    const messages = messagesQuery(api, 'one', 'main')
    if (typeof snapshot.refetchInterval !== 'function' || typeof messages.refetchInterval !== 'function' || typeof snapshot.retry !== 'function')
      throw new Error('Expected query-owned policy functions.')
    expect(snapshot.refetchInterval(client.getQueryCache().build<BotsSnapshot, Error, BotsSnapshot, typeof botsKeys.snapshot>(client, snapshot))).toBe(5000)
    expect(messages.refetchInterval(client.getQueryCache().build<Messages, Error, Messages, ReturnType<typeof botsKeys.messages>>(client, messages))).toBe(3000)
    expect(snapshot.retry(1, new Error('Temporary error'))).toBe(false)
    client.clear()
  })
})
