import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { defineHost } from '@dshfiles/dshx/host'
import { PluginApiError } from '@dshfiles/dshx/api'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import type { z } from 'zod'
import { botsHostConfigSchema } from './host-config.js'
import { createBotsHttpClient, type BotsServiceOperations } from './http-client.js'
import type { BotAdapterRegistry } from './adapter.js'
import { botsApi } from './api.js'
import { BotsEngine } from './engine.js'
import { botsDomain, BotsStorage } from './store.js'

interface OpenedBots {
  readonly operations: BotsServiceOperations
  readonly close: () => Promise<void>
}
interface HostBots {
  readonly config: z.infer<typeof botsHostConfigSchema>
  opening?: Promise<OpenedBots>
}

// API handlers and setup get different child Contexts. The per-Host registry is their shared ownership key.
// Unlike a process-wide opening promise, two independent Hosts can never share data or a provider session.
const services = new WeakMap<BotAdapterRegistry, HostBots>()
const openBots = async (ctx: Context, registry: BotAdapterRegistry, config: HostBots['config']): Promise<OpenedBots> => {
  // Placement is explicit. A bad/unreachable service must never open a local store or provider worker.
  if (config.mode === 'service') {
    const client = createBotsHttpClient({
      origin: config.serviceOrigin,
      resolveBearerToken: async () => {
        const token = await SecretReferenceResolver.resolve({
          referenceText: config.serviceTokenReference,
          values: ctx.get('secretCatalogValues'),
          environmentValue: process.env.DSH_BOTS_SERVICE_TOKEN,
        })
        if (token === undefined) throw new PluginApiError('The Bots service needs a Host-side service credential.')
        return token
      },
    })
    return { operations: client, close: () => client.close() }
  }
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
    operations: engine,
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
  const service = services.get(registry)
  if (service === undefined) throw new PluginApiError('The Bots Host is not active.')
  service.opening ??= openBots(ctx, registry, service.config)
  return service.opening
}
const withBots = async <Result>(ctx: Context, operation: (operations: BotsServiceOperations) => Result | Promise<Result>): Promise<Result> => {
  try {
    return await operation((await openedFor(ctx)).operations)
  } catch (error) {
    if (error instanceof PluginApiError) throw error
    // Unexpected adapter/framework failures must not reach even Host diagnostics with raw payloads or credentials.
    throw new PluginApiError('The bot operation could not be completed safely. Reconnect or retry explicitly.')
  }
}

const api = botsApi.host({
  snapshot: ({ ctx }) => withBots(ctx, operations => operations.snapshot()),
  connect: ({ ctx, input }) => withBots(ctx, operations => operations.connect(input)),
  reconnect: ({ ctx, input }) => withBots(ctx, operations => operations.reconnect(input)),
  setCredentialManagement: ({ ctx, input }) => withBots(ctx, operations => operations.setCredentialManagement(input)),
  disconnect: ({ ctx, input }) => withBots(ctx, operations => operations.disconnect(input)),
  remove: ({ ctx, input }) => withBots(ctx, operations => operations.remove(input)),
  messages: ({ ctx, input }) => withBots(ctx, operations => operations.messages(input)),
  send: ({ ctx, input }) => withBots(ctx, operations => operations.send(input)),
  markRead: ({ ctx, input }) => withBots(ctx, operations => operations.markRead(input)),
})

export default defineHost({
  name: '@dshfiles/bots',
  inject: ['storageDomain'],
  Config: botsHostConfigSchema,
  apis: [api],
  setup: (ctx, config) => {
    const registry = createBotAdapterRegistry()
    services.set(registry, { config })
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
