import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, chmod, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const token = 'SYNTHETIC_PRIVATE_NODE_PROCESS_SERVICE_TOKEN'
const receiptSchema = z.object({ status: z.literal('listening'), origin: z.string().url(), adapters: z.literal('none-configured') }).strict()
const snapshotSchema = z.object({ revision: z.number(), connections: z.array(z.unknown()).length(0), bots: z.array(z.unknown()).length(0) })

function launch(env) {
  const child = spawn(process.execPath, [cli], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
        const snapshot = JsonText.parse(await response.text(), snapshotSchema)
        assert(snapshot.revision > revision, 'A fresh process must reopen and advance the existing durable state')
        revision = snapshot.revision
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
    for (const mode of ['missing', 'public', 'symlink']) {
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
      const process = launch({ ...env, BOTS_SERVICE_TOKEN_FILE: path })
      const result = await process.exit
      assert.equal(result.code, 1)
      assert.equal(process.stdout().length, 0)
      assert(!process.stderr().includes(token) && !process.stderr().includes(root), 'Failure diagnostics must not expose input or paths')
      await assert.rejects(lstat(env.BOTS_SERVICE_DATA_DIR), { code: 'ENOENT' })
    }
  })
})
