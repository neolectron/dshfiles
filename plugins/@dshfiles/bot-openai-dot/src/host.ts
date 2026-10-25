// SPDX-License-Identifier: AGPL-3.0-only
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import { createHostApiClient, defineHost } from '@dshfiles/dshx/host'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { startDotAccountAuthorityListener } from './account-authority-listener.js'
import { createDotEnrollmentProxy } from './enrollment-proxy.js'
import { registerDotAuthRoutes } from './auth-transport.js'
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
      const origin = parseAccountAuthorityOrigin(config.authorityOrigin)
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
      const disposers: Array<() => void | Promise<void>> = [
        () => {
          for (const broker of brokers.values()) broker.close()
        },
      ]
      const dispose = async () => {
        let failed = false
        for (const remove of disposers.splice(0).reverse()) {
          try {
            await remove()
          } catch {
            failed = true
          }
        }
        if (failed) throw new Error('Dot connection cleanup was not confirmed.')
      }
      const authorityFor = (actualOrigin: string) =>
        createDotAccountAuthorityHandler({
          expectedOrigin: actualOrigin,
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
        if (config.authorityTransport === 'loopback') {
          const listener = await startDotAccountAuthorityListener({ origin: config.authorityOrigin, createHandler: authorityFor })
          disposers.push(listener.close)
        } else {
          const webServer = ctx.get('webServer')
          if (webServer === undefined || webServer.protocol !== origin.protocol) throw new Error('Native account authority transport is unavailable.')
          const authority = authorityFor(config.authorityOrigin)
          disposers.push(() => authority.close())
          disposers.push(webServer.register({ kind: 'exact', path: DotAccountAuthorityProtocol.path, handler: authority.handler }))
        }
        if (config.enrollmentServiceOrigin !== '') {
          const connection = ctx.get('connection')
          if (connection === undefined) throw new Error('Private browser admission is unavailable.')
          const proxy = createDotEnrollmentProxy({
            origin: config.enrollmentServiceOrigin,
            resolveBearerToken: () =>
              SecretReferenceResolver.resolve({
                referenceText: config.enrollmentTokenReference,
                values: ctx.get('secretCatalogValues'),
                environmentValue: config.enrollmentTokenReference === '' ? process.env.DSH_BOTS_SERVICE_TOKEN : undefined,
              }),
          })
          try {
            disposers.push(
              registerDotAuthRoutes(connection, proxy, { browserOrigin: config.browserOrigin, additionalBrowserOrigins: config.additionalBrowserOrigins }),
            )
          } catch (error) {
            await proxy.close()
            throw error
          }
        }
        disposers.push(registry.register(createDotAdapter({ accountAccess })))
        return dispose
      } catch {
        await dispose().catch(() => undefined)
        throw new Error('Dot account/browser setup failed safely. Verify private browser cleanup before retrying.')
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
