#!/usr/bin/env node
// Explicit, synthetic-only TLS/container proof. Never run automatically in app tests.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const optionSchema = z.object({ openssl: z.string().refine(isAbsolute), nativeRuntime: z.string().refine(isAbsolute) }).strict()
const options = optionSchema.parse(
  Object.fromEntries(
    process.argv.slice(2).map(argument => {
      const match = /^--(openssl|nativeRuntime)=(.+)$/u.exec(argument)
      assert(match, 'Use --openssl=/absolute/path --nativeRuntime=/absolute/runtime')
      return [match[1], match[2]]
    }),
  ),
)
assert.equal(process.getuid?.(), 1000, 'This bounded fixture requires the local service UID 1000')
process.umask(0o077)
const id = randomBytes(8).toString('hex')
const label = `dshfiles.bots-container-proof=${id}`
const image = `dsh-bots-service-proof:tls-${id}`
const base = 'sha256:bbf39cb344bb33c1f2eedb3b45b4a890eecfbac91a4f7bac020a95d4e4ea147e'
const parent = await realpath(tmpdir())
const temporary = await mkdtemp(join(parent, 'bots-container-proof-'))
const identity = await lstat(temporary)
const reportRoot = await mkdtemp(join(parent, 'bots-container-report-'))
const reportPath = join(reportRoot, 'report.json')
const artifact = join(temporary, 'artifact')
const privateRoot = join(temporary, 'private')
const report = {
  kind: 'synthetic-normal-node-native-tls-container-proof',
  generatedAt: new Date().toISOString(),
  fixtureLabel: label,
  result: 'incomplete',
  scenarios: [],
  cleanup: {},
  hostGuard: { allowed: 0, blocked: 0 },
  limitations: [
    'No real account, credentials, provider, DSH profile or current GUI was accessed.',
    'Host-network Docker shares the owned host loopback; this is not a bridge/remote-container reachability proof.',
    'The explicit fetch preload is a test seam, NOT an OS firewall or proof of egress containment.',
    'The current plain-LAN-HTTP GUI is not made compatible or secure by this synthetic TLS fixture.',
    'An intentionally malformed synthetic access token proves private delivery and local rejection, not actual Dot authorization.',
  ],
}
let stage = 'initialize'
let context
let authority
let unregister
let imageBuilt = false
let accesses = 0
let keyReads = 0
const containers = new Set()
const logStreams = new Set()
const controlKey = `SYNTHETIC_CONTROL_${randomBytes(32).toString('hex')}`
const authorityKey = `SYNTHETIC_AUTHORITY_${randomBytes(32).toString('hex')}`
const malformedAccess = 'INTENTIONALLY_MALFORMED_SYNTHETIC_ACCESS_TOKEN_NOT_A_JWT'
const secrets = [controlKey, authorityKey, malformedAccess]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (outer, inner) => {
  const path = relative(outer, inner)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
async function command(binary, args, extra = {}) {
  try {
    const output = await exec(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000, ...extra })
    return output.stdout.trim()
  } catch {
    throw new Error(`Synthetic fixture command failed during ${stage}; no command output retained`)
  }
}
async function inspectContainer(container) {
  const rows = JsonText.parse(
    await command('docker', ['inspect', container]),
    z.array(
      z.object({
        Id: z.string(),
        Config: z.object({ User: z.string(), Labels: z.record(z.string(), z.string()) }),
        HostConfig: z.object({ ReadonlyRootfs: z.boolean(), NetworkMode: z.string(), CapDrop: z.array(z.string()), SecurityOpt: z.array(z.string()) }),
        Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean() })),
        State: z.object({ Running: z.boolean(), ExitCode: z.number(), OOMKilled: z.boolean() }),
      }),
    ),
  )
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.Id, container)
  assert.equal(row.Config.Labels['dshfiles.bots-container-proof'], id, 'Only this fixture may manage its container')
  return row
}
async function removeContainer(container) {
  const row = await inspectContainer(container)
  if (row.State.Running) await command('docker', ['stop', '--time', '10', container])
  await inspectContainer(container)
  await command('docker', ['rm', container])
  containers.delete(container)
}
async function auditArtifact(directory) {
  let files = 0
  let links = 0
  async function walk(path) {
    for (const name of await readdir(path)) {
      assert(!['.dsh', '.ssh', '.git', 'cookies.json', 'auth.json', 'storage-state.json'].includes(name), 'Private state is not an artifact input')
      const entry = join(path, name)
      const stat = await lstat(entry)
      if (stat.isSymbolicLink()) {
        assert(inside(directory, await realpath(entry)), 'Production dependency link must resolve inside the artifact')
        links++
      } else if (stat.isDirectory()) await walk(entry)
      else {
        assert(stat.isFile(), 'Artifact contains only regular files and internal dependency links')
        files++
      }
    }
  }
  await walk(directory)
  return { files, links, internalLinksOnly: true, noPrivateStateInputs: true }
}
async function hashPair(source, target) {
  const [left, right] = await Promise.all([readFile(source), readFile(target)])
  assert.equal(sha(left), sha(right), 'Production artifact must contain the current compiled source')
  return { source: relative(root, source), sha256: sha(left), deployedMatches: true }
}
const receiptSchema = z.object({ status: z.literal('listening'), origin: z.string().url(), adapters: z.string() }).strict()
const guardSchema = z.object({ proofGuard: z.literal(true), allowed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative() }).strict()
async function observe(container) {
  const child = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] })
  logStreams.add(child)
  let stdout = ''
  let stderr = ''
  let receipt
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timer = setTimeout(() => rejectReady(new Error('Synthetic container readiness timed out')), 15000)
  timer.unref()
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    if (stdout.length > 65536) rejectReady(new Error('Synthetic logs exceeded bound'))
    for (const line of stdout.split('\n').filter(Boolean)) {
      try {
        const parsed = JsonText.parse(line, receiptSchema)
        if (!receipt) {
          receipt = parsed
          clearTimeout(timer)
          resolveReady(parsed)
        }
      } catch {
        /* Exit-only guard receipts are parsed after shutdown. */
      }
    }
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', () => {
      clearTimeout(timer)
      rejectReady(new Error('Synthetic log observation failed'))
      reject(new Error('Log process failed'))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (!receipt) rejectReady(new Error('Synthetic container exited before readiness'))
      logStreams.delete(child)
      resolve(code)
    })
  })
  return { ready, done, stdout: () => stdout, stderr: () => stderr }
}
async function requireCleanStop(container, observation, dataRoot) {
  await inspectContainer(container)
  await command('docker', ['stop', '--time', '10', container])
  const state = await inspectContainer(container)
  assert.equal(state.State.ExitCode, 0, 'SIGTERM must close the app without blocked provider traffic')
  assert.equal(state.State.OOMKilled, false)
  assert.equal(await observation.done, 0)
  const stdout = observation.stdout()
  const stderr = observation.stderr()
  assert.equal(stderr, '', 'Synthetic service must not emit raw errors')
  assert(!secrets.some(value => stdout.includes(value) || stderr.includes(value)), 'No service keys or synthetic upstream access in logs')
  const audits = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JsonText.parse(line, guardSchema)]
      } catch {
        return []
      }
    })
  assert.equal(audits.length, 1, 'Test-only guard must report its observed fetches on normal exit')
  assert.equal(audits[0].blocked, 0, 'Malformed access must be rejected before any provider fetch')
  await assert.rejects(lstat(join(dataRoot, '.bots-service-owner')), { code: 'ENOENT' })
  const stored = await readFile(join(dataRoot, 'durable_bots.json'), 'utf8')
  assert(!secrets.some(value => stored.includes(value)), 'No service keys or synthetic upstream access in durable state')
  await removeContainer(container)
  return { exitCode: 0, leaseReleased: true, logsRedacted: true, storageRedacted: true, guard: audits[0] }
}
const nativeFetch = globalThis.fetch
let authorityOrigin
// Host fixture calls control HTTP only. No dependency gets general fetch authority.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  const control = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  const exactAuthority = authorityOrigin !== undefined && url.origin === authorityOrigin && url.pathname === authorityPath && !url.search && !url.hash
  if (!control && !exactAuthority) {
    report.hostGuard.blocked++
    process.exitCode = 97
    throw new Error('External requests are forbidden in the synthetic Host fixture')
  }
  report.hostGuard.allowed++
  return nativeFetch(input, init)
}
let authorityPath
try {
  stage = 'local prerequisites'
  report.node = process.version
  report.sourceRevision = await command('git', ['rev-parse', 'HEAD'])
  report.docker = await command('docker', ['version', '--format', '{{.Server.Version}}'])
  const availableBase = await command('docker', ['image', 'inspect', base, '--format', '{{.Id}}'])
  assert.equal(availableBase, base, 'Only the already available official Node22 image may be used')
  report.baseImage = base
  report.openssl = await command(options.openssl, ['version'])
  await mkdir(privateRoot, { mode: 0o700 })
  await writeFile(join(privateRoot, 'control-key'), controlKey, { mode: 0o600 })
  await writeFile(join(privateRoot, 'authority-key'), authorityKey, { mode: 0o600 })
  stage = 'fresh compiled app and offline production deploy'
  await command('node', ['--run', 'build'], { cwd: join(root, 'apps/bots-service') })
  await command('pnpm', ['--filter', '@dshfiles/bots-service', 'deploy', '--prod', '--legacy', '--ignore-scripts', '--offline', artifact])
  report.artifact = await auditArtifact(artifact)
  const artifactRequire = createRequire(join(artifact, 'package.json'))
  report.compiled = await Promise.all([
    hashPair(join(root, 'apps/bots-service/dist/main.js'), join(artifact, 'dist/main.js')),
    hashPair(join(root, 'apps/bots-service/dist/credential-file.js'), join(artifact, 'dist/credential-file.js')),
    ...[
      ['bot-openai-dot', 'account-authority'],
      ['bot-openai-dot', 'adapter'],
      ['bots', 'node'],
      ['bots', 'adapter'],
    ].map(([name, entry]) => hashPair(join(root, 'plugins/@dshfiles', name, `dist/${entry}.js`), artifactRequire.resolve(`@dshfiles/${name}/${entry}`))),
  ])
  stage = 'private synthetic test CA and certificate'
  await command(options.openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=DSH synthetic container proof CA',
    '-keyout',
    join(privateRoot, 'ca-key.pem'),
    '-out',
    join(privateRoot, 'ca.pem'),
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ])
  await command(options.openssl, [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(privateRoot, 'server-key.pem'),
    '-out',
    join(privateRoot, 'server.csr'),
  ])
  await writeFile(
    join(privateRoot, 'extensions.cnf'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 },
  )
  await command(options.openssl, [
    'x509',
    '-req',
    '-in',
    join(privateRoot, 'server.csr'),
    '-CA',
    join(privateRoot, 'ca.pem'),
    '-CAkey',
    join(privateRoot, 'ca-key.pem'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    join(privateRoot, 'extensions.cnf'),
    '-out',
    join(privateRoot, 'server.pem'),
  ])
  await command(options.openssl, ['verify', '-CAfile', join(privateRoot, 'ca.pem'), '-verify_ip', '127.0.0.1', join(privateRoot, 'server.pem')])
  stage = 'actual stock native WebServer TLS fixture'
  const nativeRequire = createRequire(join(await realpath(options.nativeRuntime), 'package.json'))
  const { Context } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/cordis')))
  const { default: WebServer } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-host-webserver')))
  const cordisMetadata = JsonText.parse(await readFile(nativeRequire.resolve('@deepseek-ai/cordis/package.json'), 'utf8'), z.object({ version: z.string() }))
  const webMetadata = JsonText.parse(
    await readFile(nativeRequire.resolve('@deepseek-ai/dsh-host-webserver/package.json'), 'utf8'),
    z.object({ version: z.string() }),
  )
  report.native = { cordis: cordisMetadata.version, webServer: webMetadata.version }
  const { createDotAccountAuthorityHandler, DotAccountAuthorityProtocol } = await import(
    pathToFileURL(artifactRequire.resolve('@dshfiles/bot-openai-dot/account-authority'))
  )
  const { botsApi } = await import(pathToFileURL(artifactRequire.resolve('@dshfiles/bots/api')))
  authorityPath = DotAccountAuthorityProtocol.path
  context = new Context()
  await context.plugin(WebServer, {
    host: '127.0.0.1',
    port: 0,
    tls: { certFile: join(privateRoot, 'server.pem'), keyFile: join(privateRoot, 'server-key.pem') },
  })
  const server = context.get('webServer')
  assert(server, 'Actual native WebServer must activate')
  authorityOrigin = server.getOrigin()
  assert(authorityOrigin.startsWith('https://127.0.0.1:'), 'Fixture listener must be owned literal-loopback TLS')
  report.allowedAuthorityUrl = `${authorityOrigin}${authorityPath}`
  authority = createDotAccountAuthorityHandler({
    expectedOrigin: authorityOrigin,
    accountIds: ['SYNTHETIC_SELECTED_ACCOUNT'],
    acceptRisks: true,
    resolveBearerToken: async signal => {
      signal.throwIfAborted()
      keyReads++
      return authorityKey
    },
    accountAccess: {
      readAccessToken: async (accountId, signal) => {
        signal.throwIfAborted()
        assert.equal(accountId, 'SYNTHETIC_SELECTED_ACCOUNT')
        accesses++
        return malformedAccess
      },
    },
  })
  unregister = server.register({ kind: 'exact', path: authorityPath, handler: authority.handler })
  const guardPath = join(privateRoot, 'guard.mjs')
  // The existing app guard intentionally permits HTTP only and cannot serve a TLS test.
  await writeFile(
    guardPath,
    `const original = globalThis.fetch;\nlet allowed=0,blocked=0;\nconst endpoint=${JSON.stringify(report.allowedAuthorityUrl)};\nglobalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);if(url.href!==endpoint){blocked++;process.exitCode=97;throw new Error('External fetch forbidden in synthetic TLS proof')}allowed++;return original(input,init)};\nprocess.once('beforeExit',()=>process.stdout.write(JSON.stringify({proofGuard:true,allowed,blocked})+'\\n'));\n`,
    { mode: 0o600 },
  )
  stage = 'offline network-disabled Docker build'
  await command('docker', ['build', '--pull=false', '--network=none', '--label', label, '-t', image, artifact])
  imageBuilt = true
  report.imageId = await command('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])
  async function scenario(name, trust, dataRoot, connect) {
    stage = name
    const existing = await lstat(dataRoot).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined) await mkdir(dataRoot, { mode: 0o700 })
    const before = { accesses, keyReads }
    const args = [
      'create',
      '--label',
      label,
      '--name',
      `bots-tls-${id}-${name}`,
      '--network',
      'host',
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '512m',
      '--mount',
      `type=bind,src=${dataRoot},dst=/data`,
      '--mount',
      `type=bind,src=${join(privateRoot, 'control-key')},dst=/proof/control-key,readonly`,
      '--mount',
      `type=bind,src=${join(privateRoot, 'authority-key')},dst=/proof/authority-key,readonly`,
      '--mount',
      `type=bind,src=${guardPath},dst=/proof/guard.mjs,readonly`,
      '-e',
      'BOTS_SERVICE_HOST=127.0.0.1',
      '-e',
      'BOTS_SERVICE_PORT=0',
      '-e',
      'BOTS_SERVICE_TOKEN_FILE=/proof/control-key',
      '-e',
      'BOTS_SERVICE_ADAPTERS=openai-dot',
      '-e',
      `BOTS_SERVICE_DOT_AUTHORITY_ORIGIN=${authorityOrigin}`,
      '-e',
      'BOTS_SERVICE_DOT_AUTHORITY_TOKEN_FILE=/proof/authority-key',
    ]
    if (trust) args.push('--mount', `type=bind,src=${join(privateRoot, 'ca.pem')},dst=/proof/ca.pem,readonly`, '-e', 'NODE_EXTRA_CA_CERTS=/proof/ca.pem')
    args.push(image, 'node', '--import', '/proof/guard.mjs', 'dist/main.js')
    const container = await command('docker', args)
    assert.match(container, /^[a-f0-9]{64}$/u)
    containers.add(container)
    const settings = await inspectContainer(container)
    assert.equal(settings.Config.User, '1000:1000')
    assert.equal(settings.HostConfig.ReadonlyRootfs, true)
    assert.equal(settings.HostConfig.NetworkMode, 'host')
    assert(settings.HostConfig.CapDrop.includes('ALL'))
    assert(settings.HostConfig.SecurityOpt.some(value => value.startsWith('no-new-privileges')))
    const mounts = settings.Mounts.map(mount => {
      assert.equal(mount.Type, 'bind')
      assert(inside(temporary, mount.Source), 'Mount only this fixture private files and dedicated data')
      assert.equal(mount.RW, mount.Destination === '/data', 'All key, CA and guard mounts are read-only')
      return { destination: mount.Destination, writable: mount.RW }
    })
    assert.equal(mounts.length, trust ? 5 : 4)
    await command('docker', ['start', container])
    const observation = await observe(container)
    const receipt = await observation.ready
    assert.equal(receipt.adapters, 'openai-dot')
    const headers = { authorization: `Bearer ${controlKey}`, 'content-type': 'application/json' }
    async function request(path, init = {}) {
      const response = await fetch(`${receipt.origin}${path}`, { ...init, signal: AbortSignal.timeout(15000) })
      const text = await response.text()
      assert(!secrets.some(value => text.includes(value)), 'Control responses must not expose backend key/access values')
      return { response, text }
    }
    const health = await request('/healthz')
    assert.equal(health.response.status, 200)
    const denied = await request('/v1/snapshot')
    assert.equal(denied.response.status, 401)
    const current = await request('/v1/snapshot', { headers })
    assert.equal(current.response.status, 200)
    async function snapshot(text) {
      const decoded = await botsApi.methods.snapshot.output['~standard'].validate(JsonText.parse(text, z.json()))
      assert.equal(decoded.issues, undefined)
      return decoded.value
    }
    let state = await snapshot(current.text)
    assert.deepEqual(
      state.adapters[0].fields.map(field => field.key),
      ['accountId'],
    )
    assert.equal(state.adapters[0].credentialManagement, undefined)
    assert.equal(state.bots.length, 0)
    if (connect) {
      const connected = await request('/v1/connect', {
        method: 'POST',
        headers,
        body: JSON.stringify({ adapterId: 'openai-dot', label: 'Synthetic TLS only', config: { accountId: 'SYNTHETIC_SELECTED_ACCOUNT' }, acceptRisks: true }),
      })
      assert.equal(connected.response.status, 200)
      state = await snapshot(connected.text)
      assert.equal(state.connections.at(-1).status, 'auth-required')
      assert.equal(state.bots.length, 0)
    }
    const runtime = JsonText.parse(
      await command('docker', [
        'exec',
        container,
        'node',
        '-e',
        'console.log(JSON.stringify({uid:process.getuid(),node:process.version,extraCA:!!process.env.NODE_EXTRA_CA_CERTS,insecureTLS:process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0"}))',
      ]),
      z.object({ uid: z.literal(1000), node: z.literal('v22.23.3'), extraCA: z.boolean(), insecureTLS: z.literal(false) }).strict(),
    )
    assert.equal(runtime.extraCA, trust)
    if (!trust) {
      assert.equal(accesses, before.accesses, 'Untrusted CA must prevent owner access')
      assert.equal(keyReads, before.keyReads, 'Untrusted CA must prevent authority bearer resolution')
      const diagnostic = (
        await command('docker', [
          'exec',
          container,
          'node',
          '--import',
          '/proof/guard.mjs',
          '--input-type=module',
          '-e',
          `try{await fetch(${JSON.stringify(report.allowedAuthorityUrl)});console.log(JSON.stringify({unexpectedSuccess:true}))}catch(error){console.log(JSON.stringify({tlsErrorCode:error.cause?.code??null}))}`,
        ])
      ).split('\n')[0]
      // This command reports only a native TLS error code, never an exception/cause or credential.
      const tls = JsonText.parse(
        diagnostic,
        z.object({ tlsErrorCode: z.enum(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) }).strict(),
      )
      report.negativeTlsError = tls.tlsErrorCode
    } else {
      assert(accesses > before.accesses, 'Trusted TLS must deliver the selected current access into the app')
      assert(keyReads > before.keyReads)
    }
    const closed = await requireCleanStop(container, observation, dataRoot)
    const result = {
      name,
      trustedCA: trust,
      controlOrigin: receipt.origin,
      authorityAccesses: accesses - before.accesses,
      authorityKeyReads: keyReads - before.keyReads,
      revision: state.revision,
      metadataAccountIdOnly: true,
      managementAbsent: true,
      health200: true,
      unauthenticated401: true,
      noBotCreated: true,
      runtime,
      security: {
        user: settings.Config.User,
        readOnlyRoot: settings.HostConfig.ReadonlyRootfs,
        network: settings.HostConfig.NetworkMode,
        capDrop: settings.HostConfig.CapDrop,
        noNewPrivileges: true,
        mounts,
      },
      ...closed,
    }
    report.scenarios.push(result)
    return result
  }
  const negative = await scenario('untrusted-ca', false, join(temporary, 'negative-data'), true)
  assert.equal(negative.guard.allowed, 1)
  const trustedData = join(temporary, 'trusted-data')
  const trusted = await scenario('trusted-ca', true, trustedData, true)
  assert.equal(trusted.guard.allowed, 1)
  const restarted = await scenario('trusted-restart', true, trustedData, true)
  assert(restarted.revision > trusted.revision, 'Restart must reopen and advance the durable root after lease release')
  assert.equal(report.hostGuard.blocked, 0, 'No Host fixture dependency may attempt external fetch')
  report.result = 'passed'
} catch (error) {
  report.result = 'failed'
  report.failedStage = stage
  report.failureReason = error instanceof Error ? error.message : 'Synthetic proof failed'
  for (const value of secrets) report.failureReason = report.failureReason.replaceAll(value, '[REDACTED]')
  process.exitCode ??= 1
} finally {
  stage = 'cleanup'
  try {
    for (const container of [...containers]) await removeContainer(container)
    for (const child of logStreams) child.kill('SIGTERM')
    authority?.close()
    unregister?.()
    await context?.fiber.dispose()
    report.cleanup.containersRemoved = containers.size === 0
    report.cleanup.nativeWebServerClosed = true
    if (imageBuilt) {
      const metadata = JsonText.parse(
        await command('docker', ['image', 'inspect', image, '--format', '{{json .Config.Labels}}']),
        z.record(z.string(), z.string()),
      )
      assert.equal(metadata['dshfiles.bots-container-proof'], id, 'Only this fixture image may be removed')
      await command('docker', ['image', 'rm', image])
      report.cleanup.testImageRemoved = true
    }
    const current = await lstat(temporary)
    assert.equal(await realpath(temporary), temporary)
    assert.equal(dirname(temporary), parent)
    assert(basename(temporary).startsWith('bots-container-proof-'))
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    assert.equal(current.uid, process.getuid())
    // Exact absolute root and its original identity are verified above; never touch another fixture's output.
    await rm(temporary, { recursive: true })
    report.cleanup.privateMaterialAndArtifactRemoved = true
    report.cleanup.removedTemporaryRoot = temporary
  } catch {
    report.result = 'failed'
    report.cleanup.failed = true
    process.exitCode ??= 1
  }
  globalThis.fetch = nativeFetch
  report.completedAt = new Date().toISOString()
  report.helperSha256 = sha(await readFile(fileURLToPath(import.meta.url)))
  assert(!secrets.some(value => JSON.stringify(report).includes(value)), 'Metadata report cannot contain keys/access')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ result: report.result, report: reportPath, failedStage: report.failedStage ?? null })}\n`)
}
