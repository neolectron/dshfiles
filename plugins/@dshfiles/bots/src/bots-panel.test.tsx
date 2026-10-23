// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createApiClient } from '@dshfiles/dshx/client'
import { PluginQueryProvider, QueryClient } from '@dshfiles/plugin-ui/query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botsApi } from './api.js'
import { BotsPanel } from './bots-panel.js'
import type { BotsSnapshot } from './contract.js'

vi.mock('@dshfiles/dshx/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@dshfiles/dshx/client')>()),
  useApi: () => api,
}))
const snapshot: BotsSnapshot = {
  revision: 1,
  adapters: [
    {
      id: 'synthetic',
      version: 1,
      name: 'Synthetic',
      description: '',
      risk: '',
      fields: [],
      credentialManagement: { label: 'Allow synthetic vault saves', description: 'Synthetic reference lifecycle.' },
    },
  ],
  connections: [
    {
      id: 'synthetic-connection',
      adapterId: 'synthetic',
      label: 'Synthetic',
      status: 'connected',
      error: null,
      lastSyncAt: null,
      enabled: true,
      accountId: 'synthetic-account',
      createdAt: 0,
      credentialManagement: false,
    },
  ],
  bots: [
    {
      id: 'synthetic-bot',
      connectionId: 'synthetic-connection',
      provider: 'synthetic',
      unread: 0,
      lastMessageAt: null,
      activity: 'unknown',
      identity: {
        remoteId: 'remote-synthetic',
        name: 'Synthetic assistant',
        description: 'A synthetic durable agent.',
        nativeUrl: null,
        capabilities: { text: true, attachments: false, approvals: false, activity: false },
        conversations: [{ id: 'synthetic-room', title: 'Main', historyScope: 'since-link', initialCursor: null }],
      },
    },
  ],
}
const api = createApiClient(
  {
    get: name =>
      name === 'connection'
        ? {
            rpc: {
              call: async (_channel: string, method: string) => ({
                ok: true,
                value: { version: 1, output: method.endsWith('/snapshot') ? snapshot : { messages: [], hasMore: false } },
              }),
            },
          }
        : undefined,
  },
  botsApi,
)
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
})

it('bounds the independently scrollable connection header while retaining consent and a separate conversation', async () => {
  render(
    <PluginQueryProvider client={client}>
      <BotsPanel />
    </PluginQueryProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic assistant/ }))
  const header = screen.getByRole('region', { name: 'Bot connection details' })
  // JSDOM has no CSS layout. Assert the rendered containment contract here; browser journeys prove 360/480px geometry.
  expect(header.classList.contains('dshx:max-h-[40%]')).toBe(true)
  expect(header.classList.contains('dshx:shrink-0')).toBe(true)
  expect(header.classList.contains('dshx:overflow-y-auto')).toBe(true)
  expect(header.tabIndex).toBe(0)
  header.focus()
  expect(document.activeElement).toBe(header)
  expect(within(header).getByText(/an already accepted vault call may finish/)).toBeTruthy()
  expect(within(header).getByRole('combobox', { name: 'Conversation' })).toBeTruthy()
  const conversation = screen.getByRole('region', { name: 'Bot conversation' })
  expect(header.contains(conversation)).toBe(false)
  expect(screen.getByRole('textbox', { name: 'Message to Synthetic assistant' })).toBeTruthy()
  fireEvent.click(within(header).getByRole('button', { name: 'Enable credential management…' }))
  expect(screen.getByRole('dialog', { name: 'Enable credential management?' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' }).getAttribute('aria-checked')).toBe('false')
})
