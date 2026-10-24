import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, chmod, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { botsApi } from '@dshfiles/bots/api'

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const token = 'SYNTHETIC_PRIVATE_NODE_PROCESS_SERVICE_TOKEN'
const receiptSchema = z.object({ status: z.literal('listening'), origin: z.string().url(), adapters: z.string().min(1) }).strict()
async function snapshot(response) {
  const result = await botsApi.methods.snapshot.output['~standard'].validate(JsonText.parse(await response.text(), z.json()))
  assert.equal(result.issues, undefined)
  return result.value
}

function launch(env) {
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./network-guard.js', import.meta.url)), cli], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Synthetic CLI process could not start')))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    if (stdout.length > 8192) child.kill('SIGKILL')
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
    if (stderr.length > 8192) child.kill('SIGKILL')
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15000)
  deadline.unref()
  void exit.finally(() => clearTimeout(deadline))
  return { child, exit, stdout: () => stdout, stderr: () => stderr }
}
async function ready(process) {
  for (;;) {
    const text = process.stdout()
    const newline = text.indexOf('\n')
    if (newline >= 0) return JsonText.parse(text.slice(0, newline), receiptSchema)
    const result = await Promise.race([once(process.child.stdout, 'data').then(() => 'data'), process.exit.then(() => 'exit')])
    if (result === 'exit') throw new Error('Synthetic service exited before readiness')
  }
}
async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM')
  return process.exit
}
async function fixture(run) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'bots-node-process-'))
  const identity = await lstat(root)
  const tokenFile = join(root, 'service-token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const env = { PATH: process.env.PATH ?? '', BOTS_SERVICE_DATA_DIR: join(root, 'data'), BOTS_SERVICE_TOKEN_FILE: tokenFile, BOTS_SERVICE_PORT: '0' }
  try {
    await run({ root, tokenFile, env })
  } finally {
    const current = await lstat(root)
    assert.equal(dirname(root), parent)
    assert(basename(root).startsWith('bots-node-process-'))
    assert.equal(await realpath(root), root)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    await rm(root, { recursive: true })
  }
}

test('the built ordinary Node CLI authenticates, persists its revision and releases ownership on SIGTERM', async () => {
  await fixture(async ({ env }) => {
    let revision = -1
    for (let attempt = 0; attempt < 2; attempt++) {
      const process = launch(env)
      try {
        const receipt = await ready(process)
        const health = await fetch(`${receipt.origin}/healthz`)
        assert.equal(health.status, 200)
        await health.body?.cancel()
        const denied = await fetch(`${receipt.origin}/v1/snapshot`)
        assert.equal(denied.status, 401)
        await denied.body?.cancel()
        const response = await fetch(`${receipt.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${token}` } })
        assert.equal(response.status, 200)
        const state = await snapshot(response)
        assert.equal(receipt.adapters, 'none-configured')
        assert.equal(state.adapters.length, 0)
        assert.equal(state.connections.length, 0)
        assert.equal(state.bots.length, 0)
        assert(state.revision > revision, 'A fresh process must reopen and advance the existing durable state')
        revision = state.revision
        assert.equal(process.stderr().length, 0, 'Healthy service must not emit diagnostics')
        assert(!process.stdout().includes(token), 'Service token must never be logged')
      } finally {
        const result = await stop(process)
        assert.equal(result.code, 0, 'Normal SIGTERM must close the service cleanly')
      }
    }
  })
})

