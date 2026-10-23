// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Opt-in REALLOCAL SYNTHETIC proof; never loaded by the unit suite.
 * Run with explicit DSH_DOT_PROOF_RUNTIME=<absolute installed runtime root> and
 * DSH_DOT_PROOF_CHROME=<absolute managed Chrome155 executable>:
 * node plugins/@dshfiles/bot-openai-dot/tests/auth-browser-native-proof.mjs
 * Both paths are mandatory trusted local operator configuration, never GUI input.
 * No fallback machine paths or network-preflight bypass flags are provided.
 * Uses only exported package entries and public native subprocess methods.
 * Root is bootstrapped by a managed bash job; every further Node/Chrome process
 * is native-managed. No provider, account, vault, existing profile or GUI.
 * A fresh, controlled Node Host is the minimum diagnostics assumption, NOT an
 * attestation of arbitrary production Hosts. The before-browser gate also
 * requires an externally provisioned loopback-only network namespace. Ordinary
 * desktop network worlds fail closed WITHOUT Chrome; no policy/OS bypass knob.
 *
 * Investigation evidence (2026-10-23, before adding the network preflight):
 * - Native nonce filesystem/loopback/live PID-ancestry gate passed.
 * - Configured managed Chrome: Google Chrome 155.0.8059.79, no sandbox bypass.
 * - Actual factory raw pipes, collected={}, endpoint-free captured public logs;
 *   JPEG 9916 bytes, 1280x900, memory only.
 * - Correct all-thread owned-process fd observation found 7 non-loopback TCP
 *   sockets (115 socket inodes, 0 inaccessible fds). Earlier main-task-only
 *   traversal undercounted descendants and must NOT be used as no-egress proof.
 * - Pointer-up/input and factory close were not proven; close rejected with
 *   profile retained. The outer native owner joined the fresh Host range,
 *   identity-checked and reaped only that retained profile, then deleted scratch.
 * No browser retry is authorized in the ordinary network world. On this host
 * the final helper proves native metadata and exits 1 before Chrome launch.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JsonText } from '@dshfiles/dshx/api'
import { z } from 'zod'

