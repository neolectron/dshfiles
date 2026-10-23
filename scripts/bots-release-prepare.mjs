#!/usr/bin/env node
// Offline preparation only. No profile reconciler, installer, launcher, or deployment API.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotsReleaseVerification } from './bots-release-verify.mjs'
const { verifyArtifacts } = BotsReleaseVerification

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = ['bots', 'secret-catalog', 'bot-openai-dot', 'ui-styles']
const markerName = '.bots-release-prepare.json'
const forbidden = new Set(['local-state', 'browser', 'accounts', 'node_modules', 'profiles', '.git', '.ssh', '.dsh'])
const privateFiles = new Set(['accounts.json', 'ai-accounts.json', 'credentials.json', 'secrets.json', 'cookies.json', 'storage-state.json', 'auth.json'])
// Output state names and source-code names are different policies: tracked
// src/accounts, src/browser and src/profiles are ordinary program code.
const stateDirectories = new Set(['local-state', 'node_modules', '.git', '.ssh', '.dsh'])
const privateComponent = name => stateDirectories.has(name) || privateFiles.has(name) || name.startsWith('.')
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md', '.html', '.yaml', '.yml'])
const sha = data => createHash('sha256').update(data).digest('hex')
const json = data => `${JSON.stringify(data, null, 2)}\n`
const entrySchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()
const linkSchema = z.object({ path: z.string(), target: z.string(), realTarget: z.string() }).strict()
const rootsSchema = z
  .object({ sourceRoot: z.string(), servingRoot: z.string(), runtimeRoot: z.string(), output: z.string(), profileRoot: z.string().optional() })
  .strict()
const exportTargetSchema = z.lazy(() => z.union([z.string(), z.null(), z.array(exportTargetSchema), z.record(z.string(), exportTargetSchema)]))
const PackageMetadataSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  types: z.string().optional(),
  exports: exportTargetSchema.optional(),
  files: z.array(z.string()).optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
})
const RuntimeMetadataSchema = z.object({ version: z.string().min(1) })
const sourceStateSchema = z.object({ dirty: z.boolean(), changedTracked: z.array(z.string()), untracked: z.array(z.string()) }).strict()
const markerSchema = z.object({ schemaVersion: z.literal(1), owner: z.literal('bots-release-prepare'), roots: rootsSchema }).strict()
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('bots-offline-local-links'),
    roots: rootsSchema,
    sourceRevision: z.string(),
    sourceState: sourceStateSchema,
    residuals: z.array(z.string()),
    node: z.string(),
    generatedAt: z.string(),
    inputs: z.array(entrySchema),
    artifacts: z.array(entrySchema),
    links: z.array(linkSchema),
    retainedTrees: z.array(z.object({ root: z.string(), entries: z.array(entrySchema), links: z.array(linkSchema) }).strict()),
    verification: BotsReleaseVerification.evidenceSchema,
    retention: z.array(z.string()),
  })
  .strict()

const contains = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
const overlaps = (a, b) => contains(a, b) || contains(b, a)
const missing = error => error?.code === 'ENOENT'

// Resolve existing ancestors too: a symlink in an otherwise nonexistent output path
// must not bypass overlap checks. Never normalize first and then trust that string.
async function prospectiveRealpath(path) {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (!missing(error)) throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await prospectiveRealpath(parent), relative(parent, absolute))
  }
}

