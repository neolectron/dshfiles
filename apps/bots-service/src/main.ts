#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { startBotsNodeService } from '@dshfiles/bots/node'

const configSchema = z.object({
  storageRoot: z.string().min(1).refine(isAbsolute),
  tokenFile: z.string().min(1).refine(isAbsolute),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(8787),
})

// A private mounted file, not argv, a URL, an inherited provider token or a browser profile.
async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 32 || info.size > 514) throw new Error('Invalid service credential file')
    if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error('Invalid service credential owner')
    const bytes = Buffer.alloc(515)
    const result = await file.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 514) throw new Error('Service credential exceeds bound')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead))
    return value.replace(/\r?\n$/u, '')
  } finally {
    await file.close()
  }
}

let service: Awaited<ReturnType<typeof startBotsNodeService>> | undefined
let stopping: Promise<void> | undefined
let stopRequested = false
function stop() {
  stopping ??= (async () => {
    const deadline = setTimeout(() => {
      process.stderr.write('Bots service shutdown could not be confirmed. Storage ownership was not reclaimed.\n')
      process.exit(1)
    }, 10000)
    deadline.unref()
    try {
      await service?.close()
    } catch {
      process.stderr.write('Bots service shutdown failed safely. Inspect storage ownership before restarting.\n')
      process.exitCode = 1
    } finally {
      clearTimeout(deadline)
    }
  })()
  return stopping
}

function requestStop() {
  stopRequested = true
  if (service !== undefined) void stop()
}
process.once('SIGINT', requestStop)
process.once('SIGTERM', requestStop)

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(
      'Usage: bots-service\nRequired: BOTS_SERVICE_DATA_DIR (private dedicated root), BOTS_SERVICE_TOKEN_FILE (private service credential)\nOptional: BOTS_SERVICE_HOST=127.0.0.1, BOTS_SERVICE_PORT=8787\nNo provider adapters are configured by this runner.\n',
    )
    return
  }
  if (process.argv.length !== 2) throw new Error('Unsupported CLI arguments')
  const config = configSchema.parse({
    storageRoot: process.env.BOTS_SERVICE_DATA_DIR,
    tokenFile: process.env.BOTS_SERVICE_TOKEN_FILE,
    host: process.env.BOTS_SERVICE_HOST,
    port: process.env.BOTS_SERVICE_PORT,
  })
  const bearerToken = await readToken(config.tokenFile)
  // Providers are explicit composition. An unconfigured standalone service never creates a replacement bot.
  const registry = createBotAdapterRegistry()
  service = await startBotsNodeService({ storageRoot: config.storageRoot, bearerToken, registry, host: config.host, port: config.port })
  if (stopRequested) await stop()
  else process.stdout.write(`${JSON.stringify({ status: 'listening', origin: service.origin, adapters: 'none-configured' })}\n`)
}
try {
  await main()
} catch {
  process.stderr.write('Bots service could not start. Check explicit data directory, private credential file and listen settings.\n')
  process.exitCode = 1
  await stop()
}
