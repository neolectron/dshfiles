// SPDX-License-Identifier: AGPL-3.0-only
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import { createHostApiClient, defineHost } from '@dshfiles/dshx/host'
import { secretCatalogApi } from '@dshfiles/secret-catalog/api'
import { createDotAdapter } from './adapter.js'

export default defineHost({
  name: '@dshfiles/bot-openai-dot',
  inject: ['botAdapters'],
  setup: ctx => {
    const registry = ctx.get('botAdapters')
    if (!registry) throw new Error('The Bots adapter registry must be loaded before the Dot adapter.')
    const catalog = createHostApiClient(ctx, secretCatalogApi, '@dshfiles/bot-openai-dot')
    const adapter = createDotAdapter({
      store: {
        create: async ({ alias, value }) => {
          await catalog.create({
            alias,
            value,
            cwd: null,
            scope: 'global',
            environment: 'prod',
            valueMode: 'manual',
            name: 'DSH managed Dot session',
            source: '@dshfiles/bot-openai-dot',
          })
        },
        update: async ({ alias, environment, value }) => {
          await catalog.update({ alias, environment, value, cwd: null, scope: 'global' })
        },
      },
      resolveSecret: referenceText =>
        SecretReferenceResolver.resolve({
          referenceText,
          values: ctx.get('secretCatalogValues'),
          environmentValue: undefined,
        }),
    })
    ctx.effect(() => registry.register(adapter), 'bot-openai-dot: adapter')
  },
})
