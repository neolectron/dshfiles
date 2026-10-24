import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonText } from '@dshfiles/dshx/api'
import { createHostApiClient } from '@dshfiles/dshx/host'
import { createTestHost } from '@dshfiles/dshx/testing'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecretReferenceResolution } from '@dshfiles/credential-port'
import { createBotAdapterRegistry, type BotAdapter } from './adapter.js'
import { botsApi } from './api.js'
import { botsSnapshotSchema } from './contract.js'
import { botsHostConfigSchema } from './host-config.js'
import definition from './host.js'
import { startBotsNodeService } from './node.js'

const token = 'synthetic-host-to-node-service-token-test-only'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(options: { origin?: string; credential?: string | Error } = {}) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'bots-host-service-'))
  const identity = await lstat(root)
  cleanup.push(async () => {
    const current = await lstat(root)
    expect(dirname(root)).toBe(parent)
    expect(basename(root).startsWith('bots-host-service-')).toBe(true)
    expect(await realpath(root)).toBe(root)
    expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
    await rm(root, { recursive: true })
  })
  let sends = 0
  let remoteCloses = 0
  let localOpens = 0
  let polled: () => void = () => undefined
  const firstPoll = new Promise<void>(resolve => {
    polled = resolve
  })
  const adapter: BotAdapter = {
    info: { id: 'bridge-fixture', version: 1, name: 'Synthetic bridge', description: '', risk: 'Synthetic only', fields: [] },
    pollIntervalMs: 60000,
    validateConfig: () => undefined,
    open: async () => ({
      accountId: 'synthetic-account',
      bots: [
        {
          remoteId: 'synthetic-remote',
          name: 'Synthetic bridge bot',
          description: '',
          nativeUrl: null,
          capabilities: { text: true, attachments: false, approvals: false, activity: false },
          conversations: [{ id: 'conversation', title: 'Synthetic', historyScope: 'since-link', initialCursor: 'baseline' }],
        },
      ],
      poll: async () => {
        polled()
        return {
          cursor: 'incoming',
          hasMore: false,
          messages: [
            { id: 'incoming', requestId: null, author: 'bot', text: 'Synthetic incoming only', notice: null, nativeUrl: null, createdAt: 1, updatedAt: 1 },
          ],
        }
      },
      send: async input => {
        sends++
        return {
          id: `remote-${input.requestId}`,
          requestId: input.requestId,
          author: 'user',
          text: input.text,
          notice: null,
          nativeUrl: null,
          createdAt: 2,
          updatedAt: 2,
        }
      },
      reconcile: async () => ({ kind: 'unknown' }),
      close: async () => {
        remoteCloses++
      },
    }),
  }
  const registry = createBotAdapterRegistry()
  registry.register(adapter)
  const service = await startBotsNodeService({ storageRoot: join(root, 'service'), registry, bearerToken: token })
  cleanup.push(() => service.close())
  const hostRoot = join(root, 'host')
  await mkdir(hostRoot, { mode: 0o700 })
  const host = await createTestHost()
  cleanup.push(() => host.dispose())
  await host.ctx.plugin(Storage)
  await host.ctx.plugin(StorageJson, { root: hostRoot })
  await host.ctx.plugin(StorageDomain, { backend: 'json' })
  const resolutions: SecretReferenceResolution[] = []
  let credential: string | Error = options.credential ?? token
  host.ctx.provide('secretCatalogValues', {
    resolve: async input => {
      resolutions.push(input)
      if (credential instanceof Error) throw credential
      return credential
    },
  })
  const plugin = await host.mount(definition, {
    packageId: '@dshfiles/bots',
    config: {
      mode: 'service',
      serviceOrigin: options.origin ?? service.origin,
      serviceTokenReference: 'secret:SYNTHETIC_BOTS_SERVICE@prod',
    },
  })
  host.ctx.botAdapters.register({
    ...adapter,
    open: async () => {
      localOpens++
      throw new Error('Local worker must never open in service mode')
    },
  })
  const api = createHostApiClient(host.ctx, botsApi, '@dshfiles/bots')
  return {
    host,
    plugin,
    service,
    api,
    firstPoll,
    hostRoot,
    resolutions,
    counts: () => ({ sends, remoteCloses, localOpens }),
    setCredential: (value: string | Error) => {
      credential = value
    },
  }
}

