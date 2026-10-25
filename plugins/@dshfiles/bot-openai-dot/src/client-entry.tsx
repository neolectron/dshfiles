// SPDX-License-Identifier: AGPL-3.0-only
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import { defineClient } from '@dshfiles/dshx/client'
import { MonitorIcon } from '@dshfiles/plugin-ui/icons'
import { PluginQueryProvider } from '@dshfiles/plugin-ui/query'
import { AuthViewer } from './auth-viewer.js'
import { NativeAuthTransport } from './auth-viewer-transport.js'

const PANEL_ID = 'dshfiles-dot-connection'

function DotConnectionPage() {
  const [transport] = React.useState(NativeAuthTransport)
  return <AuthViewer transport={transport} />
}

/** Human-only private authentication page. Never replaces chat or owns Bots state. */
export default defineClient({
  name: '@dshfiles/bot-openai-dot',
  inject: ['slots'],
  setup(ctx, decorate) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: 'Dot connection' }, MonitorIcon))
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        decorate(() => (
          <PluginQueryProvider>
            <DotConnectionPage />
          </PluginQueryProvider>
        )),
      ),
    )
  },
})