const started = performance.now()
const self = fileURLToPath(import.meta.url)
const pluginRoot = resolve(dirname(self), '..')
const absolutePathSchema = z.string().min(1).refine(path => isAbsolute(path) && !path.includes('\0'))
const operatorConfigSchema = z.object({ runtimeRoot: absolutePathSchema, chrome: absolutePathSchema }).strict()
const operatorConfigResult = operatorConfigSchema.safeParse({ runtimeRoot: process.env.DSH_DOT_PROOF_RUNTIME, chrome: process.env.DSH_DOT_PROOF_CHROME })
if (!operatorConfigResult.success) throw new Error('Explicit absolute DSH_DOT_PROOF_RUNTIME and DSH_DOT_PROOF_CHROME are required.')
const { runtimeRoot, chrome } = operatorConfigResult.data
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
const packageVersionSchema = z.object({ version: z.literal('0.2.1-rc.2') })
const helperResponseSchema = z.object({ nonce: z.string().uuid(), pid: z.number().int().min(2), parent: z.number().int().min(1) }).strict()
const nativeWorldEvidenceSchema = z.object({ nonceFilesystem: z.literal(true), loopback: z.literal(true), livePidAncestry: z.literal(true), nativeRangeEmpty: z.literal(true) }).strict()
const networkPreflightSchema = z.object({ loopbackOnly: z.boolean(), interfaceCount: z.number().int().nonnegative(), hostRoutesModified: z.literal(false) }).strict()
const socketSnapshotSchema = z.object({ ownedSocketInodes: z.number().int().nonnegative(), nonLoopbackTcp: z.number().int().nonnegative(), udp: z.number().int().nonnegative(), inaccessibleDescriptors: z.number().int().nonnegative() }).strict()
const fixtureHostSummarySchema = z.object({
  kind: z.literal('REALLOCAL SYNTHETIC'), runtime: z.literal('0.2.1-rc.2'), status: z.enum(['failed-closed', 'passed']), stage: z.string().max(100),
  diagnostics: z.string().max(256).optional(), sameWorld: nativeWorldEvidenceSchema.optional(), networkPreflight: networkPreflightSchema.optional(),
  blocker: z.string().max(512).optional(), failureType: z.string().max(100).optional(), failureDetail: z.string().max(256).optional(), failureCode: z.string().max(100).optional(), assertion: z.string().max(256).optional(),
  elapsedMs: z.number().nonnegative(), cleanupUnconfirmed: z.literal(true).optional(),
  fixtureRequests: z.array(z.object({ method: z.enum(['GET', 'HEAD', 'POST']), url: z.enum(['/fixture', '/fixture.css', '/submit', '/favicon.ico', '/denied-script']) }).strict()).max(64).optional(),
  ownedProfile: absolutePathSchema.optional(), ownedProfileIdentity: z.object({ ino: z.number().int().nonnegative(), dev: z.number().int().nonnegative(), uid: z.number().int().nonnegative() }).strict().optional(),
  chromeVersion: z.string().regex(/^Google Chrome 155\.[0-9.]+$/u).optional(),
  sandbox: z.union([z.literal('no bypass arguments; renderer kernel evidence pending'), z.object({ noBypassArguments: z.literal(true), rendererCount: z.number().int().positive(), noNewPrivileges: z.literal(true), seccompFilter: z.literal(true), separateUserNamespace: z.enum(['verified', 'kernel access denied; not claimed']) }).strict()]).optional(),
  networkObservation: z.object({ before: socketSnapshotSchema, after: socketSnapshotSchema.optional(), limitation: z.string().max(256) }).strict().optional(),
  frame: z.object({ mime: z.literal('image/jpeg'), bytes: z.number().int().positive().max(1024 * 1024), width: z.literal(1280), height: z.literal(900), persisted: z.literal(false) }).strict().optional(),
  privacy: z.object({ rawNativeStderrOnly: z.literal(true), collectorAndSpillAbsent: z.literal(true), cdpReadinessSeenPrivately: z.literal(true), publicLogsEndpointFree: z.literal(true) }).strict().optional(),
  rendererObservation: z.object({ ownedDescendants: z.number().int().nonnegative(), exactArgvMatches: z.number().int().nonnegative(), titleTokenMatches: z.number().int().nonnegative() }).strict().optional(),
  inputOperations: z.array(z.object({ stage: z.string().max(100), elapsedMs: z.number().nonnegative(), completed: z.boolean() }).strict()).max(16).optional(),
  input: z.object({ pointer: z.literal(true), text: z.literal(true), wheel: z.literal(true), key: z.literal(true), actualLocalPost: z.literal(true) }).strict().optional(),
  routing: z.object({ forbiddenLoopbackHits: z.literal(0), scriptDenied: z.literal(true), osEgressContainment: z.literal(false) }).strict().optional(),
  cleanup: z.object({ browserClosed: z.literal(true), nativeRangeEmpty: z.literal(true), ownedPidGone: z.literal(true), profileDeleted: z.literal(true) }).strict().optional(),
}).strict()
const diagnosticNames = ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PW_TEST_DEBUG_PROTOCOL']
const privatePattern = /ws:\/\/|devtools\/browser\/|DevTools listening on/u
const summary = { kind: 'REALLOCAL SYNTHETIC', runtime: '0.2.1-rc.2', status: 'failed-closed', stage: 'bootstrap' }
const deadline = new AbortController()
const timer = setTimeout(() => deadline.abort(), process.argv.includes('--fixture-host') ? 45_000 : 60_000)
let ownedScratch
let provider
let browser
let browserLifetime
const ownedHandles = []
const servers = []
let cleanupConfirmed = true
let logs = ''
let loggingOverflow = false

