import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { startBotsServer, type BotsServerOptions } from './server.js'
import { validateBotsServerConfiguration } from './server-config.js'
import { botsDomain, BotsStorage } from './store.js'

const markerName = '.bots-service-root-v1'
const markerContent = 'dshfiles-bots-service-root-v1\n'
const leaseName = '.bots-service-owner'
const storageName = `${botsDomain.name}.json`
const unavailable = (): Error => new Error('Bots storage ownership or runtime initialization was refused. Check the dedicated root and retained owner lease.')
const sameIdentity = (first: Stats, second: Stats): boolean => first.dev === second.dev && first.ino === second.ino
const inspect = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw unavailable()
  }
}
const assertPrivate = (stat: Stats, directory: boolean): void => {
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid !== uid || (directory ? !stat.isDirectory() || (stat.mode & 0o077) !== 0 : !stat.isFile() || stat.nlink !== 1))
    throw unavailable()
}
const assertRoot = async (root: string, identity: Stats): Promise<void> => {
  const current = await lstat(root)
  assertPrivate(current, true)
  if (!sameIdentity(identity, current) || (await realpath(root)) !== root) throw unavailable()
}
const checkContents = async (root: string): Promise<boolean> => {
  const names = await readdir(root)
  if (names.length === 0) return false
  if (!names.includes(markerName) || names.some(name => ![markerName, leaseName, storageName].includes(name))) throw unavailable()
  for (const name of names) {
    if (name === leaseName) continue
    const stat = await lstat(join(root, name))
    assertPrivate(stat, false)
    if (name === markerName && stat.size !== Buffer.byteLength(markerContent)) throw unavailable()
  }
  const marker = await open(join(root, markerName), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if ((await marker.readFile('utf8')) !== markerContent) throw unavailable()
  } finally {
    await marker.close()
  }
  return true
}

/** Own one explicit private root. A stale or replaced lease is never automatically reclaimed. */
const ownRoot = async (root: string): Promise<() => Promise<void>> => {
  if (!isAbsolute(root) || resolve(root) !== root || root === dirname(root)) throw unavailable()
  const parent = dirname(root)
  if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory()) throw unavailable()
  if ((await inspect(root)) === undefined) {
    // The parent must already exist. Never create arbitrary ancestor directories.
    try {
      await mkdir(root, { mode: 0o700 })
    } catch {
      throw unavailable()
    }
  }
  const rootIdentity = await lstat(root)
  assertPrivate(rootIdentity, true)
  await assertRoot(root, rootIdentity)
  const marked = await checkContents(root)
  const lease = join(root, leaseName)
  // mkdir is cross-process exclusive. No PID heuristics or stale-owner stealing.
  await mkdir(lease, { mode: 0o700 })
  const leaseIdentity = await lstat(lease)
  const release = async (): Promise<void> => {
    await assertRoot(root, rootIdentity)
    await checkContents(root)
    const current = await lstat(lease)
    assertPrivate(current, true)
    if (!sameIdentity(leaseIdentity, current) || (await realpath(lease)) !== lease || (await readdir(lease)).length !== 0) throw unavailable()
    // Resolved absolute root and both inode identities were checked immediately above.
    await rmdir(lease)
  }
  try {
    await assertRoot(root, rootIdentity)
    if (!marked) await writeFile(join(root, markerName), markerContent, { flag: 'wx', mode: 0o600 })
    await checkContents(root)
    return release
  } catch {
    // Only our unchanged, empty directory may be removed; unknown cleanup retains the lease.
    await release().catch(() => undefined)
    throw unavailable()
  }
}

export interface BotsNodeServiceOptions extends Omit<BotsServerOptions, 'store'> {
  readonly storageRoot: string
  /** Dispose composition-owned resources after HTTP/engine stop, before releasing exclusive storage ownership. */
  readonly beforeStorageRelease?: () => Promise<void>
}
/** Standalone durable composition, without a DSH application, profile, Connection or provider-specific policy. */
export async function startBotsNodeService(options: BotsNodeServiceOptions): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  validateBotsServerConfiguration(options)
  let release: (() => Promise<void>) | undefined
  const ctx = new Context()
  let server: Awaited<ReturnType<typeof startBotsServer>> | undefined
  let domain: StorageDomain.Domain<typeof botsDomain> | undefined
  try {
    release = await ownRoot(options.storageRoot)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: options.storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    domain = await ctx.storageDomain.open(botsDomain)
    server = await startBotsServer({ ...options, store: BotsStorage.create(domain.table('state')) })
  } catch {
    // Do not release ownership if storage cleanup is ambiguous.
    try {
      await server?.close()
      if (release !== undefined) await options.beforeStorageRelease?.()
      await domain?.close()
      await ctx.fiber.dispose()
      await release?.()
    } catch {
      /* Retain the lease for explicit operator reconciliation. */
    }
    throw unavailable()
  }
  const runtime = { server, domain, release }
  let closed: Promise<void> | undefined
  return {
    origin: runtime.server.origin,
    close: () => {
      closed ??= (async () => {
        try {
          await runtime.server.close()
          await options.beforeStorageRelease?.()
          await runtime.domain.close()
          await ctx.fiber.dispose()
          await runtime.release()
        } catch {
          throw unavailable()
        }
      })()
      return closed
    },
  }
}
