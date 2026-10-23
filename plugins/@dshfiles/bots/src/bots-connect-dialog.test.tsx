// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotsConnectDialog } from './bots-connect-dialog.js'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'

const adapter: BotAdapterInfo = {
  id: 'independent-provider',
  version: 1,
  name: 'Independent provider',
  description: 'A synthetic provider.',
  risk: 'Synthetic test data only.',
  fields: [{ key: 'endpointLabel', label: 'Endpoint label', kind: 'text', required: true, help: 'Enter test.' }],
}
// JSDOM has no layout observer; Radix observes checkbox dimensions, not the consent/form state under test.
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
  vi.unstubAllGlobals()
})

describe('Bots connect dialog', () => {
  it('enables immediate submit after checking consent even when the last field was blurred first', async () => {
    const onConnect = vi.fn()
    render(<BotsConnectDialog adapters={[adapter]} failed={false} onClose={vi.fn()} onConnect={onConnect} pending={false} />)
    const submit = screen.getByRole('button', { name: 'Connect existing bot' })
    const endpoint = screen.getByRole('textbox', { name: /Endpoint label/ })
    fireEvent.change(endpoint, { target: { value: 'test' } })
    // Clicking the risk checkbox naturally blurs the preceding field. Do not blur consent to unlock submission.
    await act(async () => {
      fireEvent.blur(endpoint)
    })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and accept these connection risks' }))
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledExactlyOnceWith({
        adapterId: 'independent-provider',
        label: 'Independent provider',
        config: { endpointLabel: 'test' },
        acceptRisks: true,
      }),
    )
  })

  it('keeps submission disabled without explicit consent and after consent is revoked', async () => {
    render(<BotsConnectDialog adapters={[adapter]} failed={false} onClose={vi.fn()} onConnect={vi.fn()} pending={false} />)
    const endpoint = screen.getByRole('textbox', { name: /Endpoint label/ })
    const consent = screen.getByRole('checkbox', { name: 'I understand and accept these connection risks' })
    const submit = screen.getByRole('button', { name: 'Connect existing bot' })
    fireEvent.change(endpoint, { target: { value: 'test' } })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(consent)
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
    fireEvent.click(consent)
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(true))
  })

  it('leaves the optional additional vault grant unchecked and submits manual mode by default', async () => {
    const onConnect = vi.fn()
    const managed = { ...adapter, credentialManagement: { label: 'Allow synthetic vault saves', description: 'Synthetic management capability.' } }
    render(<BotsConnectDialog adapters={[managed]} failed={false} onClose={vi.fn()} onConnect={onConnect} pending={false} />)
    const grant = screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' })
    expect(grant.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(screen.getByRole('textbox', { name: /Endpoint label/ }), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and accept these connection risks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing bot' }))
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onConnect.mock.calls[0]?.[0].manageCredentials).toBe(false)
  })

  it('sends the additional vault grant only when explicitly selected and resets it on adapter changes', async () => {
    const onConnect = vi.fn()
    const metadata = { label: 'Allow synthetic vault saves', description: 'Synthetic management capability.' }
    render(
      <BotsConnectDialog
        adapters={[
          { ...adapter, credentialManagement: metadata },
          { ...adapter, id: 'second', name: 'Second', credentialManagement: metadata },
        ]}
        failed={false}
        onClose={vi.fn()}
        onConnect={onConnect}
        pending={false}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider adapter' }), { target: { value: 'second' } })
    expect(screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.change(screen.getByRole('textbox', { name: /Endpoint label/ }), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and accept these connection risks' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow synthetic vault saves' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing bot' }))
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onConnect.mock.calls[0]?.[0].manageCredentials).toBe(true)
  })
})
