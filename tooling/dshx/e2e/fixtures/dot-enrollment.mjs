// SYNTHETIC loopback-only vertical composition. No real account, vault or provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const control = 'SYNTHETIC_DOT_ENROLLMENT_CONTROL_BACKEND_ONLY_0001'
const jwt = `synthetic.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account', chatgpt_user_id: 'synthetic-human', chatgpt_account_user_id: 'synthetic-workspace-human' } })).toString('base64url')}.not-a-signature`
export const selectedAccountId = 'synthetic_dot_enrollment_account'
export const name = 'dot-enrollment-fixture'
export const inject = ['storageDomain', 'webServer', 'connection']
const proofName = 'dot-enrollment-host-proof.json'
const configName = 'dot-enrollment-service.json'
const req = createRequire(new URL('../../../../plugins/@dshfiles/bot-openai-dot/package.json', import.meta.url))
const load = id => import(pathToFileURL(req.resolve(id)).href)
export const browserContainsPrivateBytes = text => text.includes(control) || text.includes(jwt)
const scratchHome = () => {
  const home = process.env.DSH_HOME
  if (!home || !basename(home).startsWith('dshx-boot-profile-') || process.env.DSHX_BOOT_PROFILE_ROOT !== join(home, 'profiles', 'dshx-boot'))
    throw new Error('Synthetic enrollment requires an isolated scratch home.')
  return home
}
export async function apply(ctx) {
  const home = scratchHome()
  assert.equal(await realpath(home), home)
  const { JsonText } = await load('@dshfiles/dshx/api')
  const { registerDotAuthRoutes, createDotEnrollmentProxy } = await load('@dshfiles/bot-openai-dot/auth')
  const config = JsonText.parse(await readFile(join(home, configName), 'utf8'), z.object({ serviceOrigin: z.string().url() }).strict())
  let controlReads = 0
  const publish = () =>
    writeFile(join(home, proofName), JSON.stringify({ localDomainOpen: ctx.get('storageDomain').get('durable_bots') !== undefined, controlReads }), {
      mode: 0o600,
    })
  ctx.provide('secretCatalogValues', {
    resolve: async ({ reference, cwd }) => {
      if (reference.alias !== 'SYNTH_DOT_ENROLLMENT' || reference.environment !== 'prod' || cwd !== null)
        throw new Error('Only a synthetic control reference is admitted.')
      controlReads++
      await publish()
      return control
    },
  })
  const proxy = createDotEnrollmentProxy({ origin: config.serviceOrigin, resolveBearerToken: async () => control })
  const dispose = registerDotAuthRoutes(ctx.get('connection'), proxy, { browserOrigin: ctx.get('webServer').getOrigin() })
  ctx.on('connection/request', async (_request, _response, next) => {
    await next()
    await publish()
  })
  await publish()
  ctx.effect(() => dispose)
}

