// Scratch-only: synthetic backend grants and public Node composition. Never reads a user vault or account.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const control = 'SYNTHETIC_REMOTE_CONTROL_BACKEND_ONLY_0001'
const purpose = 'SYNTHETIC_REMOTE_AUTHORITY_BACKEND_ONLY_0001'
const wrongPurpose = 'SYNTHETIC_REMOTE_WRONG_AUTHORITY_BACKEND_ONLY_0001'
const privateBytes = 'SYNTHETIC_REMOTE_PRIVATE_BYTES_NEVER_BROWSER'
export const selectedAccountId = 'synthetic_remote_account'
export const name = 'bots-remote-values'
export const inject = ['storageDomain']
const proofName = 'bots-remote-host-proof.json'
const hostProofSchema = z.object({ localDomainOpen: z.literal(false), controlReads: z.number().int().positive() })
const scratchHome = () => {
  const home = process.env.DSH_HOME
  if (!home || !basename(home).startsWith('dshx-boot-profile-') || process.env.DSHX_BOOT_PROFILE_ROOT !== join(home, 'profiles', 'dshx-boot'))
    throw new Error('Remote Bots values require an isolated boot fixture.')
  return home
}
export async function apply(ctx) {
  const home = scratchHome()
  if ((await realpath(home)) !== home) throw new Error('Remote Bots scratch home must be canonical.')
  let controlReads = 0
  const publish = () =>
    writeFile(join(home, proofName), JSON.stringify({ localDomainOpen: ctx.get('storageDomain').get('durable_bots') !== undefined, controlReads }), {
      mode: 0o600,
    })
  ctx.provide('secretCatalogValues', {
    resolve: async ({ reference, cwd }) => {
      if (reference.alias !== 'SYNTH_REMOTE_CONTROL' || reference.environment !== 'prod' || cwd !== null)
        throw new Error('Only the synthetic remote control reference is admitted.')
      controlReads++
      await publish()
      return control
    },
  })
  ctx.on('connection/request', async (_request, _response, next) => {
    await next()
    await publish()
  })
  await publish()
}

export const browserContainsPrivateBytes = value => [control, purpose, wrongPurpose, privateBytes].some(secret => value.includes(secret))
export async function startRemoteBotsFixture() {
  const botsRequire = createRequire(new URL('../../../../plugins/@dshfiles/bots/package.json', import.meta.url))
  const dotRequire = createRequire(new URL('../../../../plugins/@dshfiles/bot-openai-dot/package.json', import.meta.url))
  const load = (owner, id) => import(pathToFileURL(owner.resolve(id)).href)
  const { createBotAdapterRegistry } = await load(botsRequire, '@dshfiles/bots/adapter')
  const { startBotsNodeService } = await load(botsRequire, '@dshfiles/bots/node')
  const { botsApi } = await load(botsRequire, '@dshfiles/bots/api')
  const { JsonText } = await load(botsRequire, '@dshfiles/dshx/api')
  const { createDotAdapter } = await load(dotRequire, '@dshfiles/bot-openai-dot/adapter')
  const { createDotAccountAuthorityClient, createDotAccountAuthorityHandler } = await load(dotRequire, '@dshfiles/bot-openai-dot/account-authority')
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'bots-remote-service-e2e-'))
  const identity = await lstat(root)
  let authority
  let authorityClient
  let service
  let providerCalls = 0
  let ownerCalls = 0
  let authorityCalls = 0
  const authorityServer = createServer((request, response) => {
    authorityCalls++
    if (!authority) {
      response.writeHead(503)
      response.end()
      return
    }
    void authority.handler(request, response)
  })
  let closed
  const close = () => {
    closed ??= (async () => {
      let failed = false
      for (const step of [
        async () => {
          await service?.close()
        },
        async () => {
          authorityClient?.close()
        },
        async () => {
          authority?.close()
        },
        async () => {
          authorityServer.closeAllConnections()
          if (authorityServer.listening) await new Promise((resolve, reject) => authorityServer.close(error => (error ? reject(error) : resolve())))
        },
        async () => {
          const current = await lstat(root)
          assert.equal(dirname(root), parent)
          assert.ok(basename(root).startsWith('bots-remote-service-e2e-'))
          assert.equal(await realpath(root), root)
          assert.deepEqual([current.dev, current.ino], [identity.dev, identity.ino])
          await rm(root, { recursive: true })
        },
      ]) {
        try {
          await step()
        } catch {
          failed = true
        }
      }
      if (failed) throw new Error('Remote Bots synthetic resource cleanup failed.')
    })()
    return closed
  }
  try {
    await new Promise((resolve, reject) => {
      authorityServer.once('error', reject)
      authorityServer.listen(0, '127.0.0.1', () => {
        authorityServer.off('error', reject)
        resolve()
      })
    })
    const { port } = z.object({ port: z.number().int().positive() }).parse(authorityServer.address())
    const authorityOrigin = `http://127.0.0.1:${port}`
    authority = createDotAccountAuthorityHandler({
      expectedOrigin: authorityOrigin,
      accountIds: [selectedAccountId],
      acceptRisks: true,
      resolveBearerToken: async () => purpose,
      accountAccess: {
        readAccessToken: async () => {
          ownerCalls++
          throw new Error(privateBytes)
        },
      },
    })
    authorityClient = createDotAccountAuthorityClient({ origin: authorityOrigin, resolveBearerToken: async () => wrongPurpose })
    const registry = createBotAdapterRegistry()
    registry.register(
      createDotAdapter({
        accountAccess: authorityClient,
        fetch: async () => {
          providerCalls++
          throw new Error(privateBytes)
        },
      }),
    )
    const storageRoot = join(root, 'service')
    service = await startBotsNodeService({ storageRoot, registry, bearerToken: control })
    const serviceOrigin = new URL(service.origin).origin
    return {
      serviceOrigin,
      authorityOrigin,
      close,
      async verifyOwnership(homeRoot) {
        assert.ok(basename(homeRoot).startsWith('dshx-boot-profile-'))
        const proof = JsonText.parse(await readFile(join(homeRoot, proofName), 'utf8'), hostProofSchema)
        assert.equal(proof.localDomainOpen, false)
        const names = await readdir(homeRoot, { recursive: true })
        assert.equal(
          names.some(file => basename(file) === 'durable_bots.json' || basename(file) === 'bots-fixture-remote.json'),
          false,
        )
        const response = await fetch(`${serviceOrigin}/v1/snapshot`, {
          headers: { authorization: `Bearer ${control}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        })
        assert.equal(response.status, 200)
        const validated = await botsApi.methods.snapshot.output['~standard'].validate(await response.json())
        assert.equal(validated.issues, undefined)
        const snapshot = validated.value
        assert.equal(snapshot.connections.length, 1)
        assert.equal(snapshot.connections[0].status, 'auth-required')
        assert.equal(snapshot.bots.length, 0)
        assert.ok(authorityCalls >= 1)
        assert.equal(ownerCalls, 0)
        assert.equal(providerCalls, 0)
        const disk = await readFile(join(storageRoot, 'durable_bots.json'), 'utf8')
        assert.ok(disk.includes(selectedAccountId))
        assert.equal(browserContainsPrivateBytes(disk), false)
        assert.equal(browserContainsPrivateBytes(JSON.stringify(snapshot)), false)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
