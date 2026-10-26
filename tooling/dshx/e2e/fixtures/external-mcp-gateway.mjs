// Only the LLM provider boundary is synthetic; native Session, Agent, log and RPC owners are real.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, watch, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const sdkOwner = createRequire(new URL('../../packages/dshx/package.json', import.meta.url))
const gatewayOwner = createRequire(new URL('../../../../apps/dsh-mcp-gateway/package.json', import.meta.url))
const load = (owner, id) => import(pathToFileURL(owner.resolve(id)).href)
const proofName = 'SYNTH-external-mcp-proof.json'
const releaseName = 'SYNTH-release-initial'
export const initialPrompt = 'SYNTH initial brief from an external MCP client'
export const followupPrompt = 'SYNTH followup brief from the same external MCP client'
export const cancellationPrompt = 'SYNTH hold this native turn for cancellation'
export const initialReply = 'SYNTH initial reply from the actual native DSH Agent'
export const followupReply = 'SYNTH followup reply from the same native DSH Session'
export const name = 'external-mcp-gateway-fixture'
export const inject = ['llm', 'sessions']

const scratchRoot = root => {
  assert.ok(root && basename(root).startsWith('dshx-boot-profile-'))
  return root
}
export const readGatewayProof = async root => JSON.parse(await readFile(join(scratchRoot(root), proofName), 'utf8'))

export async function apply(ctx) {
  const root = scratchRoot(process.env.DSH_HOME)
  const { LlmAdapter } = await load(sdkOwner, '@deepseek-ai/dsh-llm')
  const proof = { calls: [], ends: [], sessions: [] }
  let writes = Promise.resolve()
  const publish = () => {
    const serialized = JSON.stringify(proof)
    const next = writes.then(async () => {
      await writeFile(join(root, `${proofName}.tmp`), serialized, { mode: 0o600 })
      await rename(join(root, `${proofName}.tmp`), join(root, proofName))
    })
    writes = next.catch(() => undefined)
    return next
  }
  class SyntheticTaskAdapter extends LlmAdapter {
    async listModels(provider) {
      return [{ provider, id: 'SYNTH-task-model', name: 'SYNTH task model', inputModalities: ['text'] }]
    }
    async *stream(options) {
      if (options.purpose !== undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'SYNTH task' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SYNTH task' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      assert.ok(options.sessionId, 'Real Agent request must carry its native Session identity')
      const prompt =
        options.messages
          .filter(message => message.role === 'user')
          .map(message =>
            message.content
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('\n'),
          )
          .findLast(text => [initialPrompt, followupPrompt, cancellationPrompt].some(marker => text.includes(marker))) ?? ''
      const kind = prompt.includes(cancellationPrompt)
        ? 'cancel'
        : prompt.includes(followupPrompt)
          ? 'followup'
          : prompt.includes(initialPrompt)
            ? 'initial'
            : 'unexpected'
      proof.calls.push({ sessionId: options.sessionId, kind })
      await publish()
      if (kind === 'unexpected') throw new Error('SYNTH provider refused an unexpected prompt')
      if (kind === 'cancel') {
        assert.ok(options.signal)
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason)
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      }
      if (kind === 'initial') {
        // A real provider request stays in flight until the external test has observed running.
        const changed = watch(root, { signal: options.signal })
        try {
          try {
            await access(join(root, releaseName))
          } catch {
            for await (const change of changed) if (change.filename === releaseName) break
          }
        } finally {
          await changed.return()
        }
      }
      const text = kind === 'followup' ? followupReply : initialReply
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['SYNTH-task-provider'], new SyntheticTaskAdapter()), 'SYNTH external MCP provider')
  ctx.on('session/created', session => {
    proof.sessions.push(session.id)
    void publish()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    proof.ends.push({ sessionId: session.id, seq: event.seq, kind: event.data.reason.kind })
    void publish()
  })
  ctx.effect(
    () => async () => {
      await writes
    },
    'SYNTH external MCP proof flush',
  )
  await publish()
}

const freePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = z.object({ port: z.number().int().min(1).max(65535) }).parse(server.address())
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return address.port
}

