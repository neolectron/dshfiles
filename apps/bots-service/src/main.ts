#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { BotAdapterError, createBotAdapterRegistry, type BotAdapter } from '@dshfiles/bots/adapter'
import { AuthAttemptManager, createDotEnrollmentEndpoints } from '@dshfiles/bot-openai-dot/auth'
import { createDotBrowserSession } from '@dshfiles/bot-openai-dot/browser-session'
import { startBotsNodeService } from '@dshfiles/bots/node'
import { createDotAdapter, type DotDependencies } from '@dshfiles/bot-openai-dot/adapter'
import { createDotAccountAuthorityClient, DotAccountAuthorityProtocol } from '@dshfiles/bot-openai-dot/account-authority'
import { SecretReferenceResolver } from '@dshfiles/credential-port'
import { readCredentialFile } from './credential-file.js'

// Concrete providers register at the app composition root, never in the engine or UI.
const adapterFactories = new Map<string, (dependencies: DotDependencies) => BotAdapter>([['openai-dot', createDotAdapter]])

const configSchema = z
  .object({
    storageRoot: z.string().min(1).refine(isAbsolute),
    tokenFile: z.string().min(1).refine(isAbsolute),
    host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    port: z.coerce.number().int().min(0).max(65535).default(8787),
    adapters: z
      .string()
      .default('')
      .transform(text => (text === '' ? [] : text.split(',').map(name => name.trim())))
      .refine(names => new Set(names).size === names.length && names.every(name => adapterFactories.has(name))),
    credentialsFile: z.string().refine(isAbsolute).optional(),
    dotAuthorityOrigin: z.string().min(1).optional(),
    dotAuthorityTokenFile: z.string().min(1).refine(isAbsolute).optional(),
    dotBrowserExecutable: z.string().min(1).refine(isAbsolute).optional(),
    dotBrowserProfileParent: z.string().min(1).refine(isAbsolute).optional(),
    dotBrowserAccountId: DotAccountAuthorityProtocol.input.shape.accountId.optional(),
  })
  .superRefine((value, context) => {
    const browserSelected = value.dotBrowserExecutable !== undefined || value.dotBrowserProfileParent !== undefined || value.dotBrowserAccountId !== undefined
    if (
      browserSelected &&
      (value.dotBrowserExecutable === undefined ||
        value.dotBrowserProfileParent === undefined ||
        value.dotBrowserAccountId === undefined ||
        value.dotAuthorityOrigin === undefined ||
        value.dotAuthorityTokenFile === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Browser transport requires an explicit executable, private profile parent, one selected account and private account authority.',
      })
    const authoritySelected = value.dotAuthorityOrigin !== undefined || value.dotAuthorityTokenFile !== undefined
    if (authoritySelected) {
      if (value.dotAuthorityOrigin === undefined || value.dotAuthorityTokenFile === undefined)
        context.addIssue({ code: 'custom', message: 'Dot account authority requires both its origin and private service-key file.' })
      if (!value.adapters.includes('openai-dot') || value.credentialsFile !== undefined)
        context.addIssue({ code: 'custom', message: 'Dot account authority requires explicit Dot selection and excludes the legacy reference file.' })
    } else if (value.adapters.length > 0 && value.credentialsFile === undefined)
      context.addIssue({ code: 'custom', message: 'Configured providers require an explicit service credential-reference file.' })
  })