async function validateRoots(options) {
  const roots = { sourceRoot: options.sourceRoot ?? repositoryRoot }
  for (const name of ['servingRoot', 'runtimeRoot', 'output']) {
    if (!options[name]) throw new Error(`Explicit --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`)
    roots[name] = options[name]
  }
  if (options.profileRoot) roots.profileRoot = options.profileRoot
  for (const name of ['sourceRoot', 'servingRoot', 'runtimeRoot', ...(roots.profileRoot ? ['profileRoot'] : [])]) {
    roots[name] = await realpath(resolve(roots[name]))
    assert.ok((await lstat(roots[name])).isDirectory(), `${name} must be a directory`)
  }
  roots.output = await prospectiveRealpath(roots.output)
  assert.ok(
    Object.values(roots).every(path => !/[\n\r'"\\]/.test(path)),
    'Paths cannot contain CSS quoting characters',
  )
  for (const protectedRoot of [roots.sourceRoot, roots.servingRoot, roots.runtimeRoot, roots.profileRoot, process.env.DSH_HOME, join(homedir(), '.dsh')].filter(
    Boolean,
  )) {
    if (overlaps(await prospectiveRealpath(protectedRoot), roots.output)) throw new Error(`Unsafe output overlaps protected tree: ${protectedRoot}`)
  }
  if (roots.output.split(sep).some(part => forbidden.has(part))) throw new Error('Unsafe output contains a private, dependency, or profile directory')
  // Existing symlinks, even aliases to a safe directory, are not output ownership.
  try {
    assert.ok(!(await lstat(resolve(options.output))).isSymbolicLink(), 'Output must not be a symlink')
  } catch (error) {
    if (!missing(error)) throw error
  }
  return rootsSchema.parse(roots)
}

async function assertEmptyOutput(output) {
  try {
    assert.ok((await lstat(output)).isDirectory(), 'Output must be a directory')
    assert.equal((await readdir(output)).length, 0, 'Refusing nonempty output; use check or choose a new empty directory')
  } catch (error) {
    if (!missing(error)) throw error
  }
}

async function fileEntry(path) {
  const data = await readFile(path)
  return { path, sha256: sha(data), bytes: data.length }
}
async function checkedFile(root, path) {
  assert.ok(contains(root, await realpath(path)), `Source symlink escapes its root: ${path}`)
  assert.ok((await lstat(path)).isFile(), `Only regular source files are accepted: ${path}`)
  return fileEntry(path)
}

// Whitelist tracked build inputs, not a checkout copy. Private state, dist,
// node_modules, live browser data, arbitrary patches and untracked files never enter.
// Committed synthetic PNG documentation assets and legal notices are source inputs.
async function sourcePlan(sourceRoot) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: sourceRoot, encoding: 'utf8' }).split('\0').filter(Boolean)
  const copies = []
  for (const name of packages) {
    const prefix = `plugins/@dshfiles/${name}/`
    const required = ['package.json', 'dshx.config.ts', 'tsconfig.json', 'cordis.patch.yml']
    if (name === 'bot-openai-dot') required.push('LICENSE', 'PROVENANCE.md', 'README.md')
    if (name === 'bots') required.push('README.md')
    for (const file of required) assert.ok(tracked.includes(prefix + file), `Missing tracked build input: ${prefix + file}`)
    for (const path of tracked.filter(path => path.startsWith(prefix))) {
      const suffix = path.slice(prefix.length)
      const legalOrReadme = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md', 'PROVENANCE.md', 'README.md'].includes(suffix)
      const sourceOrFixture = ['src/', 'tests/', 'fixtures/'].some(prefix => suffix.startsWith(prefix)) && codeExtensions.has(extname(suffix))
      const sourceDocumentation =
        suffix.startsWith('docs/') && (extname(suffix) === '.md' || (suffix.startsWith('docs/screenshots/') && extname(suffix) === '.png'))
      if (!required.includes(suffix) && suffix !== 'dshx.features.json' && !legalOrReadme && !sourceOrFixture && !sourceDocumentation) continue
      if (suffix.split('/').some(privateComponent)) continue
      const input = await checkedFile(sourceRoot, join(sourceRoot, path))
      copies.push({ ...input, destination: `packages/@dshfiles/${name}/${suffix}` })
    }
  }
  copies.push({ ...(await checkedFile(sourceRoot, join(sourceRoot, 'tsconfig.base.client.json'))), destination: 'tsconfig.base.client.json' })
  return copies.sort((a, b) => a.path.localeCompare(b.path))
}

function readSourceState(sourceRoot) {
  const names = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const changedTracked = names(['diff', '--name-only', '-z', 'HEAD', '--'])
  const untracked = names(['ls-files', '--others', '--exclude-standard', '-z'])
  return sourceStateSchema.parse({ dirty: changedTracked.length > 0 || untracked.length > 0, changedTracked, untracked })
}

