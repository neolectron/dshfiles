import { isApiOwnerMissing, type ApiClient, type ApiContract } from '@dshfiles/dshx/api'
import { queryOptions } from '@dshfiles/plugin-ui/query'
import { botsApi } from './api.js'

export type BotsClient = typeof botsApi extends ApiContract<infer Methods> ? ApiClient<Methods> : never
export const botsKeys = {
  all: ['bots'] as const,
  snapshot: ['bots', 'snapshot'] as const,
  messages: (botId: string, conversationId: string, before?: string) => ['bots', 'messages', botId, conversationId, before ?? 'latest'] as const,
}
export const snapshotQuery = (api: BotsClient) =>
  queryOptions({
    queryKey: botsKeys.snapshot,
    queryFn: ({ signal }) => api.snapshot(undefined, { signal }),
    retry: (count, error) => !isApiOwnerMissing(error) && count < 1,
    refetchInterval: query => (isApiOwnerMissing(query.state.error) ? false : 5000),
  })
export const messagesQuery = (api: BotsClient, botId: string, conversationId: string, before?: string) =>
  queryOptions({
    queryKey: botsKeys.messages(botId, conversationId, before),
    queryFn: ({ signal }) => {
      const input: Parameters<BotsClient['messages']>[0] = { botId, conversationId, limit: 100 }
      if (before !== undefined) input.before = before
      return api.messages(input, { signal })
    },
    retry: (count, error) => !isApiOwnerMissing(error) && count < 1,
    refetchInterval: query => (isApiOwnerMissing(query.state.error) ? false : 3000),
  })
