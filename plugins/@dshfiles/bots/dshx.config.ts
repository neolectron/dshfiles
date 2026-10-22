import { defineConfig } from '@dshfiles/dshx'
import { pluginUiVite } from '@dshfiles/plugin-ui/vite'
export default defineConfig({
  name: '@dshfiles/bots',
  host: { entry: 'src/host.ts', bundleDependencies: ['@dshfiles/credential-port'] },
  client: { entry: 'src/client-entry.tsx', shared: '@dshfiles/shared-runtime', vite: { plugins: [pluginUiVite()] } },
  modules: { adapter: 'src/adapter.ts', api: 'src/api.ts' },
  build: { sourcemap: true, declarations: true, minify: true },
})
