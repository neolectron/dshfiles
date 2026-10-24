// SPDX-License-Identifier: AGPL-3.0-only
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import { createHostApiClient, defineHost } from '@dshfiles/dshx/host'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createDotAdapter, type DotAccountAccess } from './adapter.js'
import { dotHostConfigSchema } from './host-config.js'
import { createDotAccountAuthorityHandler } from './account-authority-server.js'
import { DotAccountAuthorityProtocol } from './account-authority-contract.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'

export default defineHost({
  name: '@dshfiles/bot-openai-dot',
  inject: ['botAdapters'],
  Config: dotHostConfigSchema,
  setup: async (ctx, config = dotHostConfigSchema.parse(undefined)) => {
    const registry = ctx.get('botAdapters')
    if (!registry) throw new Error('The Bots adapter registry must be loaded before the Dot adapter.')
    if (config.mode === 'account') {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) throw new Error('Account authority requires the native WebServer.')
      const origin = parseAccountAuthorityOrigin(config.authorityOrigin)
      if (webServer.protocol !== origin.protocol) throw new Error('Account authority transport does not match the native listener.')
      const { OpenAIAccountAccess } = await import('@dshfiles/ai-accounts/openai-account-access')
      const brokers = new Map(
        config.accountIds.map(accountId => [accountId, OpenAIAccountAccess.create({ accountId, purpose: 'openai-dot', acceptRisks: true })]),
      )
      const accountAccess: DotAccountAccess = {
        readAccessToken: async (accountId, signal) => {
          const broker = brokers.get(accountId)
          if (broker === undefined) throw new Error('Account was not explicitly admitted')
          return broker.withAccessToken(signal, async token => token)
        },
      }
      const authority = createDotAccountAuthorityHandler({
        expectedOrigin: config.authorityOrigin,
        accountIds: config.accountIds,
        acceptRisks: true,
        accountAccess,
        resolveBearerToken: () =>
          SecretReferenceResolver.resolve({
            referenceText: config.authorityTokenReference,
            values: ctx.get('secretCatalogValues'),
            environmentValue: config.authorityTokenReference === '' ? process.env.DSH_DOT_ACCOUNT_AUTHORITY_TOKEN : undefined,
          }),
      })
      try {
        const removeRoute = webServer.register({ kind: 'exact', path: DotAccountAuthorityProtocol.path, handler: authority.handler })
        try {
          const removeAdapter = registry.register(createDotAdapter({ accountAccess }))
          return () => {
            removeRoute()
            removeAdapter()
            authority.close()
            for (const broker of brokers.values()) broker.close()
          }
        } catch (error) {
          removeRoute()
          throw error
        }
      } catch {
        authority.close()
        for (const broker of brokers.values()) broker.close()
        throw new Error('Account authority could not register safely')
      }
    }
    const { secretCatalogApi } = await import('@dshfiles/secret-catalog/api')
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
      resolveSecret: referenceText => SecretReferenceResolver.resolve({ referenceText, values: ctx.get('secretCatalogValues'), environmentValue: undefined }),
    })
    return registry.register(adapter)
  },
})
