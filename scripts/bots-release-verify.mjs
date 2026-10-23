// Pure offline artifact verification. Never activates a Cordis context or a Host.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'
import postcss from 'postcss'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
const CordisMetadataSchema = z.object({ name: z.literal('@deepseek-ai/cordis'), version: z.string() })

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const EvidenceSchema = z
  .object({
    stockCordisVersion: z.literal('4.0.5'),
    stockCordisIdentity: z.literal(true),
    imports: z.array(z.object({ name: z.string(), exports: z.array(z.string()) }).strict()),
    publicApiImported: z.literal(true),
    publicCatalogApi: z
      .object({ canonical: z.string(), sameFile: z.literal(true), owner: z.literal('@dshfiles/secret-catalog'), credentialPortJavaScript: z.literal(true) })
      .strict(),
    publicAdapter: z
      .object({ canonical: z.string(), sameFile: z.literal(true), sameErrorClass: z.literal(true), externalInBothHosts: z.literal(true) })
      .strict(),
    sharedRuntime: z.object({ path: z.string(), sha256: hashSchema, unchanged: z.literal(true) }).strict(),
    stylesheet: z
      .object({
        priorSelectors: z.number().int().nonnegative(),
        candidateSelectors: z.number().int().nonnegative(),
        missing: z.array(z.string()),
        added: z.array(z.string()),
        injectedSheets: z.literal(1),
        priorCssSha256: hashSchema,
        candidateCssSha256: hashSchema,
        scope: z.string(),
      })
      .strict(),
    notVerified: z.array(z.string()),
  })
  .strict()
