import { defineConfig } from '@dshfiles/dshx'

export default defineConfig({
  name: '@dshfiles/bot-openai-dot',
  host: { entry: 'src/host.ts', bundleDependencies: ['@dshfiles/credential-port'] },
  modules: { adapter: 'src/adapter.ts' },
  build: { sourcemap: true, declarations: true },
})
