import { mkdtemp, readFile, stat, symlink, link, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshPlatformClientFromTransport, type DshPlatformTransport } from '@dshfiles/dshx/platform'
import { createNativeTaskRuntime } from '../src/native-runtime.js'
import type { GatewayOperations, GatewayPrincipal, GatewayRuntime, NativeTaskSnapshot } from '../src/contracts.js'
import { createTaskGateway } from '../src/service.js'

const principal: GatewayPrincipal = { id: 'alice', projects: ['one', 'two'], actions: ['create', 'send', 'read', 'list', 'cancel'] }
const input = { project: 'one', title: 'A task', prompt: 'private prompt never persisted', idempotencyKey: 'create-0001' }
class FakeRuntime implements GatewayRuntime {
  creates: string[] = []
  sends: { sessionId: string; prompt: string; requestId: string }[] = []
  cancellations = 0
  createGate: Promise<void> = Promise.resolve()
  sendGate: Promise<void> = Promise.resolve()
  failCreate = false
  failSend = false
  failRename = false
  failRead = false
  failCancel = false
  reads = 0
  renameGate: Promise<void> = Promise.resolve()
  onRename = () => {}
  actualSession: string | null = null
  snapshot: NativeTaskSnapshot = { state: 'running', sequence: 1, text: 'native result', error: null }
  async create({ sessionId }: Parameters<GatewayRuntime['create']>[0]) {
    this.creates.push(sessionId)
    await this.createGate
    if (this.failCreate) throw new Error('secret-token raw create failure')
    return { sessionId: this.actualSession ?? sessionId }
  }
  async rename() {
    this.onRename()
    await this.renameGate
    if (this.failRename) throw new Error('secret-token rename failure')
  }
  async send(value: Parameters<GatewayRuntime['send']>[0]) {
    this.sends.push(value)
    await this.sendGate
    if (this.failSend) throw new Error('secret-token raw send failure')
  }
  async read() {
    this.reads++
    if (this.failRead) throw new Error('secret-token raw read failure')
    return this.snapshot
  }
  async cancel() {
    this.cancellations++
    if (this.failCancel) throw new Error('secret-token cancel failure')
    return { accepted: true as const }
  }
}
const gateways: GatewayOperations[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(g => g.close()))
})
async function fixture(runtime = new FakeRuntime()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-test-'))
  const ledgerPath = join(root, 'private', 'ledger.sqlite')
  const options = {
    runtime,
    projects: [
      { id: 'one', path: root },
      { id: 'two', path: root },
    ],
    ledgerPath,
    guiOrigin: 'http://127.0.0.1:3199',
  }
  const gateway = await createTaskGateway(options)
  gateways.push(gateway)
  return { gateway, runtime, ledgerPath, options }
}
function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

