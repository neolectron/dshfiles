import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { JsonText } from '@dshfiles/dshx/api'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createBotAdapterRegistry, type BotAdapter, type BotSendInput } from './adapter.js'
import { botMessageSchema, botsSnapshotSchema } from './contract.js'
import { startBotsNodeService } from './node.js'

const token = 'synthetic-node-runtime-service-token-only'
const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of [...cleanup].reverse()) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  cleanup.clear()
  expect(failures).toHaveLength(0)
})
const directory = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-bots-node-'))
  const identity = await lstat(parent)
  cleanup.add(async () => {
    expect(dirname(parent)).toBe(tmpdir())
    expect(basename(parent).startsWith('dsh-bots-node-')).toBe(true)
    expect(await realpath(parent)).toBe(parent)
    const current = await lstat(parent)
    expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
    await rm(parent, { recursive: true, force: true })
  })
  return parent
}
const fixtureAdapter = () => {
  const sends: BotSendInput[] = []
  let opens = 0
  let closes = 0
  let aborted = 0
  let markPolled: () => void = () => undefined
  const pollStarted = new Promise<void>(resolve => {
    markPolled = resolve
  })
  const adapter: BotAdapter = {
    info: { id: 'synthetic-node', version: 1, name: 'Synthetic Node fixture', description: '', risk: 'Synthetic only', fields: [] },
    pollIntervalMs: 1000,
    validateConfig: () => undefined,
    open: async ({ signal }) => {
      opens++
      signal.throwIfAborted()
      return {
        accountId: 'synthetic-account',
        bots: [
          {
            remoteId: 'synthetic-bot',
            name: 'Synthetic',
            description: '',
            nativeUrl: null,
            capabilities: { text: true, attachments: false, approvals: false, activity: false },
            conversations: [{ id: 'conversation', title: 'Synthetic', historyScope: 'since-link', initialCursor: 'baseline' }],
          },
        ],
        poll: async input => {
          markPolled()
          return new Promise(resolve =>
            input.signal.addEventListener(
              'abort',
              () => {
                aborted++
                resolve({ messages: [], cursor: input.cursor, hasMore: false })
              },
              { once: true },
            ),
          )
        },
        send: async input => {
          sends.push(input)
          return {
            id: `remote-${input.requestId}`,
            requestId: input.requestId,
            author: 'user',
            text: input.text,
            notice: null,
            nativeUrl: null,
            createdAt: 1,
            updatedAt: 1,
          }
        },
        reconcile: async () => ({ kind: 'unknown' }),
        close: async () => {
          closes++
        },
      }
    },
  }
  const registry = createBotAdapterRegistry()
  registry.register(adapter)
  return { registry, sends, pollStarted, counts: () => ({ opens, closes, aborted }) }
}
const start = async (root: string, registry = createBotAdapterRegistry()) => {
  const service = await startBotsNodeService({ storageRoot: root, registry, bearerToken: token })
  cleanup.add(service.close)
  return service
}
const call = (origin: string, path: string, body?: z.infer<ReturnType<typeof z.json>>) => {
  const options: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  }
  if (body !== undefined) options.body = JSON.stringify(body)
  return fetch(`${origin}${path}`, options)
}

