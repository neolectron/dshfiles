import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { createHostApiClient } from '@dshfiles/dshx/host'
import { createTestHost, mountPlugin } from '@dshfiles/dshx/testing'
import { describe, expect, it } from 'vitest'
import type { BotAdapter } from './adapter.js'
import { botsApi } from './api.js'
import hostDefinition from './host.js'

const minimalAdapter = (): BotAdapter => ({
  info: { id: 'minimal-host', version: 1, name: 'Minimal Host fixture', description: '', risk: 'Test fixture', fields: [] },
  pollIntervalMs: 60000,
  validateConfig: () => undefined,
  open: async () => ({
    accountId: 'minimal-account',
    bots: [
      {
        remoteId: 'minimal-bot',
        name: 'Minimal bot',
        description: '',
        nativeUrl: null,
        capabilities: { text: true, attachments: false, approvals: false, activity: false },
        conversations: [{ id: 'minimal-conversation', title: 'Conversation', historyScope: 'since-link', initialCursor: 'first-cursor' }],
      },
    ],
    poll: async input => ({ messages: [], cursor: input.cursor, hasMore: false }),
    send: async input => ({
      id: `remote-${input.requestId}`,
      requestId: input.requestId,
      author: 'user',
      text: input.text,
      notice: null,
      nativeUrl: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    reconcile: async () => ({ kind: 'unknown' }),
    close: async () => undefined,
  }),
})

const openHost = async (root: string) => {
  const host = await createTestHost()
  try {
    await host.ctx.plugin(Storage)
    await host.ctx.plugin(StorageJson, { root })
    await host.ctx.plugin(StorageDomain, { backend: 'json' })
    const plugin = await mountPlugin(host, hostDefinition, { packageId: '@dshfiles/bots' })
    const api = createHostApiClient(host.ctx, botsApi, '@dshfiles/bots')
    // Calling through the supported API waits for the setup effect's single durable opening.
    await api.snapshot()
    return { host, plugin, api }
  } catch (error) {
    await host.dispose()
    throw error
  }
}
const removeFixture = async (root: string): Promise<void> => {
  // Only this test's freshly-created absolute temporary directory is ever deleted.
  expect(dirname(root)).toBe(tmpdir())
  expect(basename(root).startsWith('dsh-bots-host-')).toBe(true)
  await rm(root, { recursive: true, force: true })
}

describe('Bots real Cordis/storageDomain Host boundary', () => {
  it('provides a per-Host registry, shares it with API child contexts, and isolates independent Hosts', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-bots-host-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-bots-host-'))
    let first: Awaited<ReturnType<typeof openHost>> | undefined
    let second: Awaited<ReturnType<typeof openHost>> | undefined
    try {
      first = await openHost(firstRoot)
      second = await openHost(secondRoot)
      expect(first.host.ctx.botAdapters).not.toBe(second.host.ctx.botAdapters)
      first.host.ctx.botAdapters.register(minimalAdapter())
      second.host.ctx.botAdapters.register(minimalAdapter())
      const connected = await first.api.connect({ adapterId: 'minimal-host', label: 'First', config: {}, acceptRisks: true })
      expect(connected.connections[0]?.status).toBe('connected')
      expect(connected.bots).toHaveLength(1)
      expect((await second.api.snapshot()).connections).toHaveLength(0)
      expect((await second.api.connect({ adapterId: 'minimal-host', label: 'Second', config: {}, acceptRisks: true })).bots).toHaveLength(1)
      await first.plugin.dispose()
      expect(first.host.ctx.storageDomain.get('durable_bots')).toBeUndefined()
      expect((await second.api.snapshot()).connections[0]?.label).toBe('Second')
    } finally {
      await first?.host.dispose()
      await second?.host.dispose()
      await removeFixture(firstRoot)
      await removeFixture(secondRoot)
    }
  })

  it('persists messages, read boundaries and request tombstones through real JSON storage reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bots-host-'))
    let first: Awaited<ReturnType<typeof openHost>> | undefined
    let second: Awaited<ReturnType<typeof openHost>> | undefined
    try {
      first = await openHost(root)
      first.host.ctx.botAdapters.register(minimalAdapter())
      const connected = await first.api.connect({ adapterId: 'minimal-host', label: 'Restart fixture', config: {}, acceptRisks: true })
      const bot = connected.bots[0]!
      const request = { botId: bot.id, conversationId: 'minimal-conversation', requestId: randomUUID(), text: 'Only synthetic fixture text' }
      const sent = await first.api.send(request)
      expect(sent.delivery).toBe('sent')
      await first.api.markRead({ botId: bot.id, conversationId: request.conversationId, throughMessageId: sent.id })
      const revision = (await first.api.snapshot()).revision
      await first.host.dispose()
      first = undefined
      second = await openHost(root)
      expect((await second.api.snapshot()).revision).toBeGreaterThan(revision)
      second.host.ctx.botAdapters.register(minimalAdapter())
      await second.api.reconnect({ connectionId: connected.connections[0]!.id })
      const restored = await second.api.messages({ botId: bot.id, conversationId: request.conversationId, limit: 50 })
      expect(restored.messages).toHaveLength(1)
      expect(restored.messages[0]?.id).toBe(sent.id)
      expect((await second.api.send(request)).id).toBe(sent.id)
      await expect(second.api.send({ ...request, text: 'Changed body' })).rejects.toThrow('different destination or message body')
      const refused = await second.host.connection.requestApi({
        packageId: '@dshfiles/bots',
        apiId: 'bots',
        method: 'remove',
        version: 1,
        input: { connectionId: connected.connections[0]!.id, confirm: false },
      })
      expect(await refused.text()).toContain('error')
      expect((await second.api.snapshot()).connections).toHaveLength(1)
    } finally {
      await first?.host.dispose()
      await second?.host.dispose()
      await removeFixture(root)
    }
  })

  it('serves credential grants through the shared API with explicit consent and safe revocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bots-host-'))
    let opened: Awaited<ReturnType<typeof openHost>> | undefined
    try {
      opened = await openHost(root)
      const base = minimalAdapter()
      let bindings = 0
      opened.host.ctx.botAdapters.register({
        ...base,
        info: { ...base.info, credentialManagement: { label: 'Allow synthetic saves', description: 'Synthetic test only.' } },
        open: async input => ({
          ...(await base.open(input)),
          bindCredentialReferences: async ({ publish }) => {
            publish.assertActive()
            bindings++
          },
        }),
      })
      const connected = await opened.api.connect({ adapterId: base.info.id, label: 'API consent', config: {}, acceptRisks: true })
      const connectionId = connected.connections[0]!.id
      expect(connected.connections[0]?.credentialManagement).toBe(false)
      expect(bindings).toBe(0)
      await expect(opened.api.setCredentialManagement({ connectionId, enabled: true })).rejects.toThrow('explicit additional')
      expect((await opened.api.setCredentialManagement({ connectionId, enabled: true, acceptRisks: true })).connections[0]?.credentialManagement).toBe(true)
      expect(bindings).toBe(1)
      const revoked = await opened.api.setCredentialManagement({ connectionId, enabled: false })
      expect(revoked.connections[0]?.credentialManagement).toBe(false)
      expect(revoked.bots).toHaveLength(1)
      expect(bindings).toBe(1)
    } finally {
      await opened?.host.dispose()
      await removeFixture(root)
    }
  })
})
