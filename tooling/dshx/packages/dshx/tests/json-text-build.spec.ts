import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClient, buildHost } from '../src/compiler/index.js'
import { writePluginFixture } from './plugin-fixture.js'

const temporaryDirectories: string[] = []
const entrySource = [
  "import { z } from 'zod'",
  "import { JsonText } from '@dshfiles/dshx/api'",
  "export const name = 'validated-json-fixture'",
  'const schema = z.object({ count: z.number() }).strict()',
  'export function apply(ctx) { ctx.decoded = JsonText.parse(\'{"count":3}\', schema) }',
  '',
].join('\n')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('JsonText compiler public facades', () => {
  it('bundles the validated parser through the Host public API facade', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'dshx-json-host-'))
    temporaryDirectories.push(root)
    await writePluginFixture(root)
    await writeFile(resolve(root, 'src/host.ts'), entrySource)
    await buildHost({ packageId: '@dshx/fixture-plugin', root, entry: 'src/host.ts', outDir: 'dist' })
    const code = await readFile(resolve(root, 'dist/index.js'), 'utf8')
    expect(code).toContain('JSON text did not match the required schema.')
    expect(code).not.toContain('from "@dshfiles/dshx/api"')
  })

  it('bundles the validated parser through the Client public API facade', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'dshx-json-client-'))
    temporaryDirectories.push(root)
    await writePluginFixture(root)
    await writeFile(resolve(root, 'src/client.tsx'), entrySource)
    await buildClient({ packageId: '@dshx/fixture-plugin', root, entry: 'src/client.tsx', outDir: 'dist' })
    const code = await readFile(resolve(root, 'dist/client.js'), 'utf8')
    expect(code).toContain('JSON text did not match the required schema.')
    expect(code).not.toContain('require("@dshfiles/dshx/api")')
  })
})