// A scoped inventory, NOT a generic recursive file collector. Owned source must
// be tracked; runtime files must live in declared published code locations.
// Unknown JSON, databases, logs and other non-code assets are never opened.
async function treeInventory(root, { sourceOnly = false, sourceRoot } = {}) {
  const runtimeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.node', '.wasm'])
  const tracked = new Set(
    sourceRoot && contains(sourceRoot, root)
      ? execFileSync('git', ['ls-files', '-z'], { cwd: sourceRoot, encoding: 'utf8' })
          .split('\0')
          .filter(Boolean)
          .map(path => join(sourceRoot, path))
      : [],
  )
  const declaredDirs = new Set()
  const declaredFiles = new Set()
  let metadata
  try {
    metadata = JsonText.parse(await readFile(join(root, 'package.json'), 'utf8'), PackageMetadataSchema)
  } catch (error) {
    if (!missing(error)) throw error
  }
  const targets = []
  function addTargets(value) {
    if (Array.isArray(value)) value.forEach(addTargets)
    else if (value && z.string().safeParse(value).success) targets.push(value)
    else if (value) Object.values(value).forEach(addTargets)
  }
  if (metadata) {
    for (const value of [metadata.exports, metadata.bin, metadata.main, metadata.module, metadata.types, metadata.files]) addTargets(value)
    declaredFiles.add(join(root, 'package.json'))
  }
  for (const target of targets) {
    const rel = target.replace(/^\.\//, '')
    if (isAbsolute(rel) || rel.split('/').some(part => part === '..' || privateComponent(part))) continue
    if (rel.includes('/')) declaredDirs.add(rel.split('/')[0])
    else if (!extname(rel) && !rel.includes('*')) declaredDirs.add(rel)
    else if (!rel.includes('*')) declaredFiles.add(join(root, rel))
  }
  const entries = []
  const links = []
  const sourceLocation = rel => {
    const parts = rel.split(sep)
    return ['src', 'dist', 'client'].includes(parts[0]) || (parts.length > 1 && ['src', 'dist', 'client'].includes(parts[1]))
  }
  const runtimeLocation = rel => declaredDirs.has(rel.split(sep)[0])
  const selectedFile = path => {
    const rel = relative(root, path)
    if (sourceOnly) return (sourceLocation(rel) && runtimeExtensions.has(extname(path))) || (rel.split(sep).length <= 2 && path.endsWith(`${sep}package.json`))
    if (tracked.has(path)) return codeExtensions.has(extname(path)) || ['LICENSE', 'NOTICE'].includes(rel)
    return (
      (runtimeLocation(rel) && runtimeExtensions.has(extname(path))) ||
      (declaredFiles.has(path) &&
        (runtimeExtensions.has(extname(path)) ||
          path.endsWith(`${sep}package.json`) ||
          targets.some(target => resolve(root, target) === path && !extname(path))))
    )
  }
  const selectedDirectory = path => {
    const rel = relative(root, path)
    return (sourceOnly && (rel.split(sep).length === 1 || sourceLocation(rel))) || runtimeLocation(rel) || [...tracked].some(file => contains(path, file))
  }
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (privateComponent(entry.name) || entry.name === 'screenshots') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (sourceOnly) throw new Error(`Serving scan source symlink requires explicit review: ${path}`)
        if (!selectedFile(path) && !(extname(path) === '' && selectedDirectory(path))) continue
        const realTarget = await realpath(path)
        assert.ok(contains(root, realTarget), `Dependency code symlink escapes the hashed package: ${path}`)
        links.push({ path, target: await readlink(path), realTarget })
      } else if (entry.isDirectory()) {
        if (selectedDirectory(path)) await visit(path)
      } else if (entry.isFile() && selectedFile(path)) entries.push(await fileEntry(path))
    }
  }
  await visit(root)
  return { root, entries, links }
}

// Inventory only explicit retained targets. Transitive stores/non-code assets
// remain retention requirements, not a falsely claimed content-verified closure.
async function dependencyTrees(roots, sourceRoot) {
  const targets = [...new Set(await Promise.all(roots.map(path => realpath(path))))].sort()
  return Promise.all(targets.map(root => treeInventory(root, { sourceRoot })))
}

