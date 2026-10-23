import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { defineClient } from '@dshfiles/dshx/client'
import { BotIcon } from '@dshfiles/plugin-ui/icons'
import { PluginQueryProvider } from '@dshfiles/plugin-ui/query'
import { BotsPanel } from './bots-panel.js'

const PANEL_ID = 'dshfiles-bots'

/** Global workspace: deliberately no Session, model, thread or composer service. */
export default defineClient({
  name: '@dshfiles/bots',
  inject: ['slots'],
  setup(ctx, decorate) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 7, label: 'Bots' }, BotIcon))
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        decorate(() => (
          <PluginQueryProvider>
            <BotsPanel />
          </PluginQueryProvider>
        )),
      ),
    )
  },
})
