// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createApiClient } from '@dshfiles/dshx/client'
import { PluginQueryProvider, QueryClient } from '@dshfiles/plugin-ui/query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botsApi } from './api.js'
import { BotsCredentialManagement } from './bots-credential-management.js'
import type { BotAdapterInfo } from './adapter.js'
import type { BotsClient } from './bots-queries.js'
import type { BotConnection } from './contract.js'

const adapter: BotAdapterInfo = {
  id: 'synthetic',
  version: 1,
  name: 'Synthetic',
  description: '',
  risk: '',
  fields: [],
  credentialManagement: { label: 'Allow synthetic vault saves', description: 'Synthetic lifecycle only.' },
}
const connection = (credentialManagement = false): BotConnection => ({
  id: 'synthetic-connection',
  adapterId: adapter.id,
  label: 'Synthetic connection',
  status: 'connected',
  error: null,
  lastSyncAt: null,
  enabled: true,
  accountId: 'synthetic-account',
  createdAt: 0,
  credentialManagement,
})
type GrantRequest = { version: number; input: Parameters<BotsClient['setCredentialManagement']>[0] }
const clients: QueryClient[] = []
const setup = (granted = false, metadata: BotAdapterInfo | null = adapter) => {
  const call = vi.fn(async (_channel: string, _method: string, _input: GrantRequest) => ({
    ok: true,
    value: { version: 1, output: { revision: 1, bots: [], adapters: [adapter], connections: [connection(granted)] } },
  }))
  const api = createApiClient({ get: name => (name === 'connection' ? { rpc: { call } } : undefined) }, botsApi)
  const client = new QueryClient()
  clients.push(client)
  const view = render(
    <PluginQueryProvider client={client}>
      <BotsCredentialManagement api={api} connection={connection(granted)} adapter={metadata ?? undefined} busy={false} />
    </PluginQueryProvider>,
  )
  return { call, ...view }
}
beforeEach(() => {
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
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
})

describe('credential management permission UI', () => {
  it('requires fresh unchecked consent before enabling and resets it on reopen', async () => {
    const { call } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Enable credential management…' }))
    expect(screen.getByRole('dialog', { name: 'Enable credential management?' })).toBeTruthy()
    const consent = screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' })
    const enable = screen.getByRole('button', { name: 'Enable credential management' })
    expect(consent.getAttribute('aria-checked')).toBe('false')
    expect(enable.hasAttribute('disabled')).toBe(true)
    expect(call).not.toHaveBeenCalled()
    fireEvent.click(consent)
    expect(enable.hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable credential management…' }))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable credential management' }))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[2]).toEqual({ version: 1, input: { connectionId: 'synthetic-connection', enabled: true, acceptRisks: true } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('revokes immediately without consent or deleting credentials, including when the adapter is missing', async () => {
    const { call } = setup(true, null)
    expect(screen.getByText(/an already accepted vault call may finish/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke credential management' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call.mock.calls[0]?.[1]).toContain('/setCredentialManagement')
    expect(call.mock.calls[0]?.[2]).toEqual({ version: 1, input: { connectionId: 'synthetic-connection', enabled: false } })
  })

  it('does not offer grants when an adapter has not advertised support', () => {
    const { call } = setup(false, { ...adapter, credentialManagement: undefined })
    expect(screen.queryByRole('button')).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
