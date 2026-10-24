// SPDX-License-Identifier: AGPL-3.0-only
import { createDotAdapter, type DotDependencies } from '@dshfiles/bot-openai-dot/adapter'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { describe, expect, it, vi } from 'vitest'

describe('public standalone Dot adapter module', () => {
  it('exports only the existing factory as a runtime value', async () => {
    const module = await import('@dshfiles/bot-openai-dot/adapter')
    expect(Object.keys(module)).toEqual(['createDotAdapter'])
  })

  it('constructs, validates references and registers without resolving credentials or requesting a provider', () => {
    const resolveSecret = vi.fn<DotDependencies['resolveSecret']>(async () => undefined)
    const fetch = vi.fn<NonNullable<DotDependencies['fetch']>>(async () => {
      throw new Error('Synthetic unexpected provider request')
    })
    const adapter = createDotAdapter({ resolveSecret, fetch })
    const registry = createBotAdapterRegistry()
    const unregister = registry.register(adapter)
    expect(registry.get('openai-dot')).toBe(adapter)
    expect(adapter.info.version).toBe(1)
    expect(adapter.info).not.toHaveProperty('credentialManagement')
    expect(adapter.info.fields.map(field => [field.key, field.kind, field.required])).toEqual([
      ['accessTokenRef', 'secret-reference', true],
      ['sessionTokenRef', 'secret-reference', true],
    ])
    expect(() => adapter.validateConfig({ accessTokenRef: 'secret:SYNTHETIC_ACCESS', sessionTokenRef: 'secret:SYNTHETIC_SESSION' })).not.toThrow()
    expect(() => adapter.validateConfig({ accessTokenRef: 'secret:SYNTHETIC_ACCESS' })).toThrow('exactly two valid secret reference fields')
    expect(() => adapter.validateConfig({ accessTokenRef: 'synthetic-raw-value', sessionTokenRef: 'secret:SYNTHETIC_SESSION' })).toThrow(
      'exactly two valid secret reference fields',
    )
    unregister()
    expect(registry.list()).toHaveLength(0)
    expect(resolveSecret).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