async function dependencyLinks(roots) {
  const { sourceRoot: source, servingRoot: serving, runtimeRoot: runtime, output } = roots
  const targets = {
    '@deepseek-ai': join(runtime, 'node_modules/@deepseek-ai'),
    '@dshfiles/bots': join(output, 'packages/@dshfiles/bots'),
    '@dshfiles/secret-catalog': join(output, 'packages/@dshfiles/secret-catalog'),
    '@dshfiles/backlog': join(source, 'plugins/@dshfiles/backlog'),
    '@dshfiles/jj-integration': join(source, 'plugins/@dshfiles/jj-integration'),
    '@dshfiles/project-folder-picker': join(source, 'plugins/@dshfiles/project-folder-picker'),
    '@dshfiles/dshx': join(source, 'tooling/dshx/packages/dshx'),
    '@dshfiles/plugin-ui': join(source, 'plugins/@dshfiles/plugin-ui'),
    '@dshfiles/credential-port': join(source, 'plugins/@dshfiles/credential-port'),
    '@dshfiles/shared-runtime': join(serving, 'plugins/@dshfiles/shared-runtime'),
    zod: join(source, 'plugins/@dshfiles/bots/node_modules/zod'),
    react: join(source, 'plugins/@dshfiles/bots/node_modules/react'),
    'react-dom': join(source, 'plugins/@dshfiles/bots/node_modules/react-dom'),
  }
  const links = []
  for (const [name, target] of Object.entries(targets)) {
    links.push({ path: join(output, 'node_modules', name), target, realTarget: contains(output, target) ? target : await realpath(target) })
  }
  return links
}

// Candidate-owned packages are covered by the artifact inventory, never the external retention graph.
function retainedTargets(links, output) {
  return links.filter(link => link.path !== join(output, 'node_modules/@deepseek-ai') && !contains(output, link.realTarget)).map(link => link.realTarget)
}