export async function startExternalGateway(profile) {
  const root = scratchRoot(profile.homeRoot)
  // This is an app executable, not a booted plugin bundle. Build its current sources
  // through its declared script so a fresh checkout or stale dist cannot fabricate green.
  try {
    execFileSync(process.execPath, ['--run', 'build'], {
      cwd: fileURLToPath(new URL('../../../../apps/dsh-mcp-gateway/', import.meta.url)),
      env: { PATH: process.env.PATH, HOME: root, DSH_HOME: root },
      stdio: 'pipe',
      timeout: 15_000,
    })
  } catch { throw new Error('Synthetic gateway executable preparation failed.') }
  const projectPath = join(root, 'SYNTH-project')
  await mkdir(projectPath)
  const ownerToken = randomBytes(32).toString('hex')
  const otherToken = randomBytes(32).toString('hex')
  const wrongToken = randomBytes(32).toString('hex')
  const configPath = join(root, 'SYNTH-gateway-config.json')
  const port = await freePort()
  await writeFile(
    configPath,
    JSON.stringify({
      listen: { host: '127.0.0.1', port },
      guiOrigin: new URL(profile.url).origin,
      ledgerPath: join(root, 'SYNTH-task-ledger.json'),
      upstreamLaunchUrlEnv: 'SYNTH_GATEWAY_UPSTREAM',
      projects: [{ id: 'SYNTH-project', path: projectPath }],
      principals: [
        { id: 'SYNTH-owner', tokenEnv: 'SYNTH_GATEWAY_OWNER', projects: ['SYNTH-project'], actions: ['create', 'send', 'read', 'list', 'cancel'] },
        { id: 'SYNTH-other', tokenEnv: 'SYNTH_GATEWAY_OTHER', projects: ['SYNTH-project'], actions: ['create', 'send', 'read', 'list', 'cancel'] },
      ],
    }),
    { mode: 0o600 },
  )
  const manifest = JSON.parse(await readFile(new URL('../../../../apps/dsh-mcp-gateway/package.json', import.meta.url), 'utf8'))
  const entry = fileURLToPath(new URL(`../../../../apps/dsh-mcp-gateway/${manifest.bin['dsh-mcp-gateway']}`, import.meta.url))
  const child = spawn(process.execPath, [entry, '--config', configPath], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DSH_HOME: root,
      SYNTH_GATEWAY_UPSTREAM: profile.url,
      SYNTH_GATEWAY_OWNER: ownerToken,
      SYNTH_GATEWAY_OTHER: otherToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`)
  const clients = []
  let output = ''
  const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const close = async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000)
    const result = await stopped
    clearTimeout(timeout)
    assert.equal(result.code, 0, 'Normal gateway CLI shutdown must exit successfully')
    assert.equal(result.signal, null, 'Gateway must not require forced termination')
    return { gatewayPid: child.pid, gatewayExited: true }
  }
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('SYNTH gateway did not become ready'))
      }, 20_000)
      const cleanup = () => {
        clearTimeout(timeout)
        child.off('exit', earlyExit)
      }
      const earlyExit = () => {
        cleanup()
        reject(new Error(`Gateway CLI exited before readiness: ${output}`))
      }
      const collect = chunk => {
        output = `${output}${chunk}`.slice(-4096)
        if (output.includes('"state":"listening"')) {
          cleanup()
          resolve()
        }
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('exit', earlyExit)
    })
    const [{ Client }, { StreamableHTTPClientTransport }, protocol, { connectDshPlatformClient }] = await Promise.all([
      load(gatewayOwner, '@modelcontextprotocol/sdk/client/index.js'),
      load(gatewayOwner, '@modelcontextprotocol/sdk/client/streamableHttp.js'),
      load(gatewayOwner, '@dshfiles/dsh-mcp-gateway/protocol'),
      load(gatewayOwner, '@dshfiles/dshx/platform'),
    ])
    const connect = async token => {
      const client = new Client({ name: 'SYNTH-external-client', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(ownerToken)
    const other = await connect(otherToken)
    const native = await connectDshPlatformClient({ url: profile.url })
    const call = async (name, args, schema) => {
      const result = await client.callTool({ name, arguments: args })
      assert.notEqual(result.isError, true, `${name} must succeed`)
      return schema.parse(result.structuredContent).result
    }
    return {
      child,
      client,
      other,
      native,
      protocol,
      projectPath,
      containsPrivate: text => [ownerToken, otherToken, wrongToken, profile.url].some(value => text.includes(value)),
      wrongKey: () => connect(wrongToken),
      call,
      releaseInitial: () => writeFile(join(root, releaseName), 'SYNTH release', { mode: 0o600 }),
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