// A private mounted file, not argv, a URL, an inherited provider token or a browser profile.
async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
let accountAuthority: ReturnType<typeof createDotAccountAuthorityClient> | undefined
let browserSession: ReturnType<typeof createDotBrowserSession> | undefined
let enrollment: AuthAttemptManager | undefined
let browserCleanup: Promise<void> | undefined
function closeBrowserResources(): Promise<void> {
  browserCleanup ??= (async () => {
    let failed = false
    for (const close of [() => enrollment?.close(), () => browserSession?.close()]) {
      try {
        await close()
      } catch {
        failed = true
      }
    }
    if (failed) throw new Error('Browser resource cleanup was not confirmed.')
  })()
  return browserCleanup
}
let stopping: Promise<void> | undefined
let stopRequested = false
const startup = new AbortController()
const registrations: Array<() => void> = []
function stop() {
  stopping ??= (async () => {
    const deadline = setTimeout(() => {
      process.stderr.write('Bots service shutdown could not be confirmed. Storage ownership was not reclaimed.\n')
      process.exit(1)
    }, 20000)
    deadline.unref()
    try {
      let failed = false
      const cleanups: Array<() => void | Promise<void>> = [
        () => service?.close(),
        closeBrowserResources,
        () => accountAuthority?.close(),
        ...registrations.splice(0).reverse(),
      ]
      for (const cleanup of cleanups) {
        try {
          await cleanup()
        } catch {
          failed = true
        }
      }
      if (failed) throw new Error('Owned service cleanup was not confirmed.')
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
  startup.abort()
  if (service !== undefined) void stop()
}
process.once('SIGINT', requestStop)
process.once('SIGTERM', requestStop)

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(
      'Usage: bots-service\nRequired: BOTS_SERVICE_DATA_DIR (private dedicated root), BOTS_SERVICE_TOKEN_FILE (private control-service credential)\nOptional: BOTS_SERVICE_HOST=127.0.0.1, BOTS_SERVICE_PORT=8787\nProviders: BOTS_SERVICE_ADAPTERS=openai-dot requires either BOTS_SERVICE_CREDENTIALS_FILE (legacy private reference map) or both BOTS_SERVICE_DOT_AUTHORITY_ORIGIN and BOTS_SERVICE_DOT_AUTHORITY_TOKEN_FILE (separate private authority service key). These modes cannot be combined. Optional browser transport: set all of BOTS_SERVICE_DOT_BROWSER_EXECUTABLE, BOTS_SERVICE_DOT_BROWSER_PROFILE_PARENT and BOTS_SERVICE_DOT_BROWSER_ACCOUNT_ID with account-authority mode. Human admission stays inside DSH; no existing browser profile is imported. Default: no adapters.\n',
    )
    return
  }
  if (process.argv.length !== 2) throw new Error('Unsupported CLI arguments')
  const config = configSchema.parse({
    storageRoot: process.env.BOTS_SERVICE_DATA_DIR,
    tokenFile: process.env.BOTS_SERVICE_TOKEN_FILE,
    host: process.env.BOTS_SERVICE_HOST,
    port: process.env.BOTS_SERVICE_PORT,
    adapters: process.env.BOTS_SERVICE_ADAPTERS,
    credentialsFile: process.env.BOTS_SERVICE_CREDENTIALS_FILE,
    dotAuthorityOrigin: process.env.BOTS_SERVICE_DOT_AUTHORITY_ORIGIN,
    dotAuthorityTokenFile: process.env.BOTS_SERVICE_DOT_AUTHORITY_TOKEN_FILE,
    dotBrowserExecutable: process.env.BOTS_SERVICE_DOT_BROWSER_EXECUTABLE,
    dotBrowserProfileParent: process.env.BOTS_SERVICE_DOT_BROWSER_PROFILE_PARENT,
    dotBrowserAccountId: process.env.BOTS_SERVICE_DOT_BROWSER_ACCOUNT_ID,
  })
  // The public factory validates the origin before any credential file or durable root is opened.
  const resolveAuthorityBearer = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    startup.signal.throwIfAborted()
    if (config.dotAuthorityTokenFile === undefined) throw new Error('Missing authority service key')
    const value = DotAccountAuthorityProtocol.bearer.parse(await readToken(config.dotAuthorityTokenFile))
    signal.throwIfAborted()
    startup.signal.throwIfAborted()
    if (value === bearerToken) throw new Error('Authority and control-service credentials must differ')
    return value
  }
  if (config.dotAuthorityOrigin !== undefined)
    accountAuthority = createDotAccountAuthorityClient({ origin: config.dotAuthorityOrigin, resolveBearerToken: resolveAuthorityBearer })
  const bearerToken = await readToken(config.tokenFile)
  if (stopRequested) return stop()
  if (accountAuthority !== undefined) await resolveAuthorityBearer(startup.signal)
  if (stopRequested) return stop()
  // Providers are explicit composition. An unconfigured standalone service never creates a replacement bot.
  const registry = createBotAdapterRegistry()
  if (config.adapters.length > 0) {
    let dependencies: DotDependencies
    if (accountAuthority !== undefined) {
      // oxlint-disable-next-line antislop/no-passthrough-variable -- Deferred account reads must retain this admitted authority generation, not consult a mutable shutdown handle.
      const authority = accountAuthority
      const executable = config.dotBrowserExecutable
      const profileParent = config.dotBrowserProfileParent
      const accountId = config.dotBrowserAccountId
      if (executable !== undefined && profileParent !== undefined && accountId !== undefined) {
        enrollment = new AuthAttemptManager({
          open: async signal => {
            await browserSession?.close()
            signal.throwIfAborted()
            const next = createDotBrowserSession({ chromiumExecutable: executable, privateProfileParentPath: profileParent })
            browserSession = next
            return next.viewer(signal)
          },
          onComplete: async signal => {
            if (browserSession === undefined) throw new Error('No browser session was requested.')
            await browserSession.complete(signal)
          },
        })
        dependencies = {
          accountAccess: {
            readAccessToken: (selected, signal) => {
              if (selected !== accountId) throw new BotAdapterError('auth-required', 'This browser transport is bound to one explicitly selected DSH account.')
              return authority.readAccessToken(selected, signal)
            },
          },
          fetch: (input, init) => {
            if (browserSession === undefined)
              return Promise.reject(
                new BotAdapterError('auth-required', 'Complete the human browser check in DSH Dot connection before connecting this account.'),
              )
            return browserSession.fetch(input, init)
          },
        }
      } else dependencies = { accountAccess: authority }
    } else {
      if (config.credentialsFile === undefined) throw new Error('Provider credential references were not configured')
      const values = await readCredentialFile(config.credentialsFile)
      dependencies = {
        resolveSecret: referenceText => SecretReferenceResolver.resolve({ referenceText, values, environmentValue: undefined }),
      }
    }
    if (stopRequested) return stop()
    for (const name of config.adapters) {
      const factory = adapterFactories.get(name)
      if (factory === undefined) throw new Error('Unsupported provider')
      const adapter = factory(dependencies)
      registrations.push(
        registry.register(
          enrollment === undefined
            ? adapter
            : {
                ...adapter,
                info: {
                  ...adapter.info,
                  description: 'Complete the human browser check in DSH Dot connection, then connect your existing Dot here. No ChatGPT tab is required.',
                  fields: adapter.info.fields.map(field =>
                    field.key === 'accountId'
                      ? { ...field, help: `Configured DSH account: ${config.dotBrowserAccountId}. Complete Dot connection first.` }
                      : field,
                  ),
                },
              },
        ),
      )
    }
  }
  if (stopRequested) return stop()
  const serviceOptions = {
    storageRoot: config.storageRoot,
    bearerToken,
    registry,
    host: config.host,
    port: config.port,
    beforeStorageRelease: closeBrowserResources,
  }
  service =
    enrollment === undefined
      ? await startBotsNodeService(serviceOptions)
      : await startBotsNodeService({ ...serviceOptions, privateEndpoints: createDotEnrollmentEndpoints(enrollment) })
  if (stopRequested) await stop()
  else
    process.stdout.write(
      `${JSON.stringify({ status: 'listening', origin: service.origin, adapters: config.adapters.length === 0 ? 'none-configured' : config.adapters.join(',') })}\n`,
    )
}
try {
  await main()
} catch {
  if (!stopRequested) {
    process.stderr.write('Bots service could not start. Check the data directory, listen settings, selected adapters and private credential files.\n')
    process.exitCode = 1
  }
  await stop()
}