const sha = data => createHash('sha256').update(data).digest('hex')
function walk(node, visitor) {
  if (!node?.type) return
  visitor(node)
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visitor))
    else walk(child, visitor)
  }
}
function parseJavaScript(code, name = 'candidate.js') {
  const parsed = parseSync(name, code)
  assert.equal(parsed.errors.length, 0, `Invalid JavaScript: ${name}`)
  return parsed.program
}
function extractCss(code, name) {
  const sheets = []
  walk(parseJavaScript(code, name), node => {
    if (node.type !== 'AssignmentExpression' || node.operator !== '=' || node.left?.type !== 'MemberExpression' || node.left.property?.name !== 'textContent')
      return
    const literal = z.string().safeParse(node.right?.value)
    if (literal.success) sheets.push(literal.data)
    else if (node.right?.type === 'TemplateLiteral' && node.right.expressions.length === 0)
      sheets.push(node.right.quasis.map(item => item.value.cooked).join(''))
  })
  assert.equal(sheets.length, 1, `${name} must inject exactly one static shared stylesheet`)
  return sheets[0]
}
function cssSelectors(css) {
  const result = new Set()
  postcss.parse(css).walkRules(rule => {
    for (const selector of postcss.list.comma(rule.selector)) result.add(selector.trim())
  })
  return result
}
function compareStylesheets(beforeCode, afterCode) {
  const beforeCss = extractCss(beforeCode, 'serving.js')
  const afterCss = extractCss(afterCode, 'candidate.js')
  const before = cssSelectors(beforeCss)
  const after = cssSelectors(afterCss)
  const missing = [...before].filter(selector => !after.has(selector)).sort()
  const added = [...after].filter(selector => !before.has(selector)).sort()
  assert.equal(missing.length, 0, `Prior selectors missing: ${JSON.stringify(missing)}`)
  return {
    priorSelectors: before.size,
    candidateSelectors: after.size,
    missing,
    added,
    injectedSheets: 1,
    priorCssSha256: sha(beforeCss),
    candidateCssSha256: sha(afterCss),
    scope: 'Exact individual-selector retention with outer trim only, not computed-style or browser-appearance proof',
  }
}
async function verifyArtifacts({ sourceRoot, servingRoot, runtimeRoot, output }) {
  const packageRoot = name => join(output, 'packages/@dshfiles', name)
  const botsRoot = packageRoot('bots')
  const dotRoot = packageRoot('bot-openai-dot')
  const catalogRoot = packageRoot('secret-catalog')
  const catalogRequire = createRequire(join(catalogRoot, 'package.json'))
  const botsRequire = createRequire(join(botsRoot, 'package.json'))
  const dotRequire = createRequire(join(dotRoot, 'package.json'))
  const stageRequire = createRequire(join(output, 'package.json'))
  const nativeRequire = createRequire(join(runtimeRoot, 'package.json'))
  const nativeCordisPath = nativeRequire.resolve('@deepseek-ai/cordis')
  const stagedCordisPath = stageRequire.resolve('@deepseek-ai/cordis')
  assert.equal(await realpath(stagedCordisPath), await realpath(nativeCordisPath), 'Cordis must resolve to the native runtime')
  const nativeCordis = await import(pathToFileURL(nativeCordisPath))
  const stagedCordis = await import(pathToFileURL(stagedCordisPath))
  assert.equal(nativeCordis.Context, stagedCordis.Context, 'Stock Cordis Context identity differs')
  const cordisManifest = JsonText.parse(await readFile(join(runtimeRoot, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8'), CordisMetadataSchema)
  assert.equal(cordisManifest.version, '4.0.5', 'Only the verified native Cordis 4.0.5 recipe is supported')
  const fromBots = await realpath(botsRequire.resolve('@dshfiles/bots/adapter'))
  const fromDot = await realpath(dotRequire.resolve('@dshfiles/bots/adapter'))
  assert.equal(fromBots, fromDot, 'Two adapter files would split BotAdapterError identity')
  assert.equal(fromBots, await realpath(join(botsRoot, 'dist/adapter.js')), 'Adapter must be the ONE staged public module, never feature-tree dist')
  const adapterA = await import(pathToFileURL(fromBots))
  const adapterB = await import(pathToFileURL(fromDot))
  assert.ok(adapterA.BotAdapterError?.prototype instanceof Error, 'Public adapter must export its Error subclass')
  assert.equal(adapterA.BotAdapterError, adapterB.BotAdapterError)
  for (const root of [botsRoot, dotRoot]) {
    const program = parseJavaScript(await readFile(join(root, 'dist/index.js'), 'utf8'))
    let externalAdapter = false
    walk(program, node => {
      if (node.type === 'ImportDeclaration' && node.source?.value === '@dshfiles/bots/adapter') externalAdapter = true
      assert.ok(
        !(['ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id?.name === 'BotAdapterError'),
        'Host must not bundle a duplicate BotAdapterError',
      )
    })
    assert.ok(externalAdapter, 'Both Host bundles must keep the public adapter external')
  }
  const imports = []
  for (const name of ['bots', 'secret-catalog', 'bot-openai-dot', 'ui-styles']) {
    const path = join(packageRoot(name), 'dist/index.js')
    const mod = await import(pathToFileURL(path))
    imports.push({ name, exports: Object.keys(mod).sort() })
  }
  const catalogApiPath = await realpath(dotRequire.resolve('@dshfiles/secret-catalog/api'))
  assert.equal(catalogApiPath, await realpath(join(catalogRoot, 'dist/api.js')), 'Dot must consume the staged public Catalog contract')
  const catalogModule = await import(pathToFileURL(catalogApiPath))
  assert.equal(catalogModule.secretCatalogApi?.owner, '@dshfiles/secret-catalog', 'The Catalog contract must retain its explicit owner')
  const portPath = await realpath(catalogRequire.resolve('@dshfiles/credential-port'))
  assert.equal(
    portPath,
    await realpath(join(sourceRoot, 'plugins/@dshfiles/credential-port/dist/index.js')),
    'Catalog must use built credential-port JavaScript',
  )
  await import(pathToFileURL(portPath))
  const api = await import(pathToFileURL(join(botsRoot, 'dist/api.js')))
  assert.ok(api.botsApi, 'Public Bots API module must import')
  const botsClient = await readFile(join(botsRoot, 'dist/client.js'), 'utf8')
  parseJavaScript(botsClient)
  assert.doesNotMatch(botsClient, /data-dshx-shared-css/, 'Bots must not inject a second shared stylesheet')
  const sharedRuntimePath = join(servingRoot, 'plugins/@dshfiles/shared-runtime/dist/client.js')
  const sharedHash = sha(await readFile(sharedRuntimePath))
  assert.equal(
    sharedHash,
    sha(await readFile(join(sourceRoot, 'plugins/@dshfiles/shared-runtime/dist/client.js'))),
    'Shared-runtime mismatch: rebuild/replacement is deliberately unsupported',
  )
  const stylePath = join(packageRoot('ui-styles'), 'dist/client.js')
  const stylesheet = compareStylesheets(
    await readFile(join(servingRoot, 'plugins/@dshfiles/ui-styles/dist/client.js'), 'utf8'),
    await readFile(stylePath, 'utf8'),
  )
  return EvidenceSchema.parse({
    stockCordisVersion: cordisManifest.version,
    stockCordisIdentity: true,
    imports,
    publicApiImported: true,
    publicCatalogApi: { canonical: catalogApiPath, sameFile: true, owner: '@dshfiles/secret-catalog', credentialPortJavaScript: true },
    publicAdapter: { canonical: fromBots, sameFile: true, sameErrorClass: true, externalInBothHosts: true },
    sharedRuntime: { path: sharedRuntimePath, sha256: sharedHash, unchanged: true },
    stylesheet,
    notVerified: ['Host activation', 'GUI rendering', 'real account/protocol', 'private data or credential operations', 'actual Manuel deployment'],
  })
}

export class BotsReleaseVerification {
  static evidenceSchema = EvidenceSchema
  static extractCss = extractCss
  static cssSelectors = cssSelectors
  static compareStylesheets = compareStylesheets
  static verifyArtifacts = verifyArtifacts
}