test('the ordinary Node CLI refuses missing/public/symlink credential files without leaking values or paths', async () => {
  await fixture(async ({ root, tokenFile, env }) => {
    for (const mode of ['missing', 'public', 'symlink', 'fifo']) {
      let path = join(root, 'missing')
      if (mode === 'public') {
        await chmod(tokenFile, 0o644)
        path = tokenFile
      }
      if (mode === 'symlink') {
        await chmod(tokenFile, 0o600)
        const { symlink } = await import('node:fs/promises')
        path = join(root, 'linked-token')
        await symlink(tokenFile, path)
      }
      if (mode === 'fifo') {
        path = join(root, 'token-fifo')
        assert.equal(spawnSync('mkfifo', ['-m', '600', path]).status, 0)
      }
      const process = launch({ ...env, BOTS_SERVICE_TOKEN_FILE: path })
      const result = await process.exit
      assert.equal(result.code, 1)
      assert.equal(process.stdout().length, 0)
      assert(!process.stderr().includes(token) && !process.stderr().includes(root), 'Failure diagnostics must not expose input or paths')
      await assert.rejects(lstat(env.BOTS_SERVICE_DATA_DIR), { code: 'ENOENT' })
    }
  })
})

test('explicit Dot composition exposes metadata only and cannot grant writes to its read-only credential backend', async () => {
  await fixture(async ({ root, env }) => {
    const credentialsFile = join(root, 'references.json')
    await writeFile(credentialsFile, JSON.stringify({ 'secret:ACCESS': 'SYNTHETIC_ACCESS_NOT_A_JWT', 'secret:SESSION': 'SYNTHETIC_SESSION_NOT_A_COOKIE' }), {
      mode: 0o600,
    })
    const process = launch({ ...env, BOTS_SERVICE_ADAPTERS: 'openai-dot', BOTS_SERVICE_CREDENTIALS_FILE: credentialsFile })
    try {
      const receipt = await ready(process)
      assert.equal(receipt.adapters, 'openai-dot')
      const response = await fetch(`${receipt.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      const state = await snapshot(response)
      assert.equal(state.adapters.length, 1)
      assert.equal(state.adapters[0].id, 'openai-dot')
      assert.equal(state.adapters[0].credentialManagement, undefined)
      assert.equal(state.bots.length, 0)
      assert.equal(state.connections.length, 0)
      const denied = await fetch(`${receipt.origin}/v1/connect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          adapterId: 'openai-dot',
          label: 'Synthetic only',
          config: { accessTokenRef: 'secret:ACCESS', sessionTokenRef: 'secret:SESSION' },
          acceptRisks: true,
          manageCredentials: true,
        }),
      })
      assert.equal(denied.status, 409)
      await denied.body?.cancel()
      assert.equal(process.stderr().length, 0, 'Provider fixture must not emit raw diagnostics')
      assert(!process.stdout().includes(token) && !process.stdout().includes('SYNTHETIC_ACCESS_NOT_A_JWT'))
    } finally {
      assert.equal((await stop(process)).code, 0, 'No external fetch may be attempted and shutdown must be clean')
    }
  })
})

test('unknown or duplicate providers and unsafe provider files fail before durable storage is created', async () => {
  await fixture(async ({ root, env }) => {
    const credentialsFile = join(root, 'references.json')
    await writeFile(credentialsFile, JSON.stringify({ 'secret:ACCESS': 'SYNTHETIC_ONLY' }), { mode: 0o600 })
    const fifo = join(root, 'references-fifo')
    assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0)
    const configured = { ...env, BOTS_SERVICE_ADAPTERS: 'openai-dot', BOTS_SERVICE_CREDENTIALS_FILE: credentialsFile }
    for (const patch of [
      { BOTS_SERVICE_ADAPTERS: 'unknown' },
      { BOTS_SERVICE_ADAPTERS: 'openai-dot,openai-dot' },
      { BOTS_SERVICE_CREDENTIALS_FILE: undefined },
      { BOTS_SERVICE_CREDENTIALS_FILE: fifo },
    ]) {
      const process = launch({ ...configured, ...patch })
      assert.equal((await process.exit).code, 1)
      assert.equal(process.stdout().length, 0)
      assert(!process.stderr().includes(root) && !process.stderr().includes(token))
      await assert.rejects(lstat(env.BOTS_SERVICE_DATA_DIR), { code: 'ENOENT' })
    }
  })
})
