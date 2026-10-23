// Explicit installed CLI + browser overrides only; never launches or reads an existing profile.
import { mkdtemp, writeFile, chmod, rm, access, realpath, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const cli = process.env.DOT_AUTH_VERIFY_DSH_CLI
const browser = process.env.DSHX_E2E_CHROMIUM_EXECUTABLE
if (!cli || !browser || !cli.startsWith('/') || !browser.startsWith('/')) throw new Error('Provide explicit absolute DOT_AUTH_VERIFY_DSH_CLI and DSHX_E2E_CHROMIUM_EXECUTABLE paths.')
await access(cli)
await access(browser)
const temporaryParent = await realpath(tmpdir())
const directory = await mkdtemp(join(temporaryParent, 'dshx-dot-auth-cli-'))
const identity = await stat(directory)
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
async function cleanup() {
  const actual = await realpath(directory)
  const current = await stat(actual)
  if (actual !== directory || dirname(actual) !== temporaryParent || !basename(actual).startsWith('dshx-dot-auth-cli-') || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Refusing unexpected CLI cleanup target.')
  await rm(actual, { recursive: true })
}
try {
  await writeFile(join(directory, 'dsh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o700 })
  await chmod(join(directory, 'dsh'), 0o700)
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DSHX_E2E_PREWARM: '0' }
  for (const args of [['exec', 'bddgen', 'test', '--config=playwright.e2e.config.ts'], ['exec', 'playwright', 'test', '--config=playwright.e2e.config.ts', '--grep', process.argv[2] ?? '@dot-auth-viewer']]) {
    const result = spawnSync('pnpm', args, { cwd, env, stdio: 'inherit' })
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
} finally {
  await cleanup()
}