describe('Bots durable standalone Node ownership', () => {
  it('creates a private dedicated root and persists real JSON plus request tombstones through close/reopen', async () => {
    const root = join(await directory(), 'service')
    const adapter = fixtureAdapter()
    const first = await start(root, adapter.registry)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(root, '.bots-service-root-v1'), 'utf8')).toBe('dshfiles-bots-service-root-v1\n')
    const connected = await call(first.origin, '/v1/connect', { adapterId: 'synthetic-node', label: 'Synthetic', config: {}, acceptRisks: true })
    const snapshot = JsonText.parse(await connected.text(), botsSnapshotSchema)
    const bot = snapshot.bots[0]
    if (bot === undefined) throw new Error('Synthetic connection failed')
    const input = { botId: bot.id, conversationId: 'conversation', requestId: randomUUID(), text: 'Synthetic durable send' }
    const sent = JsonText.parse(await (await call(first.origin, '/v1/send', input)).text(), botMessageSchema)
    expect(sent.delivery).toBe('sent')
    await adapter.pollStarted
    await first.close()
    await first.close()
    expect(adapter.counts().closes).toBe(adapter.counts().opens)
    expect(adapter.counts().aborted).toBe(adapter.counts().opens)
    expect((await readdir(root)).includes('.bots-service-owner')).toBe(false)
    const second = await start(root, adapter.registry)
    const replay = JsonText.parse(await (await call(second.origin, '/v1/send', input)).text(), botMessageSchema)
    expect(replay.id).toBe(sent.id)
    expect(adapter.sends).toHaveLength(1)
    const page = await call(second.origin, '/v1/messages', { botId: bot.id, conversationId: 'conversation' })
    expect(JsonText.parse(await page.text(), z.object({ messages: z.array(botMessageSchema), hasMore: z.boolean() })).messages[0]?.id).toBe(sent.id)
  })

  it('admits only one simultaneous owner and never reclaims an existing lease', async () => {
    const root = join(await directory(), 'service')
    await mkdir(root, { mode: 0o700 })
    const attempts = await Promise.allSettled([start(root), start(root)])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    const owner = attempts.find(attempt => attempt.status === 'fulfilled')
    if (owner?.status !== 'fulfilled') throw new Error('Missing synthetic owner')
    await expect(start(root)).rejects.toThrow('storage ownership')
    await owner.value.close()
    await mkdir(join(root, '.bots-service-owner'), { mode: 0o700 })
    await expect(start(root)).rejects.toThrow('storage ownership')
    expect((await lstat(join(root, '.bots-service-owner'))).isDirectory()).toBe(true)
  })

  it('refuses symlink and normalized aliases without writing through them', async () => {
    const parent = await directory()
    const root = join(parent, 'service')
    await mkdir(root, { mode: 0o700 })
    const alias = join(parent, 'alias')
    await symlink(root, alias)
    for (const path of [alias, `${root}/`, `${root}/../service`, join(alias, 'nested')]) await expect(start(path)).rejects.toThrow('storage ownership')
    expect(await readdir(root)).toEqual([])
  })

  it('refuses public, non-owned and malformed roots without changing their contents', async () => {
    const parent = await directory()
    for (const kind of ['public', 'non-owned', 'malformed', 'symlink-marker']) {
      const root = join(parent, kind)
      await mkdir(root, { mode: 0o700 })
      if (kind === 'public') await chmod(root, 0o755)
      if (kind === 'non-owned') await writeFile(join(root, 'existing-dsh-data.json'), 'synthetic existing data')
      if (kind === 'malformed') await writeFile(join(root, '.bots-service-root-v1'), 'not an owned marker')
      if (kind === 'symlink-marker') await symlink(join(parent, 'absent'), join(root, '.bots-service-root-v1'))
      const before = await readdir(root)
      await expect(start(root)).rejects.toThrow('storage ownership')
      expect(await readdir(root)).toEqual(before)
    }
  })

  it('refuses malformed canonical JSON without overwriting it or leaking its content', async () => {
    const root = join(await directory(), 'corrupt')
    await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, '.bots-service-root-v1'), 'dshfiles-bots-service-root-v1\n', { mode: 0o600 })
    const data = join(root, 'durable_bots.json')
    await writeFile(data, 'PRIVATE_SYNTHETIC_INVALID_JSON')
    await expect(start(root)).rejects.toThrow(/^Bots storage ownership or runtime initialization was refused\./)
    expect(await readFile(data, 'utf8')).toBe('PRIVATE_SYNTHETIC_INVALID_JSON')
    expect((await readdir(root)).sort()).toEqual(['.bots-service-root-v1', 'durable_bots.json'])
  })

  it('validates auth, listen and explicit absolute root before creating storage', async () => {
    const parent = await directory()
    const root = join(parent, 'uncreated')
    const registry = createBotAdapterRegistry()
    await expect(startBotsNodeService({ storageRoot: root, registry, bearerToken: 'short' })).rejects.toThrow('service token')
    await expect(startBotsNodeService({ storageRoot: root, registry, bearerToken: token, port: -1 })).rejects.toThrow('listen configuration')
    for (const storageRoot of ['', '.', 'relative/service', '/', join(parent, 'absent', 'nested')]) {
      await expect(startBotsNodeService({ storageRoot, registry, bearerToken: token })).rejects.toThrow('storage ownership')
    }
    expect(await readdir(parent)).toEqual([])
  })

  it('releases its own lease after a listener startup refusal and allows a safe retry', async () => {
    const parent = await directory()
    const first = await start(join(parent, 'first'))
    const root = join(parent, 'retry')
    await expect(
      startBotsNodeService({ storageRoot: root, registry: createBotAdapterRegistry(), bearerToken: token, port: Number(new URL(first.origin).port) }),
    ).rejects.toThrow('storage ownership')
    expect((await readdir(root)).includes('.bots-service-owner')).toBe(false)
    const retried = await start(root)
    expect((await fetch(`${retried.origin}/healthz`)).status).toBe(200)
  })

  it('isolates independent roots and retains a replaced owner lease on shutdown', async () => {
    const parent = await directory()
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    const adapter = fixtureAdapter()
    const first = await start(firstRoot, adapter.registry)
    const second = await start(secondRoot)
    await call(first.origin, '/v1/connect', { adapterId: 'synthetic-node', label: 'Synthetic', config: {}, acceptRisks: true })
    const snapshot = JsonText.parse(await (await call(second.origin, '/v1/snapshot')).text(), botsSnapshotSchema)
    expect(snapshot.connections).toHaveLength(0)
    const lease = join(firstRoot, '.bots-service-owner')
    // Both resolved absolute paths belong to this fresh, identity-checked synthetic parent.
    expect(await realpath(lease)).toBe(lease)
    await rename(lease, join(firstRoot, 'old-lease'))
    await mkdir(lease, { mode: 0o700 })
    await expect(first.close()).rejects.toThrow('storage ownership')
    cleanup.delete(first.close)
    expect((await lstat(lease)).isDirectory()).toBe(true)
    expect(adapter.counts().closes).toBe(adapter.counts().opens)
  })
})
