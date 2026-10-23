import { buildClient, buildHost, resolveDshxConfig } from '@dshfiles/dshx/tooling'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, '../../../..')
export async function buildDotAuthFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dshx-dot-auth-package-'))
  if (!root.startsWith(join(tmpdir(), 'dshx-dot-auth-package-'))) throw new Error('Unexpected fixture root.')
  const packageId = '@dshfiles/dot-auth-synthetic-fixture'
  const inject = ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-slots']
  const manifest = {
    name: packageId,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
    exports: { '.': './dist/index.js', './client': './dist/client.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    peerDependencies: {
      '@deepseek-ai/cordis': '~4.0.4',
      '@deepseek-ai/dsh': '0.2.1-rc.2',
      '@deepseek-ai/dsh-client-connection': '0.2.1-rc.2',
      '@deepseek-ai/dsh-host-webserver': '0.2.1-rc.2',
      '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject, external: ['@dshfiles/shared-runtime'], immediately: false } },
  }
  try {
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n    - id: dot-auth-synthetic-fixture\n      name: ${JSON.stringify(packageId)}\n`)
    await writeFile(
      join(root, 'dshx.config.ts'),
      `import { defineConfig } from '@dshfiles/dshx'; import { pluginUiVite } from '@dshfiles/plugin-ui/vite'; export default defineConfig({name:${JSON.stringify(packageId)},host:{entry:'host.ts'},client:{entry:'client.tsx',shared:'@dshfiles/shared-runtime',vite:{plugins:[pluginUiVite()]}},build:{declarations:false}})\n`,
    )
    for (const { source, target } of [
      { source: 'dot-auth-host.ts', target: 'host.ts' },
      { source: 'dot-auth-client.tsx', target: 'client.tsx' },
    ]) {
      const text = await readFile(join(directory, source), 'utf8')
      await writeFile(join(root, target), text.replaceAll('../../../../plugins/', `${repository}/plugins/`))
    }
    const configuration = await resolveDshxConfig({ cwd: root })
    if (!configuration.hostEntry || !configuration.clientEntry || !configuration.clientShared)
      throw new Error('Fixture needs supported Host/client/shared-runtime entries.')
    await buildHost({ packageId, root, entry: configuration.hostEntry, outDir: configuration.outDir, declarations: false })
    await buildClient({
      packageId,
      root,
      entry: configuration.clientEntry,
      outDir: configuration.outDir,
      declarations: false,
      shared: configuration.clientShared,
      inject,
      external: manifest.dsh.client.external,
      vite: { plugins: configuration.clientVitePlugins ?? [] },
    })
    await import(join(root, 'dist/index.js'))
    return {
      root,
      packageId,
      async close() {
        if (!root.startsWith(join(tmpdir(), 'dshx-dot-auth-package-'))) throw new Error('Unexpected fixture cleanup target.')
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