export async function startDotEnrollmentFixture() {
  const { AuthAttemptManager, createDotEnrollmentEndpoints } = await load('@dshfiles/bot-openai-dot/auth')
  const { DotBrowserSessionError, createDotBrowserSessionForTest, createDotBrowserLocalFixtureFactoryForTest } = await load(
    '@dshfiles/bot-openai-dot/browser-session',
  )
  const { createDotAdapter } = await load('@dshfiles/bot-openai-dot/adapter')
  const { createBotAdapterRegistry } = await load('@dshfiles/bots/adapter')
  const { startBotsNodeService } = await load('@dshfiles/bots/node')
  const { botsApi } = await load('@dshfiles/bots/api')
  const { JsonText } = await load('@dshfiles/dshx/api')
  const executable = process.env.DSHX_E2E_CHROMIUM_EXECUTABLE
  if (!executable?.startsWith('/')) throw new Error('An explicit isolated Chrome executable is required.')
  const parent = await realpath(tmpdir()),
    root = await mkdtemp(join(parent, 'dot-enrollment-e2e-')),
    identity = await lstat(root)
  const browserParent = join(root, 'browser')
  await mkdir(browserParent, { mode: 0o700 })
  const state = {
    opens: 0,
    frames: 0,
    input: 0,
    completed: 0,
    leasesClosed: 0,
    browsersClosed: 0,
    sends: 0,
    requests: 0,
    typed: false,
    cookieUsed: false,
    failures: [],
  }
  const messages = []
  let profilePath,
    controller,
    session,
    manager,
    service,
    closed,
    retainedProof = false,
    chromeRootPids = []
  const wire = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const json = value => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'synthetic_browser_owned=1; HttpOnly; SameSite=Strict' })
      response.end(
        '<!doctype html><title>SYNTHETIC DOT ENROLLMENT — NO ACCOUNT</title><body style="font:24px sans-serif;background:#173e38;color:white;padding:32px"><h1>SYNTHETIC HUMAN-ONLY BROWSER</h1><p>Local verification only. No provider or account.</p><label style="position:absolute;left:80px;top:190px">Synthetic text</label><input autofocus style="font:24px sans-serif;position:absolute;left:80px;top:230px;width:500px;height:50px" oninput="fetch(\'/typed?value=\'+encodeURIComponent(this.value))"><p style="position:absolute;left:80px;top:310px">Use the DSH “Use this session” button when ready.</p></body>',
      )
      return
    }
    if (url.pathname === '/typed') {
      state.typed = url.searchParams.get('value') === 'SYNTHETIC'
      response.end()
      return
    }
    state.requests++
    state.cookieUsed = request.headers.cookie?.includes('synthetic_browser_owned=1') === true
    if (url.pathname === '/backend-api/tbo/primary') {
      json({ selection: { thread_id: 'synthetic-thread', aeon_id: 'synthetic-dot', messaging_room_id: 'synthetic-room', available: true } })
      return
    }
    if (url.pathname === '/backend-api/tbo/by-thread/synthetic-thread') {
      json({
        status: 'active',
        id: 'synthetic-dot',
        messaging_room_id: 'synthetic-room',
        display_name: 'Synthetic Dot',
        active_root_thread_id: 'synthetic-thread',
      })
      return
    }
    if (url.pathname === '/backend-api/messaging/rooms/synthetic-room') {
      json({
        id: 'synthetic-room',
        aeon_id: 'synthetic-dot',
        type: 'DM',
        app_source: 'chatgpt:messaging',
        members: [{ account_user_id: 'synthetic-bot-member', aeon_id: 'synthetic-dot' }, { account_user_id: 'synthetic-workspace-human' }],
        latest_messages: [{ id: 'synthetic-baseline', created_at: new Date(Date.now() - 60000).toISOString() }],
      })
      return
    }
    if (url.pathname === '/backend-api/messaging/rooms/synthetic-room/messages') {
      if (request.method === 'POST') {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          try {
            const input = JSON.parse(body)
            assert.equal(input.request_id, input.idempotency_token)
            state.sends++
            const time = new Date().toISOString()
            const sent = {
              id: 'synthetic-sent',
              request_id: input.request_id,
              account_user_id: 'synthetic-workspace-human',
              created_at: time,
              updated_at: time,
              content: input.content,
            }
            messages.push(sent, {
              id: 'synthetic-reply',
              account_user_id: 'synthetic-bot-member',
              created_at: new Date(Date.now() + 1).toISOString(),
              updated_at: new Date(Date.now() + 1).toISOString(),
              content: { text: 'Synthetic reply through retained browser' },
            })
            json(sent)
          } catch {
            response.writeHead(400)
            response.end()
          }
        })
      } else {
        const index = messages.findIndex(message => message.id === url.searchParams.get('after'))
        json({ items: messages.slice(index + 1), next_cursor: '' })
      }
      return
    }
    response.writeHead(404)
    response.end()
  })
  const close = () => {
    closed ??= (async () => {
      let failed = false,
        browserGone = false
      const attempt = async run => {
        try {
          await run()
        } catch {
          failed = true
        }
      }
      await attempt(async () => {
        await manager?.close()
      })
      await attempt(async () => {
        await session?.close()
      })
      await attempt(async () => {
        assert.deepEqual(await readdir(browserParent), [])
        if (profilePath) {
          const { stdout } = await promisify(execFile)('ps', ['-eo', 'args='], { timeout: 5000 })
          assert.equal(
            stdout.split('\n').some(line => line.includes(`--user-data-dir=${profilePath}`)),
            false,
          )
        }
        browserGone = true
      })
      // A browser whose shutdown is uncertain must keep the Node owner's lease.
      if (browserGone)
        await attempt(async () => {
          await service?.close()
          if (service) {
            await assert.rejects(fetch(`${service.origin}/v1/snapshot`, { signal: AbortSignal.timeout(2000) }))
            assert.equal((await readdir(join(root, 'service'))).includes('.bots-service-owner'), false)
          }
        })
      await attempt(async () => {
        wire.closeAllConnections()
        if (wire.listening) await new Promise((resolve, reject) => wire.close(error => (error ? reject(error) : resolve())))
      })
      if (failed) throw new Error('Synthetic enrollment cleanup unconfirmed; owned root and lease retained.')
      const current = await lstat(root)
      assert.equal(dirname(root), parent)
      assert.ok(basename(root).startsWith('dot-enrollment-e2e-'))
      assert.equal(await realpath(root), root)
      assert.deepEqual([current.dev, current.ino], [identity.dev, identity.ino])
      await rm(root, { recursive: true })
      return { browsersClosed: state.browsersClosed, retainedProof, nodeClosed: true, browserProcessesGone: true, chromeRootPids, privateRootRemoved: true }
    })()
    return closed
  }
  try {
    await new Promise((resolve, reject) => {
      wire.once('error', reject)
      wire.listen(0, '127.0.0.1', resolve)
    })
    const { port } = z.object({ port: z.number().int().positive() }).parse(wire.address())
    const wireOrigin = `http://127.0.0.1:${port}`
    const factory = createDotBrowserLocalFixtureFactoryForTest(`${wireOrigin}/`)
    session = createDotBrowserSessionForTest({ chromiumExecutable: executable, privateProfileParentPath: browserParent }, async input => {
      profilePath = input.privateProfilePath
      const io = await factory(input)
      return {
        ...io,
        close: async () => {
          await io.close()
          state.browsersClosed++
        },
      }
    })
    class ObservedManager extends AuthAttemptManager {
      start(input) {
        const result = super.start(input)
        controller = result
        return result
      }
    }
    manager = new ObservedManager({
      open: async signal => {
        const viewer = await session.viewer(signal)
        state.opens++
        return {
          frame: async signal => {
            state.frames++
            try {
              return await viewer.frame(signal)
            } catch (error) {
              state.failures.push(`frame:${error instanceof DotBrowserSessionError ? error.code : 'failed'}`)
              throw error
            }
          },
          input: async (input, signal) => {
            try {
              await viewer.input(input, signal)
              state.input++
            } catch (error) {
              state.failures.push(`input:${error instanceof DotBrowserSessionError ? error.code : 'failed'}`)
              throw error
            }
          },
          close: async () => {
            await viewer.close()
            state.leasesClosed++
          },
        }
      },
      onComplete: async signal => {
        await session.complete(signal)
        state.completed++
      },
    })
    const registry = createBotAdapterRegistry()
    registry.register(
      createDotAdapter({
        accountAccess: {
          readAccessToken: async accountId => {
            assert.equal(accountId, selectedAccountId)
            return jwt
          },
        },
        fetch: (input, init) => session.fetch(input, init),
      }),
    )
    service = await startBotsNodeService({
      storageRoot: join(root, 'service'),
      registry,
      bearerToken: control,
      privateEndpoints: createDotEnrollmentEndpoints(manager),
    })
    const snapshot = async () => {
      const response = await fetch(`${service.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${control}` }, signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200)
      const validated = await botsApi.methods.snapshot.output['~standard'].validate(await response.json())
      assert.equal(validated.issues, undefined)
      return validated.value
    }
    return {
      containsPrivate: text => browserContainsPrivateBytes(text) || (!!controller && text.includes(controller.capability)),
      serviceOrigin: service.origin,
      wireOrigin,
      close,
      state,
      seedHome: home => writeFile(join(home, configName), JSON.stringify({ serviceOrigin: service.origin }), { mode: 0o600 }),
      async verifyRetained() {
        assert.equal(state.completed, 1)
        assert.equal(state.leasesClosed, 1)
        assert.equal(state.browsersClosed, 0)
        assert.ok(controller)
        assert.throws(() => manager.status(controller.capability))
        await assert.rejects(manager.frame(controller.capability))
        await assert.rejects(
          manager.input(controller.capability, { attemptId: controller.attempt.id, sequence: 1000, input: { kind: 'text', text: 'never-sent' } }),
        )
        const response = await session.fetch('https://chatgpt.com/backend-api/tbo/primary', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            'ChatGPT-Account-Id': 'synthetic-account',
            'X-OpenAI-Expected-Account-Id': 'synthetic-account',
          },
        })
        assert.equal(response.status, 200)
        assert.equal(state.cookieUsed, true)
        const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,args='], { timeout: 5000 })
        chromeRootPids = stdout
          .split('\n')
          .filter(line => line.includes(`--user-data-dir=${profilePath}`) && !/(?:^|\s)--type=/u.test(line))
          .map(line => Number(line.trim().split(/\s+/u)[0]))
        assert.equal(chromeRootPids.length, 1)
        assert.ok(chromeRootPids[0] > 0)
        retainedProof = true
      },
      async verifyOwnership(home) {
        const proof = JsonText.parse(
          await readFile(join(home, proofName), 'utf8'),
          z.object({ localDomainOpen: z.literal(false), controlReads: z.number().positive() }),
        )
        assert.equal(proof.localDomainOpen, false)
        const names = await readdir(home, { recursive: true })
        assert.equal(
          names.some(file => basename(file) === 'durable_bots.json'),
          false,
        )
        const value = await snapshot()
        assert.equal(value.connections.length, 1)
        assert.equal(value.bots.length, 1)
        const bot = value.bots[0]
        const response = await fetch(`${service.origin}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${control}`, 'content-type': 'application/json' },
          body: JSON.stringify({ botId: bot.id, conversationId: bot.identity.conversations[0].id, limit: 50 }),
          signal: AbortSignal.timeout(5000),
        })
        assert.equal(response.status, 200)
        const validated = await botsApi.methods.messages.output['~standard'].validate(await response.json())
        assert.equal(validated.issues, undefined)
        const outgoing = validated.value.messages.filter(message => message.author === 'user')
        assert.equal(outgoing.length, 1)
        assert.equal(outgoing[0].delivery, 'sent')
        assert.ok(outgoing[0].requestId)
        assert.equal(state.sends, 1)
        assert.equal(browserContainsPrivateBytes(JSON.stringify(value)), false)
        assert.equal(browserContainsPrivateBytes(await readFile(join(root, 'service/durable_bots.json'), 'utf8')), false)
        return { localDomainOpen: false, connections: 1, bots: 1, outbox: 1, sends: state.sends }
      },
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