describe('native task gateway', () => {
  it('admits initial and followup prompts through the actual public SDK request codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-codec-'))
    const rpc = vi.fn<DshPlatformTransport['rpc']>(async (namespace, method) => {
      expect(namespace).toBe('session')
      if (method === 'create') return { sessionId: 'actual-sdk-session' }
      if (method === 'rename') return { title: input.title, seq: 0 }
      if (method === 'prompt') return { accepted: true }
      if (method === 'page') return { records: [], hasMore: false }
      if (method === 'list') return { items: [{ sessionId: 'actual-sdk-session', updatedAt: 0, running: true, blank: false, agentAvailable: true }] }
      throw new Error(`Unexpected synthetic RPC: ${method}`)
    })
    const runtime = createNativeTaskRuntime(createDshPlatformClientFromTransport({ rpc, sessionCursor: async () => -1 }))
    const gateway = await createTaskGateway({
      runtime,
      projects: [{ id: 'one', path: root }],
      ledgerPath: join(root, 'private', 'ledger.sqlite'),
      guiOrigin: 'http://127.0.0.1:3199',
    })
    gateways.push(gateway)
    const task = await gateway.create(principal, input)
    expect(task).toMatchObject({ admission: 'accepted', state: 'accepted', sessionId: 'actual-sdk-session' })
    const message = { taskId: task.taskId, prompt: 'Followup through native codec', idempotencyKey: 'message-sdk-0001' }
    expect(await gateway.send(principal, message)).toMatchObject({ admission: 'accepted', state: 'accepted' })
    await gateway.create(principal, input)
    await gateway.send(principal, message)
    // Both requests passed the SDK's actual nativeRpcRequestSchema, not a
    // permissive fake Runtime or a locally restated UUID validation rule.
    const prompts = rpc.mock.calls.filter(call => call[1] === 'prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.[2]).toEqual({
      request: { requestId: expect.any(String), sessionId: 'actual-sdk-session', mode: 'queue', content: [{ type: 'text', text: input.prompt }] },
    })
    expect(prompts[1]?.[2]).toEqual({
      request: { requestId: expect.any(String), sessionId: 'actual-sdk-session', mode: 'queue', content: [{ type: 'text', text: message.prompt }] },
    })
  })
  it('rejects action/project grants and cross-principal ownership before native calls', async () => {
    const { gateway, runtime } = await fixture()
    await expect(gateway.create({ ...principal, actions: ['read'] }, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.create({ ...principal, projects: ['two'] }, input)).rejects.toMatchObject({ code: 'forbidden' })
    expect(runtime.creates).toHaveLength(0)
    const task = await gateway.create(principal, input)
    const other = { ...principal, id: 'bob' }
    await expect(gateway.read(other, { taskId: task.taskId })).rejects.toMatchObject({ code: 'not-found' })
    await expect(gateway.send(other, { taskId: task.taskId, prompt: 'x', idempotencyKey: 'message-0001' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(gateway.cancel({ ...principal, projects: ['two'] }, { taskId: task.taskId, idempotencyKey: 'cancel-0001' })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect((await gateway.list(other, { limit: 20 })).tasks).toEqual([])
  })
  it('rejects conflicting payloads and keys reused across mutation types', async () => {
    const { gateway, runtime } = await fixture()
    const task = await gateway.create(principal, input)
    await gateway.create(principal, input)
    await expect(gateway.create(principal, { ...input, prompt: 'different' })).rejects.toMatchObject({ code: 'idempotency-conflict' })
    await expect(gateway.cancel(principal, { taskId: task.taskId, idempotencyKey: input.idempotencyKey })).rejects.toMatchObject({
      code: 'idempotency-conflict',
    })
    expect(runtime.creates).toHaveLength(1)
    expect(runtime.sends).toHaveLength(1)
  })
  it('claims duplicates atomically across independent ledger connections', async () => {
    const { gateway, runtime, options } = await fixture()
    const second = await createTaskGateway(options)
    gateways.push(second)
    const hold = gate()
    runtime.createGate = hold.promise
    const first = gateway.create(principal, input)
    await expect(second.create(principal, input)).rejects.toMatchObject({ code: 'busy' })
    hold.release()
    await first
    expect(runtime.creates).toHaveLength(1)
  })
  it('does not dispatch a duplicate claimed by another OS process', async () => {
    const { gateway, runtime, options } = await fixture()
    const compiled = await build({
      entryPoints: [new URL('../src/service.ts', import.meta.url).pathname],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      write: false,
    })
    const code =
      compiled.outputFiles[0]!.text +
      `
      const runtime = {
        async create({sessionId}) { process.stdout.write('claimed\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); return {sessionId}; },
        async rename() {}, async send() {}, async read() { return { state:'running',sequence:1,text:null,error:null }; }, async cancel() { return {accepted:true}; }
      };
      const gateway = await createTaskGateway({...${JSON.stringify({ ...options, runtime: undefined })}, runtime});
      try { await gateway.create(${JSON.stringify(principal)}, ${JSON.stringify(input)}); } finally { await gateway.close(); }
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    try {
      const started = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        exited.then(() => {
          throw new Error(`Child exited before claiming: ${stderr}`)
        }),
      ])
      expect(started).toContain('claimed')
      await expect(gateway.create(principal, input)).rejects.toMatchObject({ code: 'busy' })
      expect(runtime.creates).toHaveLength(0)
    } finally {
      child.stdin.end('release')
      const [code] = await exited
      expect(code, stderr).toBe(0)
    }
  })
  it('keeps ambiguous create unknown across restart without dispatching again', async () => {
    const { gateway, runtime, options } = await fixture()
    runtime.failCreate = true
    const task = await gateway.create(principal, input)
    expect(task).toMatchObject({ state: 'unknown', admission: 'unknown', sessionId: runtime.creates[0] })
    expect(task.error).not.toContain('secret-token')
    await gateway.close()
    runtime.failCreate = false
    const next = await createTaskGateway(options)
    gateways.push(next)
    expect(await next.create(principal, input)).toMatchObject({ state: 'unknown', admission: 'unknown', taskId: task.taskId })
    expect(runtime.creates).toHaveLength(1)
  })
  it('does not treat a possible unacknowledged create ID as an owned native Session', async () => {
    const { gateway, runtime, options } = await fixture()
    runtime.failCreate = true
    const task = await gateway.create(principal, input)
    await gateway.close()
    const next = await createTaskGateway(options)
    gateways.push(next)
    runtime.snapshot = { state: 'completed', sequence: 99, text: 'unconfirmed Session transcript', error: null }
    expect(await next.read(principal, { taskId: task.taskId })).toMatchObject({
      state: 'unknown',
      admission: 'unknown',
      sessionId: runtime.creates[0],
      sequence: null,
      text: null,
    })
    expect(runtime.reads).toBe(0)
  })
  it('records actual native IDs and retains readable Session on rename/prompt failure', async () => {
    const { gateway, runtime } = await fixture()
    runtime.actualSession = 'session-actual'
    runtime.failRename = true
    runtime.failSend = true
    const task = await gateway.create(principal, input)
    expect(task).toMatchObject({ sessionId: 'session-actual', state: 'unknown' })
    expect(runtime.sends[0]?.sessionId).toBe('session-actual')
    expect(await gateway.read(principal, { taskId: task.taskId })).toMatchObject({ text: 'native result', sessionId: 'session-actual' })
  })
  it('does not blindly resend lost sends on retry or restart', async () => {
    const { gateway, runtime, options } = await fixture()
    const task = await gateway.create(principal, input)
    runtime.failSend = true
    const message = { taskId: task.taskId, prompt: 'secret followup', idempotencyKey: 'message-0001' }
    expect(await gateway.send(principal, message)).toMatchObject({ state: 'unknown', admission: 'unknown' })
    await gateway.close()
    const next = await createTaskGateway(options)
    gateways.push(next)
    await next.send(principal, message)
    expect(runtime.sends).toHaveLength(2)
    expect(runtime.sends[0]?.requestId).not.toBe(runtime.sends[1]?.requestId)
  })
  it('returns cancellation-requested until native cancellation is observed', async () => {
    const { gateway, runtime } = await fixture()
    const task = await gateway.create(principal, input)
    expect(task.state).toBe('accepted')
    expect(await gateway.cancel(principal, { taskId: task.taskId, idempotencyKey: 'cancel-0001' })).toMatchObject({ state: 'cancellation-requested' })
    expect(await gateway.read(principal, { taskId: task.taskId })).toMatchObject({ state: 'cancellation-requested' })
    runtime.snapshot = { ...runtime.snapshot, state: 'cancelled' }
    expect(await gateway.read(principal, { taskId: task.taskId })).toMatchObject({ state: 'cancelled' })
  })
  it('gates every operation and waits for in-flight effects during close', async () => {
    const { gateway, runtime } = await fixture()
    const hold = gate()
    runtime.sendGate = hold.promise
    const creating = gateway.create(principal, input)
    // create reaches its first await before close; its later stages must drain too.
    let closed = false
    const closing = gateway.close().then(() => {
      closed = true
    })
    await expect(gateway.health(principal)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(gateway.list(principal, { limit: 20 })).rejects.toMatchObject({ code: 'unavailable' })
    expect(closed).toBe(false)
    hold.release()
    await creating
    await closing
    await expect(gateway.create(principal, input)).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('uses canonical read data and redacts raw diagnostic failures', async () => {
    const { gateway, runtime } = await fixture()
    const task = await gateway.create(principal, input)
    runtime.snapshot = { state: 'failed', sequence: 7, text: 'output', error: 'secret-token native diagnostic' }
    expect(await gateway.read(principal, { taskId: task.taskId })).toMatchObject({
      state: 'failed',
      sequence: 7,
      text: 'output',
      error: 'The native DSH task reported an error.',
    })
    runtime.failRead = true
    const unknown = await gateway.read(principal, { taskId: task.taskId })
    expect(unknown.state).toBe('unknown')
    expect(unknown.error).not.toContain('secret-token')
  })
  it('paginates only current principal/project scope and rejects foreign cursors', async () => {
    const { gateway } = await fixture()
    const a = await gateway.create(principal, input)
    await gateway.create(principal, { ...input, project: 'two', idempotencyKey: 'create-0002' })
    const b = await gateway.create(principal, { ...input, idempotencyKey: 'create-0003' })
    const scoped = { ...principal, projects: ['one'] }
    const first = await gateway.list(scoped, { limit: 1 })
    const second = await gateway.list(scoped, { limit: 1, cursor: first.nextCursor! })
    expect(new Set([...first.tasks, ...second.tasks].map(t => t.taskId))).toEqual(new Set([a.taskId, b.taskId]))
    expect(second.nextCursor).toBeNull()
    await expect(gateway.list({ ...principal, id: 'bob' }, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'not-found' })
  })
  it('stores private metadata and hashes, not prompt/transcript bytes', async () => {
    const { gateway, ledgerPath } = await fixture()
    await gateway.create(principal, input)
    await gateway.close()
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(ledgerPath, '..'))).mode & 0o777).toBe(0o700)
    expect((await readFile(ledgerPath)).includes(Buffer.from(input.prompt))).toBe(false)
    expect((await readFile(ledgerPath)).includes(Buffer.from('native result'))).toBe(false)
  })
  it('rechecks grants on duplicate requests and rejects unbounded or injected inputs', async () => {
    const { gateway, runtime } = await fixture()
    await gateway.create(principal, input)
    await expect(gateway.create({ ...principal, projects: [] }, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.create({ ...principal, actions: [] }, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.create(principal, { ...input, prompt: 'x'.repeat(20_001) })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.create(principal, { ...input, idempotencyKey: 'x'.repeat(129) })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.list(principal, { limit: 51 })).rejects.toMatchObject({ code: 'forbidden' })
    const injected = { ...input, sessionId: 'external-session', cwd: '/tmp', model: 'arbitrary' }
    await expect(gateway.create(principal, injected)).rejects.toMatchObject({ code: 'forbidden' })
    expect(runtime.creates).toHaveLength(1)
  })
  it('does not steal a persisted interrupted create intent after reopening', async () => {
    const { gateway, runtime, options, ledgerPath } = await fixture()
    runtime.failCreate = true
    const task = await gateway.create(principal, input)
    await gateway.close()
    const db = new DatabaseSync(ledgerPath)
    db.prepare("UPDATE operations SET status='pending',diagnostic=NULL").run()
    db.close()
    const next = await createTaskGateway(options)
    gateways.push(next)
    expect((await next.list(principal, { limit: 20 })).tasks[0]).toMatchObject({
      taskId: task.taskId,
      state: 'unknown',
      admission: 'unknown',
      sessionId: runtime.creates[0],
      text: null,
      error: null,
    })
    await expect(next.create(principal, input)).rejects.toMatchObject({ code: 'busy' })
    expect(runtime.creates).toHaveLength(1)
  })
  it('blocks followups after uncertain cancellation and never retries that cancellation', async () => {
    const { gateway, runtime } = await fixture()
    const task = await gateway.create(principal, input)
    runtime.failCancel = true
    const cancel = { taskId: task.taskId, idempotencyKey: 'cancel-0001' }
    expect(await gateway.cancel(principal, cancel)).toMatchObject({ state: 'unknown', admission: 'unknown' })
    await gateway.cancel(principal, cancel)
    await expect(gateway.send(principal, { taskId: task.taskId, prompt: 'revive', idempotencyKey: 'message-0001' })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(runtime.cancellations).toBe(1)
    expect(runtime.sends).toHaveLength(1)
    expect(await gateway.read(principal, { taskId: task.taskId })).toMatchObject({ state: 'cancellation-requested' })
  })
  it('refuses followups when the native snapshot already reports cancelled', async () => {
    const { gateway, runtime } = await fixture()
    const task = await gateway.create(principal, input)
    runtime.snapshot = { ...runtime.snapshot, state: 'cancelled' }
    expect(await gateway.send(principal, { taskId: task.taskId, prompt: 'revive', idempotencyKey: 'message-0001' })).toMatchObject({
      admission: 'refused',
      state: 'cancellation-requested',
    })
    expect(runtime.sends).toHaveLength(1)
  })
  it('does not submit an initial prompt after cancellation during rename', async () => {
    const { gateway, runtime } = await fixture()
    const hold = gate()
    const entered = gate()
    runtime.renameGate = hold.promise
    runtime.onRename = entered.release
    const creating = gateway.create(principal, input)
    await entered.promise
    const task = (await gateway.list(principal, { limit: 20 })).tasks[0]!
    await gateway.cancel(principal, { taskId: task.taskId, idempotencyKey: 'cancel-0001' })
    hold.release()
    expect(await creating).toMatchObject({ state: 'cancellation-requested', admission: 'refused' })
    expect(runtime.sends).toHaveLength(0)
  })
  it('lists metadata without fetching native snapshots', async () => {
    const { gateway, runtime } = await fixture()
    await gateway.create(principal, input)
    expect((await gateway.list(principal, { limit: 50 })).tasks[0]).toMatchObject({ text: null, error: null })
    expect(runtime.reads).toBe(0)
  })
  it('rejects symlinked, hardlinked, and public ledger storage', async () => {
    const { gateway, ledgerPath, options } = await fixture()
    await gateway.close()
    const alias = join(ledgerPath, '..', 'alias.sqlite')
    await symlink(ledgerPath, alias)
    await expect(createTaskGateway({ ...options, ledgerPath: alias })).rejects.toMatchObject({ code: 'invalid-config' })
    const hard = join(ledgerPath, '..', 'hard.sqlite')
    await link(ledgerPath, hard)
    await expect(createTaskGateway({ ...options, ledgerPath: hard })).rejects.toMatchObject({ code: 'invalid-config' })
    const publicDir = join(ledgerPath, '..', 'public')
    await mkdir(publicDir, { mode: 0o755 })
    await chmod(publicDir, 0o755)
    await expect(createTaskGateway({ ...options, ledgerPath: join(publicDir, 'db') })).rejects.toMatchObject({ code: 'invalid-config' })
  })
})
