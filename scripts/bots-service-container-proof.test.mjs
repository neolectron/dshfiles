import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { BotsContainerProofIsolation as Isolation } from './bots-service-container-proof.mjs'

test('the packaging snapshot and artifact cannot overlap the source or each other', () => {
  Isolation.assertDisjoint('/source', '/tmp/owned', '/tmp/owned/source-snapshot', '/tmp/owned/artifact')
  for (const paths of [
    ['/source', '/source/owned', '/source/owned/snapshot', '/source/owned/artifact'],
    ['/source', '/', '/snapshot', '/artifact'],
    ['/source', '/tmp/owned', '/outside/snapshot', '/tmp/owned/artifact'],
    ['/source', '/tmp/owned', '/tmp/owned/snapshot', '/tmp/owned/snapshot/artifact'],
    ['/source', '/tmp/owned', '/tmp/owned/artifact/source', '/tmp/owned/artifact'],
  ])
    assert.throws(() => Isolation.assertDisjoint(...paths))
})

test('both development install and legacy production deploy are pinned to the disjoint private workspace', () => {
  const environment = { HOME: '/tmp/owned/home', PATH: '/pinned/bin' }
  for (const args of [
    ['install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts'],
    ['--filter', '@dshfiles/bots-service', 'deploy', '--prod', '--legacy', '--offline'],
  ]) {
    const invocation = Isolation.privatePnpm('/pinned/pnpm', args, '/tmp/owned/source-snapshot', environment, '/source')
    assert.equal(invocation.binary, '/pinned/pnpm')
    assert.equal(invocation.extra.cwd, '/tmp/owned/source-snapshot')
    assert.equal(invocation.extra.env, environment)
    assert.equal(invocation.args, args)
    for (const unsafe of ['/source', '/source/child', '/']) assert.throws(() => Isolation.privatePnpm('/pinned/pnpm', args, unsafe, environment, '/source'))
  }
})

test('production freshness covers transitive SDK source and build config but not unrelated E2E or test files', () => {
  const inputs = Isolation.productionInputs([
    { name: '@dshfiles/bots-service', directory: 'apps/bots-service', dependencies: { '@dshfiles/bot-openai-dot': 'workspace:*' } },
    { name: '@dshfiles/bot-openai-dot', directory: 'plugins/@dshfiles/bot-openai-dot', devDependencies: { '@dshfiles/dshx': 'workspace:*' } },
    { name: '@dshfiles/dshx', directory: 'tooling/dshx/packages/dshx', dependencies: { '@dshfiles/bot-openai-dot': 'workspace:*' } },
    { name: 'unrelated', directory: 'plugins/@dshfiles/unrelated' },
  ])
  assert(inputs.paths.includes('pnpm-lock.yaml'))
  assert(inputs.paths.includes('pnpm-workspace.yaml'))
  assert(inputs.paths.includes('apps/bots-service/src'))
  assert(inputs.paths.includes('tooling/dshx/packages/dshx/src'))
  assert(inputs.paths.includes('tooling/dshx/packages/dshx/tsconfig*.json'))
  assert(
    !inputs.paths.filter(path => !path.startsWith(':(exclude)')).some(path => path.includes('/tests') || path.includes('/e2e') || path.includes('unrelated')),
  )
  assert(inputs.paths.includes(':(exclude)**/*.test.*'))
  assert(inputs.paths.includes(':(exclude)**/*.spec.*'))
  assert.equal(inputs.packages.length, 3)
  assert.throws(() => Isolation.productionInputs([]))
})

test('install-state capture detects deferred workspace-state poisoning without restoring anything', async () => {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'bots-proof-isolation-test-'))
  const identity = await lstat(root)
  try {
    await mkdir(join(root, 'node_modules'), { mode: 0o700 })
    const state = join(root, 'node_modules/.pnpm-workspace-state-v1.json')
    await writeFile(state, JSON.stringify({ settings: { production: true, dev: true } }), { mode: 0o600 })
    await writeFile(join(root, 'node_modules/.modules.yaml'), JSON.stringify({ included: { devDependencies: true } }), { mode: 0o600 })
    const before = await Isolation.installState(root)
    Isolation.assertUnchanged(before, await Isolation.installState(root))
    await writeFile(state, JSON.stringify({ settings: { production: true, dev: false } }), { mode: 0o600 })
    const after = await Isolation.installState(root)
    assert.throws(() => Isolation.assertUnchanged(before, after), /never restore or overwrite a concurrent installer/u)
    assert.notEqual(before.files['.pnpm-workspace-state-v1.json'].sha256, after.files['.pnpm-workspace-state-v1.json'].sha256)
    assert.equal(before.files['.modules.yaml'].sha256, after.files['.modules.yaml'].sha256)
    assert.deepEqual(await Isolation.installState(root), after, 'Detection must not repair or overwrite the changed state')
  } finally {
    const current = await lstat(root)
    assert.equal(await realpath(root), root)
    assert.equal(dirname(root), parent)
    assert(basename(root).startsWith('bots-proof-isolation-test-'))
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    await rm(root, { recursive: true })
  }
})
