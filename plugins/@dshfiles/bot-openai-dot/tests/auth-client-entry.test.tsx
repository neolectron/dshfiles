// SPDX-License-Identifier: AGPL-3.0-only
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { createTestClient } from '@dshfiles/dshx/testing'
import { expect, it } from 'vitest'
import entry from '../src/client-entry.js'

it('registers a dedicated Dot connection page through installed native slots and removes it on plugin disposal', async () => {
  const client = await createTestClient()
  try {
    client.slots.register(
      {
        name: 'root',
        children: {
          main: { kind: 'keyed', scope: 'root' },
          'sidebar.panellist': { kind: 'list', scope: 'root' },
        },
      },
      (props: PropsRenderSlots<'main' | 'sidebar.panellist'>) => {
        // The harness declares these public children; it does not mount a browser.
        void props.renderSlot
        return null
      },
    )
    const mounted = await client.mount(entry, { packageId: '@dshfiles/bot-openai-dot' })
    const panels = client.slots.entries('sidebar.panellist')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.options).toMatchObject({ id: 'dshfiles-dot-connection', label: 'Dot connection' })
    const pages = client.slots.entries('main')
    expect(pages).toHaveLength(1)
    expect(pages[0]?.options.key).toBe('dshfiles-dot-connection')
    expect(pages[0]?.component).toBeTypeOf('function')
    await mounted.dispose()
    expect(client.slots.entries('main')).toHaveLength(0)
    expect(client.slots.entries('sidebar.panellist')).toHaveLength(0)
  } finally {
    await client.dispose()
  }
})
