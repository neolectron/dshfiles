import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { defineClient } from '@dshfiles/dshx/client'
import { BotIcon } from '@dshfiles/plugin-ui/icons'
import { AuthViewer } from '../../../../plugins/@dshfiles/bot-openai-dot/src/auth-viewer.js'
import { createAuthFetchTransport } from '../../../../plugins/@dshfiles/bot-openai-dot/src/auth-viewer-transport.js'

// Trusted fixture deployment configuration, NOT URL/private Connection inference.
const BASE_PATH = '/'
const transport = createAuthFetchTransport({
  browserOrigin: window.location.origin,
  pageOrigin: window.location.origin,
  basePath: BASE_PATH,
  fetch: window.fetch.bind(window),
})
export default defineClient({
  name: '@dshfiles/dot-auth-synthetic-fixture',
  inject: ['slots'],
  setup(ctx, decorate) {
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: 'dot-auth-synthetic', order: 5, label: 'Synthetic Dot auth' }, BotIcon),
    )
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: 'dot-auth-synthetic' },
        decorate(() => (
          <main aria-label="Synthetic Dot auth verification">
            <p>SYNTHETIC PIXELS AND INPUT ONLY — no account or provider.</p>
            <AuthViewer transport={transport} />
          </main>
        )),
      ),
    )
  },
})
