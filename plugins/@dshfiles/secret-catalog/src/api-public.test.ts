import type { Context } from '@deepseek-ai/cordis'
import { isApiOwnerMissing, type ApiClientInput, type ApiClientOutput } from '@dshfiles/dshx/api'
import { createHostApiClient, defineHost } from '@dshfiles/dshx/host'
import { createTestHost } from '@dshfiles/dshx/testing'
import { secretCatalogApi } from '@dshfiles/secret-catalog/api'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { secretCatalogApi as ownerContract } from './api.js'
import { createSecretCatalogOperations } from './secret-operations.js'

// Owner-side fixture: the real scalar operations, with no process or vault access.
const catalogFixture = () => {
  let writes = 0
  let stdinOnly = true
  let globalWrites = true
  let pluginCaller = true
  const operations = createSecretCatalogOperations(async request => {
    if (request.args[0] === 'print') return '[]'
    writes++
    globalWrites &&= request.args.includes('--global') && request.cwd === null
    const expected = writes === 1 ? 'synthetic-host-create-value' : 'synthetic-host-update-value'
    stdinOnly &&= request.stdin === expected && !request.args.includes(expected) && !request.captureStdout
    return ''
  })
  const owner = defineHost({
    apis: [
      ownerContract.host({
        list: async ({ input }) => [...(await operations.list(input.cwd))],
        reveal: ({ input }) => operations.reveal(input.alias, input.scope, input.cwd, input.environment),
        copy: ({ input }) => operations.copy(input.alias, input.scope, input.cwd, input.environment),
        machine: () => ({ id: 'synthetic-host', name: 'synthetic-host' }),
        create: ({ input, caller }) => {
          pluginCaller &&= caller.kind === 'plugin' && caller.packageId === '@test/catalog-consumer'
          return operations.create(input)
        },
        update: ({ input, caller }) => {
          pluginCaller &&= caller.kind === 'plugin' && caller.packageId === '@test/catalog-consumer'
          return operations.update(input)
        },
        removeAlias: ({ input }) => operations.removeAlias(input.alias, input.scope, input.cwd),
        deleteItem: ({ input }) => operations.deleteItem(input.alias, input.scope, input.cwd, input.environment),
      }),
    ],
  })
  return { owner, checks: () => ({ twoWrites: writes === 2, noWrites: writes === 0, stdinOnly, globalWrites, pluginCaller }) }
}

// Consumer-side fixture imports only the public contract and supported SDK APIs.
// Raw synthetic scalars stay in this Host function; it returns safe booleans only.
const exerciseHostConsumer = async (ctx: Context) => {
  const client = createHostApiClient(ctx, secretCatalogApi, '@test/catalog-consumer')
  const created = await client.create({
    alias: 'SYNTHETIC_HOST_TOKEN',
    scope: 'global',
    cwd: null,
    environment: 'test',
    valueMode: 'manual',
    value: 'synthetic-host-create-value',
  })
  const updated = await client.update({
    alias: 'SYNTHETIC_HOST_TOKEN',
    scope: 'global',
    cwd: null,
    environment: 'test',
    value: 'synthetic-host-update-value',
  })
  return {
    created: created.created === true && Object.keys(created).join() === 'created',
    updated: updated.updated === true && Object.keys(updated).join() === 'updated',
  }
}

const exerciseInvalidHostInputs = async (ctx: Context) => {
  const client = createHostApiClient(ctx, secretCatalogApi, '@test/catalog-consumer')
  const input: ApiClientInput<typeof secretCatalogApi.methods.create> = {
    alias: 'SYNTHETIC_HOST_TOKEN',
    scope: 'global',
    cwd: null,
    environment: 'test',
    valueMode: 'manual',
    value: null,
  }
  const results = await Promise.all([
    client.safe.create(input),
    client.safe.create({ ...input, value: '' }),
    client.safe.create({ ...input, valueMode: 'generate', value: 'synthetic-not-allowed' }),
    client.safe.create({ ...input, value: 's'.repeat(262_145) }),
    client.safe.update({ alias: '-invalid', scope: 'project', cwd: input.cwd, environment: 'test', value: null }),
  ])
  return { allContractErrors: results.every(result => !result.ok && result.error.kind === 'contract') }
}

describe('Secret Catalog public scalar API prerequisite', () => {
  it('publishes the same typed version-1 contract without new methods or tool exposure', () => {
    expect(secretCatalogApi.owner === '@dshfiles/secret-catalog').toBe(true)
    expect(secretCatalogApi.id === ownerContract.id && secretCatalogApi.version === 1).toBe(true)
    expect(Object.keys(secretCatalogApi.methods).join() === 'list,reveal,copy,machine,create,update,removeAlias,deleteItem').toBe(true)
    expect(Object.values(secretCatalogApi.methods).every(method => method.tool === undefined)).toBe(true)
    expectTypeOf<ApiClientInput<typeof secretCatalogApi.methods.create>['value']>().toEqualTypeOf<string | null>()
    expectTypeOf<ApiClientInput<typeof secretCatalogApi.methods.update>['value']>().toEqualTypeOf<string | null>()
    expectTypeOf<ApiClientOutput<typeof secretCatalogApi.methods.create>>().toEqualTypeOf<{ created: true }>()
    expectTypeOf<ApiClientOutput<typeof secretCatalogApi.methods.update>>().toEqualTypeOf<{ updated: true }>()
  })

  it('dispatches a different Host consumer through the owner and keeps scalar values on stdin', async () => {
    const host = await createTestHost()
    try {
      const fixture = catalogFixture()
      await host.mount(fixture.owner, { packageId: '@dshfiles/secret-catalog' })
      const output = await exerciseHostConsumer(host.ctx)
      expect(output.created && output.updated).toBe(true)
      const checks = fixture.checks()
      expect(checks.twoWrites && checks.stdinOnly && checks.globalWrites && checks.pluginCaller).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('validates public Host inputs before any operation writes', async () => {
    const host = await createTestHost()
    try {
      const fixture = catalogFixture()
      await host.mount(fixture.owner, { packageId: '@dshfiles/secret-catalog' })
      expect((await exerciseInvalidHostInputs(host.ctx)).allContractErrors).toBe(true)
      expect(fixture.checks().noWrites).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('reports owner missing before mount and after unload, without a CLI or network', async () => {
    const host = await createTestHost()
    try {
      const client = createHostApiClient(host.ctx, secretCatalogApi, '@test/catalog-consumer')
      const before = await client.safe.list({ cwd: null })
      expect(!before.ok && isApiOwnerMissing(before.error)).toBe(true)
      const owner = await host.mount(catalogFixture().owner, { packageId: '@dshfiles/secret-catalog' })
      expect((await client.list({ cwd: null })).length === 0).toBe(true)
      await owner.dispose()
      const after = await client.safe.list({ cwd: null })
      expect(!after.ok && isApiOwnerMissing(after.error)).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('preserves the existing value-free Client Connection route and envelope', async () => {
    const host = await createTestHost()
    try {
      await host.mount(catalogFixture().owner, { packageId: '@dshfiles/secret-catalog' })
      const response = await host.connection.requestApi({
        packageId: '@dshfiles/secret-catalog',
        apiId: 'secret-catalog',
        method: 'list',
        version: 1,
        input: { cwd: null },
      })
      expect(response.ok).toBe(true)
      const envelope = await response.text()
      expect(envelope.includes('"ok":true') && envelope.includes('"output":[]')).toBe(true)
      expect(host.connection.routeCount === 8).toBe(true)
    } finally {
      await host.dispose()
    }
  })
})
