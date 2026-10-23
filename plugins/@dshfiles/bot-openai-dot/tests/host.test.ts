// SPDX-License-Identifier: AGPL-3.0-only
import { Context } from '@deepseek-ai/cordis'
import type { SecretReferenceResolution } from '@dshfiles/credential-port'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { expect, it } from 'vitest'
import host from '../src/host.js'

it('registers through the real Cordis Host lifecycle and unregisters on disposal without credentials', async () => {
  const ctx = new Context()
  const registry = createBotAdapterRegistry()
  ctx.provide('botAdapters', registry)
  const fork = ctx.plugin({ name: host.name, inject: [...host.inject], apply: host.setup })
  await fork
  expect(registry.list().map(adapter => adapter.info.id)).toEqual(['openai-dot'])
  expect(ctx.get('botAdapters')).toBe(registry)
  await fork.dispose()
  expect(registry.list()).toEqual([])
})

it('resolves the optional Host credential port through real Cordis without hard-requiring vault activation', async () => {
  const ctx = new Context()
  const registry = createBotAdapterRegistry()
  const resolutions: SecretReferenceResolution[] = []
  ctx.provide('botAdapters', registry)
  ctx.provide('secretCatalogValues', {
    async resolve(input) {
      resolutions.push(input)
      return input.reference.alias === 'DOT_ACCESS' ? 'MALFORMED_SYNTHETIC_JWT' : 'SYNTHETIC_SESSION_ONLY'
    },
  })
  const fork = ctx.plugin({ name: host.name, inject: [...host.inject], apply: host.setup })
  await fork
  try {
    const adapter = registry.get('openai-dot')
    if (!adapter) throw new Error('Expected registered Dot adapter')
    // An invalid synthetic JWT rejects before any HTTP request; successful resolution is the boundary under test.
    await expect(
      adapter.open({
        config: { accessTokenRef: 'secret:DOT_ACCESS@prod', sessionTokenRef: 'secret:DOT_SESSION@test' },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'auth-required',
      message: 'Dot needs supported ChatGPT credentials; reconnect using secret references.',
    })
    expect(resolutions).toEqual([
      { reference: { alias: 'DOT_ACCESS', environment: 'prod' }, cwd: null },
      { reference: { alias: 'DOT_SESSION', environment: 'test' }, cwd: null },
    ])
  } finally {
    await fork.dispose()
  }
})