async function save(output, path, data) {
  assert.ok(contains(output, path) && path !== output, `Write escaped output: ${path}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { flag: 'wx' })
}

async function compile(output, runtimeVersion) {
  // Supported public API, not dshx source or an internal compiler entry point.
  const stageRequire = createRequire(join(output, 'package.json'))
  const tooling = await import(pathToFileURL(stageRequire.resolve('@dshfiles/dshx/tooling')))
  const results = []
  for (const name of packages) {
    const root = join(output, 'packages/@dshfiles', name)
    const project = await tooling.resolveDshxConfig({ cwd: root })
    assert.ok(contains(root, project.outDir), `Compiler output escapes package: ${project.outDir}`)
    const { compatibility } = tooling.assessProjectCompatibility(project.manifest, runtimeVersion)
    const common = { packageId: project.packageId, logicalName: project.name, root, outDir: project.outDir, sourcemap: true, declarations: true, compatibility }
    const hostOptions = { ...common, entry: project.hostEntry, bundleDependencies: project.hostBundleDependencies ?? [] }
    if (project.hostVitePlugins) hostOptions.vite = { plugins: project.hostVitePlugins }
    const reports = [await tooling.buildHost(hostOptions)]
    for (const shared of project.modules ?? [])
      reports.push(
        await tooling.buildModule({ packageId: project.packageId, root, name: shared.name, entry: shared.entry, outDir: project.outDir, sourcemap: true }),
      )
    if (project.clientEntry) {
      const client = project.manifest.dsh?.client ?? {}
      const clientOptions = {
        ...common,
        entry: project.clientEntry,
        minify: project.build.minify ?? false,
        bundleDependencies: project.clientBundleDependencies ?? [],
        external: client.external ?? [],
        inject: client.inject ?? [],
      }
      if (project.clientShared) clientOptions.shared = project.clientShared
      if (project.clientVitePlugins) clientOptions.vite = { plugins: project.clientVitePlugins }
      reports.push(await tooling.buildClient(clientOptions))
    }
    assert.deepEqual(await tooling.checkPackageTargets(project), [], `Invalid public package targets: ${name}`)
    results.push({ package: project.packageId, reports })
  }
  return results
}

async function collectInputs(roots, plan = undefined) {
  plan ??= await sourcePlan(roots.sourceRoot)
  const servingScan = await treeInventory(join(roots.servingRoot, 'plugins/@dshfiles'), { sourceOnly: true })
  const extraPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(path => join(roots.sourceRoot, path))
  for (const name of ['bots-release-prepare.mjs', 'bots-release-verify.mjs']) {
    const expected = join(roots.sourceRoot, 'scripts', name)
    assert.equal(
      sha(await readFile(expected)),
      sha(await readFile(join(repositoryRoot, 'scripts', name))),
      'Run the matching versioned CLI from the selected source checkout',
    )
    extraPaths.push(expected)
  }
  extraPaths.push(join(roots.servingRoot, 'plugins/@dshfiles/ui-styles/dist/client.js'))
  if (roots.profileRoot) extraPaths.push(join(roots.profileRoot, 'package.json'))
  return [
    ...new Map(
      [...plan.map(({ destination: _, ...entry }) => entry), ...servingScan.entries, ...(await Promise.all(extraPaths.map(fileEntry)))].map(entry => [
        entry.path,
        entry,
      ]),
    ).values(),
  ].sort((a, b) => a.path.localeCompare(b.path))
}

async function verifyEntries(entries) {
  for (const entry of entries) assert.deepEqual(await fileEntry(entry.path), entry, `Hash/size drift: ${entry.path}`)
}
async function verifyTrees(trees, sourceRoot) {
  for (const tree of trees) assert.deepEqual(await treeInventory(tree.root, { sourceRoot }), tree, `Retained dependency code/metadata changed: ${tree.root}`)
}

async function check(roots) {
  const output = roots.output
  const manifestPath = join(output, 'manifest.json')
  for (const name of [markerName, 'manifest.json', 'SHA256SUMS'])
    assert.ok((await lstat(join(output, name))).isFile(), `Candidate metadata must be a regular file: ${name}`)
  const text = await readFile(manifestPath, 'utf8')
  const manifest = JsonText.parse(text, manifestSchema)
  assert.deepEqual(manifest.roots, roots, 'Roots differ from the immutable candidate manifest')
  const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8')
  const expectedSums =
    [...manifest.artifacts, { path: manifestPath, sha256: sha(text) }].map(entry => `${entry.sha256}  ${relative(output, entry.path)}`).join('\n') + '\n'
  assert.equal(sums, expectedSums, 'Immutable manifest/checksum inventory changed')
  const marker = JsonText.parse(await readFile(join(output, markerName), 'utf8'), markerSchema)
  assert.deepEqual(marker, { schemaVersion: 1, owner: 'bots-release-prepare', roots }, 'Output is not owned by this candidate')
  const expectedPaths = new Set([
    ...manifest.artifacts.map(entry => entry.path),
    ...manifest.links.map(entry => entry.path),
    manifestPath,
    join(output, 'SHA256SUMS'),
  ])
  const current = await outputInventory(output, expectedPaths)
  assert.deepEqual(
    current.files.map(file => file.path),
    [...manifest.artifacts.map(file => file.path), manifestPath, join(output, 'SHA256SUMS')].sort((a, b) => a.localeCompare(b)),
    'Unexpected/missing candidate files',
  )
  const expectedLinks = await dependencyLinks(roots)
  assert.deepEqual(manifest.links, expectedLinks, 'Unexpected dependency link declarations')
  assert.deepEqual(
    current.links,
    expectedLinks.slice().sort((a, b) => a.path.localeCompare(b.path)),
    'Unexpected/missing candidate links',
  )
  for (const entry of manifest.inputs) {
    const inCode = [roots.sourceRoot, roots.servingRoot].some(
      root => contains(root, entry.path) && !relative(root, entry.path).split(sep).some(privateComponent),
    )
    const inProfile = roots.profileRoot && entry.path === join(roots.profileRoot, 'package.json')
    assert.ok(inCode || inProfile, `Input path outside approved code/metadata: ${entry.path}`)
  }
  assert.equal(process.version, manifest.node, 'Node version changed; prepare a new candidate')
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: roots.sourceRoot, encoding: 'utf8' }).trim(),
    manifest.sourceRevision,
    'Source revision changed',
  )
  assert.deepEqual(readSourceState(roots.sourceRoot), manifest.sourceState, 'Dirty/untracked source state changed')
  assert.deepEqual(await collectInputs(roots), manifest.inputs, 'Source input inventory changed (including additions/removals)')
  await verifyEntries([...manifest.inputs, ...manifest.artifacts])
  const nativeRoots = await Promise.all(
    (await readdir(join(roots.runtimeRoot, 'node_modules/@deepseek-ai')))
      .filter(name => !name.startsWith('.'))
      .map(name => realpath(join(roots.runtimeRoot, 'node_modules/@deepseek-ai', name))),
  )
  const retained = await dependencyTrees([...retainedTargets(expectedLinks, output), ...nativeRoots], roots.sourceRoot)
  assert.deepEqual(retained, manifest.retainedTrees, 'Retained dependency graph or content changed')
  for (const link of manifest.links) {
    assert.equal(await readlink(link.path), link.target, `Link retargeted: ${link.path}`)
    assert.equal(await realpath(link.path), link.realTarget, `Dependency target moved: ${link.path}`)
  }
  const verification = await verifyArtifacts(roots)
  assert.deepEqual(verification, manifest.verification, 'Offline verification drift')
  assert.deepEqual(await outputInventory(output, expectedPaths), current, 'Check must not mutate candidate files')
  return { status: 'CHECKED_OFFLINE_NOT_DEPLOYED', output, verification }
}

async function outputInventory(output, expectedPaths) {
  const files = []
  const links = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // Reject unexpected names before opening bytes or resolving symlink targets.
      if (expectedPaths && !entry.isDirectory()) assert.ok(expectedPaths.has(path), `Unexpected candidate path (not opened): ${path}`)
      if (entry.isSymbolicLink()) links.push({ path, target: await readlink(path), realTarget: await realpath(path) })
      else if (entry.isDirectory()) await visit(path)
      else {
        assert.ok(entry.isFile(), `Unexpected special output file: ${path}`)
        files.push(await fileEntry(path))
      }
    }
  }
  await visit(output)
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)) }
}

async function prepare(options) {
  const roots = await validateRoots(options)
  try {
    if ((await readdir(roots.output)).length) {
      // Even owned candidates are never rebuilt or repaired in place.
      await lstat(join(roots.output, markerName)).catch(() => {
        throw new Error('Refusing nonempty unowned output')
      })
      return await check(roots)
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  await assertEmptyOutput(roots.output)
  const plan = await sourcePlan(roots.sourceRoot)
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: roots.sourceRoot, encoding: 'utf8' }).trim()
  const sourceState = readSourceState(roots.sourceRoot)
  const links = await dependencyLinks(roots)
  const nativeRoots = await Promise.all(
    (await readdir(join(roots.runtimeRoot, 'node_modules/@deepseek-ai')))
      .filter(name => !name.startsWith('.'))
      .map(name => realpath(join(roots.runtimeRoot, 'node_modules/@deepseek-ai', name))),
  )
  const retainedTrees = await dependencyTrees([...retainedTargets(links, roots.output), ...nativeRoots], roots.sourceRoot)
  const inputs = await collectInputs(roots, plan)
  const runtimeVersion = JsonText.parse(
    await readFile(join(roots.runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'),
    RuntimeMetadataSchema,
  ).version
  // All roots, inputs and dependency targets have been verified before the first write.
  await mkdir(roots.output, { recursive: true })
  await save(roots.output, join(roots.output, markerName), json({ schemaVersion: 1, owner: 'bots-release-prepare', roots }))
  for (const entry of plan) {
    const data = await readFile(entry.path)
    assert.equal(sha(data), entry.sha256, `Source changed before copy: ${entry.path}`)
    await save(roots.output, join(roots.output, entry.destination), data)
  }
  for (const link of links) {
    await mkdir(dirname(link.path), { recursive: true })
    await symlink(link.target, link.path, 'dir')
  }
  await save(roots.output, join(roots.output, 'package.json'), json({ name: 'bots-offline-local-links', private: true, type: 'module' }))
  await save(
    roots.output,
    join(roots.output, 'SOURCE-RETENTION.md'),
    `# Retained source documentation\n\nPackage READMEs, licenses, provenance, source fixtures and committed synthetic PNG documentation assets are preserved verbatim. Repository-wide relative links remain authoritative in the retained source checkout, not a portable snapshot.\n\n- [Bots original README](<${join(roots.sourceRoot, 'plugins/@dshfiles/bots/README.md')}>)\n- [Dot original README and AGPL source](<${join(roots.sourceRoot, 'plugins/@dshfiles/bot-openai-dot/README.md')}>)\n- [Architecture and use](<${join(roots.sourceRoot, 'docs/bots.md')}>)\n\nRetain that source checkout and all dependency targets unchanged.\n`,
  )
  const cssPath = join(roots.output, 'packages/@dshfiles/ui-styles/src/client.css')
  // This one generated source replaces only our just-created candidate copy.
  const stylePath = join(roots.servingRoot, 'plugins/@dshfiles/plugin-ui/src/styles.css')
  assert.ok(!/[\n\r'"\\]/.test(stylePath + roots.output), 'Paths cannot contain CSS quoting characters')
  await writeFile(
    cssPath,
    `/* Serving source union; preserve its imports, sources, theme and variants. */\n@import '${stylePath}';\n@source '${join(roots.output, 'packages/@dshfiles/bots/src')}';\n`,
  )
  const results = await compile(roots.output, runtimeVersion)
  const verification = await verifyArtifacts(roots)
  await verifyEntries(inputs)
  await verifyTrees(retainedTrees, roots.sourceRoot)
  await save(
    roots.output,
    join(roots.output, 'build-evidence.json'),
    json({ compiler: '@dshfiles/dshx/tooling', results, scope: 'Offline compilation/import checks; no Host activation or live protocol proof' }),
  )
  await save(roots.output, join(roots.output, 'verification-evidence.json'), json(verification))
  const artifacts = (await outputInventory(roots.output)).files
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    kind: 'bots-offline-local-links',
    roots,
    sourceRevision,
    sourceState,
    residuals: [
      'HEAD is identity metadata, not a clean-source claim: sourceState records dirty paths and untracked names; copied bytes have independent hashes.',
      'Untracked package source is omitted; the executing versioned recipe is an explicit hashed tool input even during uncommitted development.',
      'Only direct retained target tracked source and declared published code/metadata are inventoried. Transitive package stores and non-code runtime assets are required unchanged but NOT fully content-verified.',
      'Unknown JSON, logs, databases, accounts, browser data and private state are never inventoried. Preserve external targets; this is not a portable archive.',
      'Preserved source README links may require the retained feature root; see SOURCE-RETENTION.md.',
    ],
    node: process.version,
    generatedAt: new Date().toISOString(),
    inputs,
    artifacts,
    links,
    retainedTrees,
    verification,
    retention: [
      'Local links, NOT a portable archive.',
      'Retain candidate, source/serving/runtime roots and all real dependency targets with these exact hashes.',
      'Direct dependency code/metadata scope is hashed without copying node_modules or reading private state; transitive/non-code retention is an explicit unverified requirement.',
      'Manifest and checksum snapshots are never regenerated by check. Choose a NEW output for changed inputs.',
      'No credentials, patch secrets, accounts, browser data or live-state copies. No deployment or automatic apply.',
    ],
  })
  await save(roots.output, join(roots.output, 'manifest.json'), json(manifest))
  const manifestEntry = await fileEntry(join(roots.output, 'manifest.json'))
  await save(
    roots.output,
    join(roots.output, 'SHA256SUMS'),
    [...artifacts, manifestEntry].map(entry => `${entry.sha256}  ${relative(roots.output, entry.path)}`).join('\n') + '\n',
  )
  return check(roots)
}

