// SPDX-License-Identifier: AGPL-3.0-only
import { Context } from '@deepseek-ai/cordis'
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