describe('Bots Host to standalone service ownership', () => {
  it('delegates the existing Host API to one remote owner without opening local storage or workers', async () => {
    const test = await fixture()
    const connected = await test.api.connect({ adapterId: 'bridge-fixture', label: 'Synthetic', config: {}, acceptRisks: true })
    const bot = connected.bots[0]!
    await test.firstPoll
    const input = { botId: bot.id, conversationId: 'conversation', requestId: randomUUID(), text: 'Synthetic Host bridge outbound only' }
    const sent = await test.api.send(input)
    expect((await test.api.send(input)).id).toBe(sent.id)
    expect(test.counts()).toEqual({ sends: 1, remoteCloses: 0, localOpens: 0 })
    await expect
      .poll(
        async () =>
          (await test.api.messages({ botId: bot.id, conversationId: 'conversation', limit: 50 })).messages.some(row => row.text === 'Synthetic incoming only'),
        { timeout: 2000 },
      )
      .toBe(true)
    await test.api.markRead({ botId: bot.id, conversationId: 'conversation', throughMessageId: sent.id })
    expect(test.host.ctx.storageDomain.get('durable_bots')).toBeUndefined()
    expect(await readdir(test.hostRoot)).toEqual([])
    expect(test.resolutions[0]).toEqual({ reference: { alias: 'SYNTHETIC_BOTS_SERVICE', environment: 'prod' }, cwd: null })
    expect(JSON.stringify(await test.api.snapshot())).not.toContain(token)
    await test.plugin.dispose()
    expect(test.counts().remoteCloses).toBe(0)
    const response = await fetch(`${test.service.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(JsonText.parse(await response.text(), botsSnapshotSchema).connections[0]?.status).toBe('connected')
    await test.service.close()
    expect(test.counts().remoteCloses).toBe(1)
  })

  it('never falls back to a local engine when the configured service is unavailable', async () => {
    const test = await fixture()
    await test.service.close()
    await expect(test.api.snapshot()).rejects.toThrow()
    expect(test.resolutions).toHaveLength(1)
    expect(test.counts().localOpens).toBe(0)
    expect(test.host.ctx.storageDomain.get('durable_bots')).toBeUndefined()
    expect(await readdir(test.hostRoot)).toEqual([])
  })

  it('rejects unsafe placement before resolving credentials and never opens the local domain', async () => {
    const test = await fixture({ origin: 'http://PRIVATE_ORIGIN_CANARY.invalid' })
    const error = await test.api.snapshot().catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('PRIVATE_ORIGIN_CANARY')
    expect(test.resolutions).toHaveLength(0)
    expect(test.counts().localOpens).toBe(0)
    expect(test.host.ctx.storageDomain.get('durable_bots')).toBeUndefined()
    expect(await readdir(test.hostRoot)).toEqual([])
  })

  it('resolves the canonical service reference afresh and redacts missing or rotated credentials', async () => {
    const test = await fixture()
    await test.api.snapshot()
    test.setCredential(new Error('PRIVATE_CREDENTIAL_CANARY'))
    const error = await test.api.snapshot().catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('PRIVATE_CREDENTIAL_CANARY')
    test.setCredential('synthetic-wrong-service-token-never-real')
    await expect(test.api.snapshot()).rejects.toThrow()
    test.setCredential(token)
    expect((await test.api.snapshot()).connections).toHaveLength(0)
    expect(test.resolutions).toHaveLength(4)
    expect(test.counts().localOpens).toBe(0)
    expect(botsHostConfigSchema.parse(undefined)).toEqual({ mode: 'local', serviceOrigin: '', serviceTokenReference: '' })
    expect(botsHostConfigSchema.safeParse({ mode: 'service', serviceTokenReference: 'RAW_CREDENTIAL_CANARY' }).success).toBe(false)
    expect(botsHostConfigSchema.safeParse({ serviceOrigin: test.service.origin }).success).toBe(false)
    expect(botsHostConfigSchema.safeParse({ mode: 'service' }).success).toBe(false)
  })
})
