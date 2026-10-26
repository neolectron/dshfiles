import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../scripts/verify-local.mjs', import.meta.url))
const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 16_384 })

it('documents that operator health is non-mutating by default and creation requires confirmation', () => {
  const result = run('--help')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Default: authenticated health only')
  expect(result.stdout).toContain('--confirm-create')
})

it('refuses public endpoints and mutually exclusive mutation/read flags before credential access', () => {
  for (const args of [
    ['--url', 'https://example.invalid/mcp'],
    ['--confirm-create', '--read-probe-task', 'task-proof'],
  ]) {
    const result = run(...args, '--credential-file', '/nonexistent/private-credential')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('verification-failed')
    expect(result.stderr).not.toContain('/nonexistent/private-credential')
    expect(result.stdout).not.toContain('admission')
  }
})

it('refuses a non-private credential file without printing its synthetic contents', async () => {
  const prefix = join(tmpdir(), 'dsh-mcp-probe-test-')
  const root = await mkdtemp(prefix)
  if (!root.startsWith(prefix)) throw new Error('Unexpected operator-probe fixture root')
  const file = join(root, 'gateway.env')
  const sentinel = 'SYNTH_secret_must_never_enter_probe_output'
  try {
    await writeFile(file, `DSH_MCP_YIELD_TOKEN=${sentinel}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(file, 0o644)
    const result = run('--credential-file', file)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('credentialValuesDisplayed')
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
