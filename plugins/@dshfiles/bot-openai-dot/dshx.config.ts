import { defineConfig } from '@dshfiles/dshx'
import { pluginUiVite } from '@dshfiles/plugin-ui/vite'

export default defineConfig({
  name: '@dshfiles/bot-openai-dot',
  host: { entry: 'src/host.ts', bundleDependencies: ['@dshfiles/credential-port'] },
  client: { entry: 'src/client-entry.tsx', shared: '@dshfiles/shared-runtime', vite: { plugins: [pluginUiVite()] } },
  modules: { adapter: 'src/adapter.ts', 'account-authority': 'src/account-authority.ts', 'browser-session': 'src/browser-session.ts', auth: 'src/auth.ts' },
  build: { sourcemap: true, declarations: true },
})