function cleanEnvironment(home) {
  const env = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]))
  return { ...env, HOME: home, TMPDIR: home, LANG: 'C.UTF-8' }
}
function rememberLog(text) {
  if (logs.length + text.length > 64 * 1024) loggingOverflow = true
  else logs += text
}
async function loadPublic(name) {
  return import(pathToFileURL(runtimeRequire.resolve(name)).href)
}
async function nativeProvider() {
  for (const name of ['@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-subprocess-local']) {
    const pkg = JsonText.parse(await readFile(runtimeRequire.resolve(`${name}/package.json`), 'utf8'), packageVersionSchema)
    assert.equal(pkg.version, '0.2.1-rc.2', 'Installed runtime version must match proof contract')
  }
  const { Context } = await loadPublic('@deepseek-ai/cordis')
  const { LocalSubprocessRuntime } = await loadPublic('@deepseek-ai/dsh-subprocess-local')
  const context = new Context()
  context.logger.exporter({ export: message => rememberLog(message.args.map(String).join(' ')) })
  provider = await context.plugin(LocalSubprocessRuntime)
  return context.subprocess
}
function spawn(runtime, spec) {
  const handle = runtime.spawn(spec)
  ownedHandles.push(handle)
  // Observe immediately: failed native startup must not be an unhandled rejection.
  void handle.done.catch(() => undefined)
  return handle
}
async function bounded(promise, signal = deadline.signal) {
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(new Error('Proof deadline reached'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}
async function privateOutput(handle) {
  let stdout = ''
  let stderrBytes = 0
  handle.stdout?.on('data', chunk => {
    if (stdout.length + chunk.length > 64 * 1024) deadline.abort()
    else stdout += chunk.toString()
  })
  handle.stderr?.on('data', chunk => { stderrBytes += chunk.length })
  const result = await bounded(handle.done)
  assert.equal(await handle.waitForExit(AbortSignal.timeout(5_000)), true, 'Native range must quiesce')
  return { stdout, stderrBytes, result }
}
async function listen(handler) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening', { signal: deadline.signal })
  const address = server.address()
  assert(address && Object.hasOwn(address, 'port'), 'Owned server must bind numeric loopback')
  return `http://127.0.0.1:${address.port}`
}
async function procStat(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { parent: Number(fields[1]), start: fields[19] }
}
async function descendsFrom(pid, ancestor) {
  for (let hops = 0; pid > 1 && hops < 64; hops++) {
    if (pid === ancestor) return true
    pid = (await procStat(pid)).parent
  }
  return false
}
async function sameWorld(runtime, signal) {
  summary.stage = 'execution-world-gate'
  const nonce = randomUUID()
  const challenge = join(ownedScratch, `challenge-${nonce}`)
  const response = join(ownedScratch, `response-${nonce}`)
  await writeFile(challenge, nonce, { mode: 0o600, flag: 'wx' })
  let loopbackVerified = false
  const origin = await listen((request, reply) => {
    if (request.url === `/${nonce}` && request.method === 'POST') {
      loopbackVerified = true
      reply.end(nonce)
    } else { reply.writeHead(403); reply.end() }
  })
  // This helper has no libraries, provider access, shell, or browser. It reads
  // a fresh unguessable local file, calls our own server, writes an exclusive
  // response, and keeps its PID alive until the Host's public stdin close.
  const code = `
    const {readFile,writeFile}=await import('node:fs/promises');
    const nonce=await readFile(process.argv[1],'utf8');
    const reply=await fetch(process.argv[3]+'/'+nonce,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000)});
    if(await reply.text()!==nonce) throw Error('Loopback mismatch');
    await writeFile(process.argv[2],JSON.stringify({nonce,pid:process.pid,parent:process.ppid}),{mode:0o600,flag:'wx'});
    process.stdout.write('READY\\n'); process.stdin.resume();
  `
  const handle = spawn(runtime, {
    argv: [process.execPath, '--input-type=module', '-e', code, challenge, response, origin],
    cwd: ownedScratch, env: cleanEnvironment(ownedScratch), graceMs: 500,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, signal,
  })
  handle.stderr?.resume()
  assert(handle.stdout && handle.stdin, 'Public raw helper pipes required')
  const [ready] = await once(handle.stdout, 'data', { signal })
  assert.equal(ready.toString(), 'READY\n', 'Owned helper readiness required')
  const data = JsonText.parse(await readFile(response, 'utf8'), helperResponseSchema)
  assert.equal(data.nonce, nonce, 'Fresh filesystem response must match')
  assert(Number.isSafeInteger(data.pid) && data.pid > 1, 'Owned helper must publish a real PID')
  assert.equal((await procStat(data.pid)).parent, data.parent, 'Host must observe the same live PID ancestry')
  assert.equal(await descendsFrom(data.pid, process.pid), true, 'Managed helper must descend from this fresh Host')
  assert.equal(await realpath(`/proc/${data.pid}/cwd`), ownedScratch, 'Managed helper must share Host filesystem')
  assert.equal(loopbackVerified, true, 'Native helper must reach the Host-owned loopback server')
  const info = await lstat(response)
  assert.equal(info.uid, process.getuid(), 'Response owner must be this fixture user')
  assert.equal(info.mode & 0o777, 0o600, 'Response must be private')
  handle.stdin.end()
  assert.equal((await bounded(handle.done, signal)).exitCode, 0, 'Owned helper must exit normally')
  assert.equal(await handle.waitForExit(signal), true, 'Helper native range must be empty')
  summary.sameWorld = { nonceFilesystem: true, loopback: true, livePidAncestry: true, nativeRangeEmpty: true }
  return true
}
async function ownedDescendants(pid) {
  const result = []
  const seen = new Set([pid])
  // Intentionally sequential: traverse only this owned process's tasks/children.
  // Chromium launches children from non-main threads, so main-task-only misses them.
  const inspect = async current => {
    for (const task of await readdir(`/proc/${current}/task`)) {
      let children
      try { children = await readFile(`/proc/${current}/task/${task}/children`, 'utf8') }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      for (const child of children.trim().split(/\s+/u).filter(Boolean).map(Number)) {
        if (seen.has(child)) continue
        seen.add(child)
        try {
          const args = await readFile(`/proc/${child}/cmdline`, 'utf8')
          result.push({ pid: child, args })
          await inspect(child)
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    }
  }
  await inspect(pid)
  return result
}
async function networkSnapshot(pid) {
  const inodes = new Set()
  let inaccessibleDescriptors = 0
  for (const member of [{ pid }, ...await ownedDescendants(pid)]) {
    try {
      for (const fd of await readdir(`/proc/${member.pid}/fd`)) {
        try {
          const link = await readlink(`/proc/${member.pid}/fd/${fd}`)
          const match = /^socket:\[(\d+)\]$/u.exec(link)
          if (match) inodes.add(match[1])
        } catch { inaccessibleDescriptors++ }
      }
    } catch { inaccessibleDescriptors++ }
  }
  let nonLoopbackTcp = 0
  let udp = 0
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const rows = (await readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1)
    for (const row of rows) {
      const fields = row.trim().split(/\s+/u)
      if (!inodes.has(fields[9])) continue
      const remote = fields[2].split(':')[0]
      if (table.startsWith('udp')) udp++
      else if (!['00000000', '0100007F', '00000000000000000000000000000000', '00000000000000000000000001000000'].includes(remote)) nonLoopbackTcp++
    }
  }
  return { ownedSocketInodes: inodes.size, nonLoopbackTcp, udp, inaccessibleDescriptors }
}
async function fixtureHost() {
  assert(diagnosticNames.every(name => !process.env[name]), 'Fresh Host diagnostics environment must be disabled')
  assert.equal(process.argv[3], '--controlled-fresh-host', 'Do not invoke the fixture Host in an arbitrary Node process')
  ownedScratch = await realpath(process.argv[4])
  assert.equal((await lstat(ownedScratch)).mode & 0o777, 0o700, 'Scratch must be private')
  summary.diagnostics = 'fresh controlled fixture Host only; public in-process Playwright attestation unavailable'
  summary.stage = 'native-provider-init'
  const runtime = await nativeProvider()
  summary.stage = 'factory-type-stripping'
  // Public Node 22 type stripping into private scratch; the existing actual
  // factory/policy is unchanged, not reimplemented. No compiler install/build.
  for (const name of ['auth-browser', 'auth-protocol']) {
    const source = await readFile(join(pluginRoot, 'src', `${name}.ts`), 'utf8')
    const output = stripTypeScriptTypes(source, { mode: 'strip' })
    await writeFile(join(ownedScratch, `${name}.js`), output, { mode: 0o600, flag: 'wx' })
  }
  await writeFile(join(ownedScratch, 'package.json'), '{"type":"module"}', { mode: 0o600, flag: 'wx' })
  await symlink(join(pluginRoot, 'node_modules'), join(ownedScratch, 'node_modules'))
  summary.stage = 'factory-public-dependencies-import'
  const { createFixtureBrowserFactory } = await import(pathToFileURL(join(ownedScratch, 'auth-browser.js')).href)
  let guardHits = 0
  const guard = await listen((_request, reply) => { guardHits++; reply.writeHead(403); reply.end() })
  let submit
  const submitted = new Promise(resolveSubmission => { submit = resolveSubmission })
  const requests = []
  summary.fixtureRequests = requests
  const origin = await listen((request, reply) => {
    requests.push({ method: request.method, url: request.url })
    reply.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/fixture.css') {
      reply.setHeader('Content-Type', 'text/css')
      reply.end('body{margin:0}input{position:absolute;left:40px;top:40px;width:300px;height:50px}button{position:absolute;left:40px;top:120px;width:200px;height:50px}')
    } else if (request.url === '/submit' && request.method === 'POST') {
      let body = ''
      request.on('data', chunk => { body += chunk; if (body.length > 1024) request.destroy() })
      request.on('end', () => { submit(body); reply.end('<h1>Synthetic accepted</h1>') })
    } else if (request.url === '/fixture') {
      // Deliberately no JS, real credentials or external DNS/network targets.
      reply.end(`<link rel="stylesheet" href="/fixture.css"><form method="post" action="/submit"><input name="synthetic" autocomplete="off"><button type="submit">Synthetic login</button></form><img src="${guard}/denied"><script src="/denied-script"></script>`)
    } else { reply.writeHead(403); reply.end() }
  })
  let chromeSpec
  let chromeHandle
  let stderrBytes = 0
  let endpointSeenPrivately = false
  const observedRuntime = {
    resolveExecutable: (command, env, signal) => runtime.resolveExecutable(command, env, signal),
    spawn: spec => {
      chromeSpec = spec
      summary.ownedProfile = spec.cwd
      chromeHandle = spawn(runtime, spec)
      chromeHandle.stderr?.on('data', chunk => {
        stderrBytes += chunk.byteLength
        if (privatePattern.test(chunk.toString())) endpointSeenPrivately = true
      })
      return chromeHandle
    },
  }
  browserLifetime = new AbortController()
  const factory = createFixtureBrowserFactory({
    runtime: observedRuntime,
    policy: { kind: 'synthetic-local-fixture', entryUrl: `${origin}/fixture`, chromiumExecutable: chrome },
    confirmLocalExecutionWorld: async ({ signal }) => {
      const proven = await sameWorld(runtime, signal)
      summary.stage = 'pre-browser-network-isolation'
      // A page route cannot contain Chrome background traffic. Require an
      // externally provisioned loopback-only fixture network namespace BEFORE
      // even resolving/launching Chrome. This helper never changes host routes.
      const devices = (await readFile('/proc/self/net/dev', 'utf8')).trim().split('\n').slice(2).map(line => line.split(':')[0].trim())
      const loopbackOnly = devices.length === 1 && devices[0] === 'lo'
      summary.networkPreflight = { loopbackOnly, interfaceCount: devices.length, hostRoutesModified: false }
      if (!loopbackOnly) {
        summary.blocker = 'Fresh fixture Host exposes non-loopback network interfaces; page routing cannot constrain Chrome background traffic. Require an externally isolated loopback-only execution world before any Chrome launch.'
        return false
      }
      summary.stage = 'chrome-version'
      const versionHandle = spawn(runtime, {
        argv: [await runtime.resolveExecutable(chrome, {}, signal), '--version'], cwd: ownedScratch,
        env: cleanEnvironment(ownedScratch), graceMs: 500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, signal,
      })
      const version = await privateOutput(versionHandle)
      assert.equal(version.result.exitCode, 0, 'Managed Chrome version command must succeed')
      assert.match(version.stdout, /Google Chrome 155\./u, 'This proof requires the configured managed Chrome 155')
      summary.chromeVersion = version.stdout.trim()
      summary.stage = 'factory-open'
      return proven
    },
  })
  browser = await factory(AbortSignal.any([deadline.signal, browserLifetime.signal]))
  assert(chromeSpec && chromeHandle, 'Factory must use the actual native spawn seam')
  summary.stage = 'native-chrome-policy'
  assert.deepEqual(chromeSpec.stdio, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, 'Factory must request private raw pipes')
  assert.deepEqual(chromeHandle.collected, {}, 'Native collector/spill must never receive Chrome stderr')
  assert(!chromeSpec.argv.some(arg => /--no-sandbox|--disable-setuid-sandbox|--user-agent|--disable-blink-features/u.test(arg)), 'No sandbox bypass or stealth')
  const profileInfo = await lstat(chromeSpec.cwd)
  assert.equal(profileInfo.mode & 0o777, 0o700, 'Fresh browser profile must be private')
  summary.ownedProfileIdentity = { ino: profileInfo.ino, dev: profileInfo.dev, uid: profileInfo.uid }
  // Chrome's own fresh SingletonLock supplies its PID, not a native-private hook.
  const lock = await readlink(join(chromeSpec.cwd, 'SingletonLock'))
  const pid = Number(lock.slice(lock.lastIndexOf('-') + 1))
  assert(Number.isSafeInteger(pid) && pid > 1, 'Owned profile must identify managed Chrome')
  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')
  assert(cmdline.split('\0').includes(`--user-data-dir=${chromeSpec.cwd}`), 'PID must own exactly this fresh profile')
  assert(!/--no-sandbox|--disable-setuid-sandbox|--user-agent|--disable-blink-features/u.test(cmdline), 'Actual wrapper-expanded Chrome argv must not bypass sandbox or add stealth')
  const chromeIdentity = await procStat(pid)
  summary.sandbox = 'no bypass arguments; renderer kernel evidence pending'
  summary.stage = 'owned-network-observation'
  const networkBefore = await networkSnapshot(pid)
  summary.networkObservation = { before: networkBefore, limitation: 'Owned-fd snapshots only; no OS egress enforcement, transient/closed/UDP sends are not excluded' }
  assert.equal(networkBefore.nonLoopbackTcp, 0, 'Owned Chrome must have no observed non-loopback TCP socket')
  summary.stage = 'jpeg-memory-frame'
  const frame = await browser.frame(deadline.signal)
  assert.equal(frame.width, 1280)
  assert.equal(frame.height, 900)
  assert(frame.bytes.byteLength > 1024 && frame.bytes.byteLength <= 1024 * 1024, 'JPEG must be real bounded bytes in memory')
  assert.equal(Buffer.from(frame.bytes.subarray(0, 3)).toString('hex'), 'ffd8ff')
  assert.equal(Buffer.from(frame.bytes.subarray(-2)).toString('hex'), 'ffd9')
  summary.frame = { mime: 'image/jpeg', bytes: frame.bytes.byteLength, width: frame.width, height: frame.height, persisted: false }
  assert(stderrBytes > 0 && endpointSeenPrivately, 'Actual native raw stderr must privately carry CDP readiness')
  assert(!privatePattern.test(logs) && !loggingOverflow, 'Public native logs must contain no CDP endpoint or raw readiness')
  summary.privacy = { rawNativeStderrOnly: true, collectorAndSpillAbsent: true, cdpReadinessSeenPrivately: true, publicLogsEndpointFree: true }
  summary.stage = 'renderer-sandbox-evidence'
  // Owned descendant PID traversal only; never enumerate or signal foreign PIDs.
  const descendants = await ownedDescendants(pid)
  // Linux Chromium may rewrite its process title into one space-separated
  // argv entry. Match only complete tokens on already-owned descendants;
  // never infer ownership or sandbox evidence from a title alone.
  const renderers = descendants.filter(child => child.args.split(/[\s\0]+/u).includes('--type=renderer'))
  summary.rendererObservation = {
    ownedDescendants: descendants.length,
    exactArgvMatches: descendants.filter(child => child.args.split('\0').includes('--type=renderer')).length,
    titleTokenMatches: renderers.length,
  }
  assert(renderers.length > 0, 'Owned renderer evidence is required')
  let namespacesInspectable = true
  for (const renderer of renderers) {
    const status = await readFile(`/proc/${renderer.pid}/status`, 'utf8')
    assert(/^NoNewPrivs:\s+1$/mu.test(status) && /^Seccomp:\s+2$/mu.test(status), 'Renderer must run with kernel no-new-privileges and seccomp filtering')
    try {
      assert.notEqual(await readlink(`/proc/${renderer.pid}/ns/user`), await readlink(`/proc/${pid}/ns/user`), 'Renderer must use a separate sandbox user namespace')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(error.code))) throw error
      namespacesInspectable = false
    }
  }
  summary.sandbox = { noBypassArguments: true, rendererCount: renderers.length, noNewPrivileges: true, seccompFilter: true, separateUserNamespace: namespacesInspectable ? 'verified' : 'kernel access denied; not claimed' }
  summary.inputOperations = []
  const mappedInput = async (input, signal) => {
    const start = performance.now()
    try {
      await bounded(browser.input(input, signal), AbortSignal.any([signal, AbortSignal.timeout(3_000)]))
      summary.inputOperations.push({ stage: summary.stage, elapsedMs: Math.round(performance.now() - start), completed: true })
    } catch (error) {
      summary.inputOperations.push({ stage: summary.stage, elapsedMs: Math.round(performance.now() - start), completed: false })
      throw error
    }
  }
  for (const action of ['down', 'up']) {
    summary.stage = `input-field-pointer-${action}`
    await mappedInput({ kind: 'pointer', action, x: action === 'up' ? 110 : 100, y: 60, button: 'left' }, deadline.signal)
  }
  const text = `synthetic-${randomUUID()}`
  summary.stage = 'input-text'
  await mappedInput({ kind: 'text', text: `${text}x` }, deadline.signal)
  summary.stage = 'input-wheel'
  await mappedInput({ kind: 'wheel', x: 100, y: 60, deltaX: 0, deltaY: 1 }, deadline.signal)
  for (const action of ['down', 'up']) {
    summary.stage = `input-backspace-${action}`
    await mappedInput({ kind: 'key', action, key: 'Backspace', modifiers: 0 }, deadline.signal)
  }
  for (const action of ['down', 'up']) {
    summary.stage = `input-submit-pointer-${action}`
    await mappedInput({ kind: 'pointer', action, x: 100, y: 140, button: 'left' }, deadline.signal)
  }
  summary.stage = 'await-owned-form-post'
  const body = await bounded(submitted, AbortSignal.any([deadline.signal, AbortSignal.timeout(8_000)]))
  assert.equal(new URLSearchParams(body).get('synthetic'), text, 'Actual local form must receive mapped synthetic input')
  assert.equal(guardHits, 0, 'Cross-origin loopback fixture must receive no request')
  assert(!requests.some(request => request.url === '/denied-script'), 'Policy must block script requests')
  summary.input = { pointer: true, text: true, wheel: true, key: true, actualLocalPost: true }
  summary.routing = { forbiddenLoopbackHits: guardHits, scriptDenied: true, osEgressContainment: false }
  const networkAfter = await networkSnapshot(pid)
  summary.networkObservation.after = networkAfter
  assert.equal(networkAfter.nonLoopbackTcp, 0, 'Owned Chrome must have no observed non-loopback TCP socket')
  summary.stage = 'cancel-and-cleanup'
  browserLifetime.abort()
  await browser.close()
  assert.equal(await chromeHandle.waitForExit(AbortSignal.timeout(5_000)), true, 'Cancel must empty native owned range')
  await chromeHandle.done
  await assert.rejects(lstat(chromeSpec.cwd), { code: 'ENOENT' })
  await assert.rejects(readFile(`/proc/${pid}/stat`, 'utf8'), { code: 'ENOENT' })
  assert(chromeIdentity.start, 'Original owned PID identity was observed')
  assert(stderrBytes > 0 && endpointSeenPrivately, 'Actual native raw stderr must privately carry CDP readiness')
  assert(!privatePattern.test(logs) && !loggingOverflow, 'Public native logs must contain no CDP endpoint or raw readiness')
  summary.cleanup = { browserClosed: true, nativeRangeEmpty: true, ownedPidGone: true, profileDeleted: true }
  summary.status = 'passed'
  summary.stage = 'complete'
}
async function root() {
  assert(diagnosticNames.every(name => !process.env[name]), 'Do not run with diagnostics enabled')
  ownedScratch = await mkdtemp(join(await realpath(tmpdir()), 'dsh-dot-native-proof-'))
  await chmod(ownedScratch, 0o700)
  const runtime = await nativeProvider()
  const handle = spawn(runtime, {
    argv: [process.execPath, self, '--fixture-host', '--controlled-fresh-host', ownedScratch],
    cwd: ownedScratch, env: { ...cleanEnvironment(ownedScratch), DSH_DOT_PROOF_RUNTIME: runtimeRoot, DSH_DOT_PROOF_CHROME: chrome }, graceMs: 1_000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, signal: deadline.signal,
  })
  const child = await privateOutput(handle)
  assert(!privatePattern.test(child.stdout), 'No private endpoint may cross the fixture Host output boundary')
  const result = JsonText.parse(child.stdout, fixtureHostSummarySchema)
  Object.assign(summary, result, { fixtureHostNativeRangeEmpty: true, fixtureHostStderrBytes: child.stderrBytes })
  // The fresh Host has now exited and its public native range is empty, so no
  // browser connection remains. Recover ONLY its positively identified profile
  // if the factory retained it. This is reported separately, never called a pass.
  if (result.ownedProfile && result.ownedProfileIdentity) {
    try {
      const path = result.ownedProfile
      assert.equal(dirname(path), ownedScratch, 'Owned profile parent must be the fresh Host TMPDIR')
      assert(path.startsWith(join(ownedScratch, 'dsh-dot-fixture-')), 'Only factory temporary profiles may be reaped')
      const info = await lstat(path)
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Profile must remain an ordinary directory')
      assert.equal(await realpath(path), path, 'Profile must not be redirected')
      assert.equal(info.ino, result.ownedProfileIdentity.ino, 'Profile inode must match')
      assert.equal(info.dev, result.ownedProfileIdentity.dev, 'Profile device must match')
      assert.equal(info.uid, result.ownedProfileIdentity.uid, 'Profile owner must match')
      assert.equal(info.mode & 0o777, 0o700, 'Profile must remain private')
      await rm(path, { recursive: true, force: false })
      summary.retainedProfileReapedByProofOwner = true
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  delete summary.ownedProfile
  delete summary.ownedProfileIdentity
  if (result.networkPreflight && !result.networkPreflight.loopbackOnly) summary.browserNotLaunched = true
  if (child.result.exitCode !== 0) process.exitCode = 1
}
try {
  if (process.argv.includes('--fixture-host')) await fixtureHost()
  else await root()
} catch (error) {
  if (error instanceof Error) {
    summary.failureType = error.name
    if (['Proof deadline reached', 'Synthetic fixture browser failed.', 'Synthetic fixture browser cleanup unconfirmed; private temporary profile retained.'].includes(error.message)) summary.failureDetail = error.message
    if ('code' in error && ['ERR_MODULE_NOT_FOUND', 'ERR_ASSERTION', 'EACCES', 'ENOENT', 'EPERM'].includes(error.code)) summary.failureCode = error.code
    // Only our fixed assertion headings; never actual/expected values or native messages.
    if (error.name === 'AssertionError') summary.assertion = error.message.split('\n')[0]
  }
  // Never serialize exception messages/stacks: native/browser failures can embed
  // private endpoint capabilities. The exact failing stage is safe evidence.
  process.exitCode = 1
} finally {
  browserLifetime?.abort()
  try { await browser?.close() } catch { cleanupConfirmed = false }
  for (const handle of ownedHandles) {
    try {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(5_000))) cleanupConfirmed = false
      await bounded(handle.done.catch(() => undefined), AbortSignal.timeout(5_000))
    } catch { cleanupConfirmed = false }
  }
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
  }
  try { if (provider) await bounded(provider.dispose(), AbortSignal.timeout(5_000)) } catch { cleanupConfirmed = false }
  clearTimeout(timer)
  if (!process.argv.includes('--fixture-host') && ownedScratch && cleanupConfirmed) {
    // Only this root's exact mkdtemp result, after every owned native range joined.
    assert.equal(dirname(ownedScratch), await realpath(tmpdir()))
    assert(ownedScratch.startsWith(join(await realpath(tmpdir()), 'dsh-dot-native-proof-')))
    await rm(ownedScratch, { recursive: true, force: false })
    summary.scratchDeleted = true
  }
  if (!cleanupConfirmed) { summary.cleanupUnconfirmed = true; process.exitCode = 1 }
  summary.elapsedMs = Math.round(performance.now() - started)
  assert(!privatePattern.test(JSON.stringify(summary)), 'Summary must never contain an endpoint')
  console.log(JSON.stringify(summary))
}
