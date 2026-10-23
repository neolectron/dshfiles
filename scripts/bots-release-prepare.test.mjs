import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { BotsReleasePreparation } from './bots-release-prepare.mjs'
import { BotsReleaseVerification } from './bots-release-verify.mjs'
const { assertEmptyOutput, check, contains, parseArgs, prepare, prospectiveRealpath, sourcePlan, treeInventory, validateRoots } = BotsReleasePreparation
const { compareStylesheets, cssSelectors, extractCss } = BotsReleaseVerification

test('external retention excludes every staged package rather than naming only Bots', () => {
  const output = '/tmp/candidate'
  const link = (name, target) => ({ path: join(output, 'node_modules', name), target, realTarget: target })
  const links = [
    link('@deepseek-ai', '/runtime/node_modules/@deepseek-ai'),
    link('@dshfiles/bots', join(output, 'packages/@dshfiles/bots')),
    link('@dshfiles/secret-catalog', join(output, 'packages/@dshfiles/secret-catalog')),
    link('@dshfiles/credential-port', '/source/credential-port'),
    link('sibling', '/tmp/candidate-sibling/runtime'),
  ]
  assert.deepEqual(BotsReleasePreparation.retainedTargets(links, output), ['/source/credential-port', '/tmp/candidate-sibling/runtime'])
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bots-release-test-'))
  t.after(async () => {
    // Delete only the exact fresh fixture directory, never a computed user output.
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}/bots-release-test-`))
    await rm(root, { recursive: true, force: true })
  })
  const roots = { sourceRoot: join(root, 'feature'), servingRoot: join(root, 'serving'), runtimeRoot: join(root, 'runtime'), output: join(root, 'candidate') }
  await Promise.all([roots.sourceRoot, roots.servingRoot, roots.runtimeRoot].map(path => mkdir(path)))
  return { root, roots }
}
async function save(path, text) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, text)
}

for (const protectedName of ['sourceRoot', 'servingRoot', 'runtimeRoot']) {
  test(`refuses equal, descendant and ancestor output overlap with ${protectedName}`, async t => {
    const { roots, root } = await fixture(t)
    for (const output of [roots[protectedName], join(roots[protectedName], 'new'), root])
      await assert.rejects(validateRoots({ ...roots, output }), /overlaps protected/)
  })
}
test('requires explicit serving, runtime and output options', async t => {
  const { roots } = await fixture(t)
  for (const name of ['servingRoot', 'runtimeRoot', 'output']) {
    const options = { ...roots }
    delete options[name]
    await assert.rejects(validateRoots(options), /Explicit --/)
  }
})
test('accepts disjoint sibling roots and avoids string-prefix false overlap', async t => {
  const { roots } = await fixture(t)
  const output = `${roots.sourceRoot}-candidate`
  assert.equal((await validateRoots({ ...roots, output })).output, output)
  assert.equal(contains(roots.sourceRoot, output), false)
})
test('resolves symlink ancestors before checking nonexistent output', async t => {
  const { roots, root } = await fixture(t)
  const alias = join(root, 'serving-alias')
  await symlink(roots.servingRoot, alias, 'dir')
  assert.equal(await prospectiveRealpath(join(alias, 'new/deep')), join(roots.servingRoot, 'new/deep'))
  await assert.rejects(validateRoots({ ...roots, output: join(alias, 'new/deep') }), /overlaps protected/)
})
test('rejects output directory aliases even when their targets are safe', async t => {
  const { roots, root } = await fixture(t)
  const target = join(root, 'safe-empty')
  await mkdir(target)
  await symlink(target, roots.output, 'dir')
  await assert.rejects(validateRoots(roots), /must not be a symlink/)
})
test('rejects private/dependency output components', async t => {
  const { roots, root } = await fixture(t)
  for (const component of ['local-state', 'browser', 'accounts', 'node_modules', 'profiles', '.git', '.ssh', '.dsh'])
    await assert.rejects(validateRoots({ ...roots, output: join(root, component, 'candidate') }), /Unsafe output/)
})
test('refuses CSS quoting/control characters before creating output', async t => {
  const { roots, root } = await fixture(t)
  for (const suffix of ["bad'path", 'bad"path', 'bad\\path', 'bad\npath']) {
    await assert.rejects(validateRoots({ ...roots, output: join(root, suffix) }), /CSS quoting/)
  }
  assert.deepEqual((await readdir(root)).sort(), ['feature', 'runtime', 'serving'])
})
test('protects explicit profile roots independently of serving root', async t => {
  const { roots, root } = await fixture(t)
  const profileRoot = join(root, 'profile')
  await mkdir(profileRoot)
  await assert.rejects(validateRoots({ ...roots, profileRoot, output: join(profileRoot, 'candidate') }), /overlaps protected/)
})
test('refuses existing nonempty unowned output without reading sources or changing it', async t => {
  const { roots } = await fixture(t)
  await mkdir(roots.output)
  const sentinel = join(roots.output, 'valuable.txt')
  await writeFile(sentinel, 'do not replace')
  await assert.rejects(prepare(roots), /nonempty unowned/)
  assert.equal(await readFile(sentinel, 'utf8'), 'do not replace')
  assert.deepEqual(await readdir(roots.output), ['valuable.txt'])
})
test('refuses corrupt owned output instead of rebuilding, deleting or repairing it', async t => {
  const { roots } = await fixture(t)
  await mkdir(roots.output)
  await writeFile(join(roots.output, '.bots-release-prepare.json'), '{}')
  await assert.rejects(prepare(roots))
  assert.deepEqual(await readdir(roots.output), ['.bots-release-prepare.json'])
  assert.equal(await readFile(join(roots.output, '.bots-release-prepare.json'), 'utf8'), '{}')
})
test('check rejects unexpected candidate names before opening bytes or resolving private symlinks', async t => {
  const { roots, root } = await fixture(t)
  await mkdir(roots.output)
  const digest = data => createHash('sha256').update(data).digest('hex')
  const markerPath = join(roots.output, '.bots-release-prepare.json')
  const markerText = JSON.stringify({ schemaVersion: 1, owner: 'bots-release-prepare', roots })
  await writeFile(markerPath, markerText)
  const hash = '0'.repeat(64)
  // Valid metadata only: this test must reject at the filesystem preflight,
  // before any dependency resolution, source hashing or runtime verification.
  const verification = BotsReleaseVerification.evidenceSchema.parse({
    stockCordisVersion: '4.0.5',
    stockCordisIdentity: true,
    imports: [],
    publicApiImported: true,
    publicCatalogApi: { canonical: '/synthetic/catalog-api.js', sameFile: true, owner: '@dshfiles/secret-catalog', credentialPortJavaScript: true },
    publicAdapter: { canonical: '/synthetic/adapter.js', sameFile: true, sameErrorClass: true, externalInBothHosts: true },
    sharedRuntime: { path: '/synthetic/client.js', sha256: hash, unchanged: true },
    stylesheet: {
      priorSelectors: 0,
      candidateSelectors: 0,
      missing: [],
      added: [],
      injectedSheets: 1,
      priorCssSha256: hash,
      candidateCssSha256: hash,
      scope: 'Synthetic preflight metadata, not runtime proof',
    },
    notVerified: ['All runtime behavior'],
  })
  const manifestText = JSON.stringify({
    schemaVersion: 1,
    kind: 'bots-offline-local-links',
    roots,
    sourceRevision: 'synthetic',
    sourceState: { dirty: false, changedTracked: [], untracked: [] },
    residuals: [],
    node: process.version,
    generatedAt: 'synthetic',
    inputs: [],
    artifacts: [{ path: markerPath, sha256: digest(markerText), bytes: Buffer.byteLength(markerText) }],
    links: [],
    retainedTrees: [],
    verification,
    retention: [],
  })
  await writeFile(join(roots.output, 'manifest.json'), manifestText)
  await writeFile(join(roots.output, 'SHA256SUMS'), `${digest(markerText)}  .bots-release-prepare.json\n${digest(manifestText)}  manifest.json\n`)
  await symlink(join(root, 'private-not-present'), join(roots.output, 'accounts.json'))
  await assert.rejects(check(roots), /Unexpected candidate path \(not opened\)/)
  assert.equal(await readFile(markerPath, 'utf8'), markerText)
})
test('accepts absent or empty output but rejects regular file output', async t => {
  const { roots } = await fixture(t)
  await assertEmptyOutput(roots.output)
  await mkdir(roots.output)
  await assertEmptyOutput(roots.output)
  const file = `${roots.output}.txt`
  await writeFile(file, '')
  await assert.rejects(assertEmptyOutput(file), /must be a directory/)
})

async function sourceFixture(t) {
  const result = await fixture(t)
  const root = result.roots.sourceRoot
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  for (const name of ['bots', 'secret-catalog', 'bot-openai-dot', 'ui-styles']) {
    const base = join(root, 'plugins/@dshfiles', name)
    for (const [path, code] of Object.entries({
      'package.json': JSON.stringify({ name: `@dshfiles/${name}` }),
      'dshx.config.ts': 'export default {}',
      'tsconfig.json': '{}',
      'cordis.patch.yml': '- id: safe-plugin\n',
      LICENSE: 'AGPL fixture license\nFull attribution and redistribution terms retained verbatim.\n',
      'PROVENANCE.md': '# Pinned upstream\nOriginal authors and source reference.\n',
      'NOTICE.md': 'MIT fixture viewer notice\nCopyright and complete permission notice are retained.\n',
      'README.md': '# Adapter\nSee [LICENSE](LICENSE), [provenance](PROVENANCE.md) and ![synthetic](docs/screenshots/evidence.png).\n',
      'tests/port.test.ts': 'export const fixtureUsesSyntheticCredentialsOnly = true',
      'src/host.ts': 'export const fixture = 1',
      'src/view.tsx': 'export const View = () => <div className="dshx:flex" />',
      'src/accounts/index.ts': 'export const accountSchemaIsCode = true',
      'src/browser/view.ts': 'export const browserUiIsCode = true',
      'src/profiles/schema.ts': 'export const profileSchemaIsCode = true',
      'dist/client.js': 'stale build must not copy',
      'docs/screenshots/evidence.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl4sAAAAASUVORK5CYII=', 'base64'),
      'local-state/accounts.json': 'private data',
      'src/.env': 'SECRET=no',
      'src/accounts.json': 'private fixture must not copy',
      'src/credentials.json': 'private fixture must not copy',
      'src/node_modules/library/index.js': 'do not copy',
    }))
      await save(join(base, path), code)
  }
  await save(join(root, 'tsconfig.base.client.json'), '{}')
  execFileSync('git', ['add', '--all'], { cwd: root })
  await save(join(root, 'plugins/@dshfiles/bots/src/untracked.ts'), 'not committed input')
  return result
}
test('source plan copies current tracked code and safe bundle metadata, not stale dist/private/untracked files', async t => {
  const { roots } = await sourceFixture(t)
  const plan = await sourcePlan(roots.sourceRoot)
  assert.equal(plan.length, 61)
  assert.ok(plan.some(entry => entry.destination === 'packages/@dshfiles/secret-catalog/src/host.ts'))
  assert.ok(plan.some(entry => entry.destination === 'packages/@dshfiles/secret-catalog/package.json'))
  for (const path of ['src/accounts/index.ts', 'src/browser/view.ts', 'src/profiles/schema.ts']) {
    assert.ok(
      plan.some(entry => entry.destination === `packages/@dshfiles/bots/${path}`),
      'Program source is not private state merely because of a directory basename',
    )
  }
  assert.ok(plan.some(entry => entry.destination.endsWith('bots/src/view.tsx')))
  assert.ok(plan.some(entry => entry.destination.endsWith('bots/cordis.patch.yml')))
  assert.ok(plan.every(entry => !/dist\/|local-state\/|node_modules\/|\.env|untracked|accounts\.json|credentials\.json/.test(entry.destination)))
  const path = join(roots.sourceRoot, 'plugins/@dshfiles/bots/src/host.ts')
  const before = plan.find(entry => entry.path === path)
  await writeFile(path, 'export const fixture = 2')
  const after = (await sourcePlan(roots.sourceRoot)).find(entry => entry.path === path)
  assert.notEqual(before.sha256, after.sha256, 'Dirty source bytes, not HEAD artifacts, must determine the candidate')
})
test('retains full Dot license, provenance, README, fixtures and committed synthetic README image bytes', async t => {
  const { roots } = await sourceFixture(t)
  const plan = await sourcePlan(roots.sourceRoot)
  for (const suffix of ['LICENSE', 'NOTICE.md', 'PROVENANCE.md', 'README.md', 'tests/port.test.ts', 'docs/screenshots/evidence.png']) {
    const entry = plan.find(entry => entry.destination === `packages/@dshfiles/bot-openai-dot/${suffix}`)
    assert.ok(entry, `Missing corresponding-source/legal documentation: ${suffix}`)
    const bytes = await readFile(join(roots.sourceRoot, 'plugins/@dshfiles/bot-openai-dot', suffix))
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(entry.bytes, bytes.length)
  }
})
test('dependency inventory reads only tracked source or declared published code/metadata, never arbitrary state', async t => {
  const { roots, root } = await fixture(t)
  const pkg = join(roots.sourceRoot, 'owned')
  await save(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', files: ['dist'], exports: './dist/index.js' }))
  await save(join(pkg, 'src/source.ts'), 'export const tracked = 1')
  await save(join(pkg, 'dist/index.js'), 'export const built = 1')
  execFileSync('git', ['init', '--quiet'], { cwd: roots.sourceRoot })
  execFileSync('git', ['add', 'owned/package.json', 'owned/src/source.ts'], { cwd: roots.sourceRoot })
  // Dangling links prove these data-looking paths are not opened OR resolved.
  for (const path of ['session-debug.log', 'private.sqlite', 'unknownsession.json', 'src/unknownsession.json', 'dist/unknownsession.json']) {
    await symlink(join(root, 'not-readable-not-present'), join(pkg, path))
  }
  const inventory = await treeInventory(pkg, { sourceRoot: roots.sourceRoot })
  assert.deepEqual(
    inventory.entries.map(entry => entry.path).sort(),
    [join(pkg, 'dist/index.js'), join(pkg, 'package.json'), join(pkg, 'src/source.ts')].sort(),
  )
  assert.deepEqual(inventory.links, [])
})
test('source plan refuses missing tracked build metadata', async t => {
  const { roots } = await sourceFixture(t)
  execFileSync('git', ['rm', '--cached', 'plugins/@dshfiles/bots/dshx.config.ts'], { cwd: roots.sourceRoot })
  await assert.rejects(sourcePlan(roots.sourceRoot), /Missing tracked build input/)
})
test('refuses a Dot source checkout missing its tracked AGPL license rather than shipping an incomplete candidate', async t => {
  const { roots } = await sourceFixture(t)
  execFileSync('git', ['rm', '--cached', 'plugins/@dshfiles/bot-openai-dot/LICENSE'], { cwd: roots.sourceRoot })
  await assert.rejects(sourcePlan(roots.sourceRoot), /Missing tracked build input.*bot-openai-dot\/LICENSE/)
})
test('refuses a Dot checkout missing the tracked MIT viewer notice', async t => {
  const { roots } = await sourceFixture(t)
  execFileSync('git', ['rm', '--cached', 'plugins/@dshfiles/bot-openai-dot/NOTICE.md'], { cwd: roots.sourceRoot })
  await assert.rejects(sourcePlan(roots.sourceRoot), /Missing tracked build input.*bot-openai-dot\/NOTICE\.md/)
})
test('source plan refuses tracked symlinks to private/external source', async t => {
  const { roots, root } = await sourceFixture(t)
  const privatePath = join(root, 'private.ts')
  await writeFile(privatePath, 'private')
  const path = join(roots.sourceRoot, 'plugins/@dshfiles/bots/src/external.ts')
  await symlink(privatePath, path)
  execFileSync('git', ['add', 'plugins/@dshfiles/bots/src/external.ts'], { cwd: roots.sourceRoot })
  await assert.rejects(sourcePlan(roots.sourceRoot), /Source symlink escapes/)
})
test('serving-source inventory excludes private folders and refuses hidden external source links', async t => {
  const { roots, root } = await fixture(t)
  await save(join(roots.servingRoot, 'src/view.tsx'), '<div className="existing" />')
  await save(join(roots.servingRoot, 'local-state/accounts.json'), 'never read or copy')
  const before = await treeInventory(roots.servingRoot, { sourceOnly: true })
  assert.deepEqual(
    before.entries.map(entry => entry.path),
    [join(roots.servingRoot, 'src/view.tsx')],
  )
  await symlink(root, join(roots.servingRoot, 'escape'), 'dir')
  await assert.rejects(treeInventory(roots.servingRoot, { sourceOnly: true }), /requires explicit review/)
})

const inject = css => `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)};`
test('selector retention parses variants, nested rules, comments and commas inside functional selectors', () => {
  const css =
    '/* not a selector */ @layer utilities { .old:is(.a,.b), .old\\:hover:hover { color:red } @media (width > 30rem) { .responsive { display:flex } } }'
  const result = compareStylesheets(inject(css), inject(`${css}\n.new-bot { display:grid }`))
  assert.equal(result.priorSelectors, 3)
  assert.equal(result.candidateSelectors, 4)
  assert.deepEqual(result.added, ['.new-bot'])
  assert.deepEqual(result.missing, [])
  assert.equal(cssSelectors(css).has('.old:is(.a,.b)'), true)
})
test('selector retention fails on missing previous selectors despite additions', () => {
  assert.throws(() => compareStylesheets(inject('.previous {color:red}'), inject('.new {color:blue}')), /Prior selectors missing/)
})
test('selector retention refuses changed whitespace inside quoted attribute values', () => {
  const before = '[data-label="two  spaces"] { color:red }'
  const after = '[data-label="two spaces"] { color:red }'
  assert.equal(cssSelectors(before).has('[data-label="two  spaces"]'), true)
  assert.throws(() => compareStylesheets(inject(before), inject(after)), /Prior selectors missing/)
})
test('stylesheet extraction requires valid JS and exactly one static sheet', () => {
  assert.equal(extractCss('sheet.textContent = `.one { color:red }`', 'sheet.js'), '.one { color:red }')
  assert.throws(() => extractCss('sheet.textContent = getCss()', 'sheet.js'), /exactly one/)
  assert.throws(() => extractCss(`${inject('.one{}')} ${inject('.two{}')}`, 'sheet.js'), /exactly one/)
  assert.throws(() => extractCss('broken )', 'sheet.js'), /Invalid JavaScript/)
})
test('CLI exposes only preparation/check and refuses ambiguous or operational flags', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.deepEqual(parseArgs(['check', '--output', '/tmp/candidate']), { command: 'check', options: { output: '/tmp/candidate' } })
  for (const args of [['deploy'], ['install'], ['prepare', '--apply'], ['prepare', '--output'], ['prepare', '--output', '/a', '--output', '/b']])
    assert.throws(() => parseArgs(args))
})
