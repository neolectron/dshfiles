import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { defineHost } from '@dshfiles/dshx/host'
import { PluginApiError } from '@dshfiles/dshx/api'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import type { BotAdapterRegistry } from './adapter.js'
import { botsApi } from './api.js'
import { BotsEngine } from './engine.js'
import { botsDomain, BotsStorage } from './store.js'

interface OpenedBots {
  readonly engine: BotsEngine
  readonly close: () => Promise<void>
}

// API handlers and setup get different child Contexts. The per-Host registry is their shared ownership key.
// Unlike a process-wide opening promise, two independent Hosts can never share data or a provider session.
const services = new WeakMap<BotAdapterRegistry, Promise<OpenedBots>>()
const openBots = async (ctx: Context, registry: BotAdapterRegistry): Promise<OpenedBots> => {
  const storage = ctx.get('storageDomain')
  if (storage === undefined) throw new PluginApiError('Bot storage is unavailable.')
  let domain
  try {
    domain = await storage.open(botsDomain)
  } catch {
    throw new PluginApiError('Bot storage could not be opened safely.')
  }
  let engine: BotsEngine
  try {
    engine = new BotsEngine({ store: BotsStorage.create(domain.table('state')), registry })
    await engine.start()
  } catch {
    await domain.close().catch(() => undefined)
    throw new PluginApiError('Bot storage could not be initialized safely.')
  }
  return {
    engine,
    close: async () => {
      try {
        await engine.close()
      } finally {
        await domain.close()
      }
    },
  }
}

const openedFor = (ctx: Context, provided?: BotAdapterRegistry): Promise<OpenedBots> => {
  // During setup the providing fiber is not active yet, so strict ctx.get correctly cannot see its own service.
  const registry = provided ?? ctx.get('botAdapters')
  if (registry === undefined) throw new PluginApiError('The Bots Host is not active.')
  let opening = services.get(registry)
  if (opening === undefined) {
    opening = openBots(ctx, registry)
    services.set(registry, opening)
  }
  return opening
}
const withEngine = async <Result>(ctx: Context, operation: (engine: BotsEngine) => Result | Promise<Result>): Promise<Result> => {
  try {
    return await operation((await openedFor(ctx)).engine)
  } catch (error) {
    if (error instanceof PluginApiError) throw error
    // Unexpected adapter/framework failures must not reach even Host diagnostics with raw payloads or credentials.
    throw new PluginApiError('The bot operation could not be completed safely. Reconnect or retry explicitly.')
  }
}

const api = botsApi.host({
  snapshot: ({ ctx }) => withEngine(ctx, engine => engine.snapshot()),
  connect: ({ ctx, input }) => withEngine(ctx, engine => engine.connect(input)),
  reconnect: ({ ctx, input }) => withEngine(ctx, engine => engine.reconnect(input)),
  setCredentialManagement: ({ ctx, input }) => withEngine(ctx, engine => engine.setCredentialManagement(input)),
  disconnect: ({ ctx, input }) => withEngine(ctx, engine => engine.disconnect(input)),
  remove: ({ ctx, input }) => withEngine(ctx, engine => engine.remove(input)),
  messages: ({ ctx, input }) => withEngine(ctx, engine => engine.messages(input)),
  send: ({ ctx, input }) => withEngine(ctx, engine => engine.send(input)),
  markRead: ({ ctx, input }) => withEngine(ctx, engine => engine.markRead(input)),
})

export default defineHost({
  name: '@dshfiles/bots',
  inject: ['storageDomain'],
  apis: [api],
  setup: ctx => {
    const registry = createBotAdapterRegistry()
    ctx.provide('botAdapters', registry)
    ctx.effect(() => {
      const opening = openedFor(ctx, registry)
      // Failed initialization is retained and reported by every API call, rather than silently opening a new store.
      void opening.catch(() => undefined)
      return async () => {
        try {
          await (await opening).close()
        } catch {
          throw new PluginApiError('Bot workers or storage could not be closed safely.')
        } finally {
          services.delete(registry)
        }
      }
    }, 'bots: durable Host workers')
  },
})
