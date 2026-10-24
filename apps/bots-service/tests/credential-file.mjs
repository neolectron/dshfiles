import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, link, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { readCredentialFile } from '../dist/credential-file.js'

async function fixture(run) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'bots-credential-file-'))
  const identity = await lstat(root)
  const file = join(root, 'references.json')
  try {
    await run({ root, file })
  } finally {
    const current = await lstat(root)
    assert.equal(dirname(root), parent)
    assert(basename(root).startsWith('bots-credential-file-'))
    assert.equal(await realpath(root), root)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    await rm(root, { recursive: true })
  }
}
const reference = alias => ({ reference: { alias, environment: 'prod' }, cwd: null })
async function refused(path) {
  await assert.rejects(readCredentialFile(path), error => {
    assert.equal(error.message, 'Service provider credentials are unavailable. Check the explicit private reference file.')
    assert(!error.message.includes(path))
    return true
  })
}

test('the private service reference file yields an immutable whole-map process snapshot', async () => {
  await fixture(async ({ file }) => {
    await writeFile(
      file,
      JSON.stringify({ 'secret:ACCESS': 'SYNTHETIC_ACCESS_A', 'secret:SESSION': 'SYNTHETIC_SESSION_A', 'secret:EXAMPLE@dev': 'SYNTHETIC_DEV' }),
      { mode: 0o600 },
    )
    const first = await readCredentialFile(file)
    assert.deepEqual(Object.keys(first), ['resolve'])
    assert(Object.isFrozen(first))
    assert.equal(await first.resolve(reference('ACCESS')), 'SYNTHETIC_ACCESS_A')
    assert.equal(await first.resolve(reference('SESSION')), 'SYNTHETIC_SESSION_A')
    assert.equal(await first.resolve({ reference: { alias: 'EXAMPLE', environment: 'dev' }, cwd: null }), 'SYNTHETIC_DEV')
    await writeFile(file, JSON.stringify({ 'secret:ACCESS': 'SYNTHETIC_ACCESS_B', 'secret:SESSION': 'SYNTHETIC_SESSION_B' }))
    assert.equal(await first.resolve(reference('ACCESS')), 'SYNTHETIC_ACCESS_A')
    assert.equal(await first.resolve(reference('SESSION')), 'SYNTHETIC_SESSION_A')
    const second = await readCredentialFile(file)
    assert.equal(await second.resolve(reference('ACCESS')), 'SYNTHETIC_ACCESS_B')
    assert.equal(await second.resolve(reference('SESSION')), 'SYNTHETIC_SESSION_B')
    await assert.rejects(first.resolve(reference('MISSING')))
    await assert.rejects(first.resolve({ ...reference('ACCESS'), cwd: '/unrelated-project' }))
  })
})

test('the reference reader refuses malformed, noncanonical and oversized content without echoing it', async () => {
  await fixture(async ({ file }) => {
    const cases = [
      '{PRIVATE_CONTENT_CANARY',
      '{}',
      JSON.stringify({ 'raw-alias': 'PRIVATE_CONTENT_CANARY' }),
      JSON.stringify({ 'secret:ALIAS@prod': 'PRIVATE_CONTENT_CANARY' }),
      JSON.stringify({ ' secret:ALIAS': 'PRIVATE_CONTENT_CANARY' }),
      JSON.stringify({ 'secret:ALIAS': '' }),
      JSON.stringify({ 'secret:ALIAS': { value: 'PRIVATE_CONTENT_CANARY' } }),
      JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`secret:A${i}`, 'SYNTHETIC']))),
      'x'.repeat(256 * 1024 + 1),
      Buffer.from([0xc0, 0xaf]),
    ]
    for (const text of cases) {
      await writeFile(file, text, { mode: 0o600 })
      await refused(file)
    }
  })
})

test('the reference reader refuses public, symlinked, hardlinked and aliased inputs', async () => {
  await fixture(async ({ root, file }) => {
    await writeFile(file, JSON.stringify({ 'secret:ALIAS': 'SYNTHETIC_ONLY' }), { mode: 0o600 })
    await chmod(file, 0o644)
    await refused(file)
    await chmod(file, 0o600)
    const symbolic = join(root, 'symbolic')
    await symlink(file, symbolic)
    await refused(symbolic)
    const hard = join(root, 'hard')
    await link(file, hard)
    await refused(hard)
    await refused(file)
    await refused(`${root}/../${basename(root)}/references.json`)
    await refused('relative-references.json')
    await refused(root)
  })
})