const help = `Usage: node scripts/bots-release-prepare.mjs <prepare|check>\n  [--source-root PATH] --serving-root PATH --runtime-root PATH --output PATH\n  [--profile-root PATH]\n\nSOURCE-only offline candidate. Only source-root defaults (to this feature checkout).\nOutput must be disjoint from all roots and live homes. Nonempty outputs are never\nrebuilt: a valid owned candidate is checked read-only, anything else is refused.\nOptional profile-root reads ONLY package.json\nfor baseline hashes; it does not read patches, credentials, accounts or auth state.\nNo apply/deploy/sync/install/start/stop commands exist.\n`
function parseArgs(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { help: true }
  const [command, ...rest] = args
  assert.ok(['prepare', 'check'].includes(command), 'Expected prepare or check (no deployment verbs)')
  const options = {}
  const names = {
    '--source-root': 'sourceRoot',
    '--serving-root': 'servingRoot',
    '--runtime-root': 'runtimeRoot',
    '--output': 'output',
    '--profile-root': 'profileRoot',
  }
  for (let i = 0; i < rest.length; i += 2) {
    const name = names[rest[i]]
    assert.ok(name && rest[i + 1] && !rest[i + 1].startsWith('--'), `Unknown or incomplete option: ${rest[i]}`)
    assert.ok(options[name] === undefined, `Duplicate option: ${rest[i]}`)
    options[name] = rest[i + 1]
  }
  return { command, options }
}
export class BotsReleasePreparation {
  static contains = contains
  static prospectiveRealpath = prospectiveRealpath
  static validateRoots = validateRoots
  static assertEmptyOutput = assertEmptyOutput
  static sourcePlan = sourcePlan
  static treeInventory = treeInventory
  static retainedTargets = retainedTargets
  static prepare = prepare
  static check = check
  static parseArgs = parseArgs
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) console.log(help)
    else console.log(JSON.stringify(args.command === 'prepare' ? await prepare(args.options) : await check(await validateRoots(args.options)), null, 2))
  } catch (error) {
    console.error(`Offline preparation refused: ${error.message}`)
    process.exitCode = 1
  }
}
