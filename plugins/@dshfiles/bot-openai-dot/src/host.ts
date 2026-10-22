// SPDX-License-Identifier: AGPL-3.0-only
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import { defineHost } from '@dshfiles/dshx/host'
import { createDotAdapter } from './adapter.js'

export default defineHost({
  name: '@dshfiles/bot-openai-dot',
  inject: ['botAdapters'],
  setup: ctx => {
    const registry = ctx.get('botAdapters')
    if (!registry) throw new Error('The Bots adapter registry must be loaded before the Dot adapter.')
    const adapter = createDotAdapter({
      resolveSecret: referenceText => SecretReferenceResolver.resolve({
        referenceText, values: ctx.get('secretCatalogValues'), environmentValue: undefined,
      }),
    })
    ctx.effect(() => registry.register(adapter), 'bot-openai-dot: adapter')
  },
})
