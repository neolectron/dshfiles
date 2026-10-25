import { expect, test, type Page } from '@playwright/test'
import { access, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Given, Then, When } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { finishJourneyAssertions, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'
import { readTerminalProof, terminalError, terminalText } from '../../fixtures/bots-terminal-adapter.mjs'

const workspace = (page: Page) => page.getByRole('main', { name: 'Bots workspace', exact: true })
const detail = (page: Page) => workspace(page).getByRole('region', { name: 'SYNTH terminal assistant details', exact: true })
const composer = (page: Page) => detail(page).getByRole('textbox', { name: 'Message to SYNTH terminal assistant', exact: true })
const counts = (proof: Awaited<ReturnType<typeof readTerminalProof>>) => ({
  opens: proof.events.filter(event => event.kind === 'open').length,
  posts: proof.events.filter(event => event.kind === 'post').length,
  polls: proof.events.filter(event => event.kind === 'poll').length,
  providerCalls: proof.events.filter(event => event.kind === 'provider-call').length,
  reconciles: proof.events.filter(event => event.kind === 'reconcile').length,
  closes: proof.events.filter(event => event.kind === 'close').length,
})
const scenarios = new WeakMap<Page, { privateScratchRoot: string; hostPid: number; failedCounts?: ReturnType<typeof counts>; requestId?: string }>()
const scenarioFor = (page: Page) => {
  const scenario = scenarios.get(page)
  if (scenario === undefined) throw new Error('The terminal Bots fixture was not initialized.')
  return scenario
}
const proofFor = (page: Page) => readTerminalProof(scenarioFor(page).privateScratchRoot)

Given('the Bots workspace with an isolated terminal-failure adapter is booted', async ({ page }: { page: Page }) => {
  const fixture = fileURLToPath(new URL('../../fixtures/bots-terminal-adapter.mjs', import.meta.url))
  const profile = await bootComposedPluginProfile({
    packageIds: ['@dshfiles/bots'],
    profileLabel: 'bots-terminal-failure',
    cordisPatch: `- insert:\n    - id: bots-terminal-adapter\n      name: ${JSON.stringify(fixture)}\n`,
  })
  if (profile.host.pid === undefined) {
    await profile.close()
    throw new Error('Scratch Host has no PID.')
  }
  scenarios.set(page, { privateScratchRoot: profile.homeRoot, hostPid: profile.host.pid })
  await visitIsolatedPluginProfile(page, profile)
})

When('the synthetic terminal bot is connected and selected', async ({ page }: { page: Page }) => {
  await workspace(page).getByRole('button', { name: 'Connect bot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect bot', exact: true })
  await expect(dialog.getByRole('combobox', { name: 'Provider adapter', exact: true })).toContainText('SYNTH terminal provider')
  await expect(dialog.locator('[data-secret-input]')).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect existing bot', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await workspace(page)
    .getByRole('navigation', { name: 'Bots', exact: true })
    .getByRole('button', { name: /SYNTH terminal assistant/ })
    .click()
  await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
  await expect(composer(page)).toBeVisible()
})

When('one synthetic message is sent to the terminal bot', async ({ page }: { page: Page }) => {
  await composer(page).fill(terminalText)
  await detail(page).getByRole('button', { name: 'Send', exact: true }).click()
})

Then('the terminal refusal immediately makes the conversation read-only and retains the failed message', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-terminal-immediate-read-only-failed-message', async () => {
    await expect(detail(page).getByText('Connection error', { exact: true })).toBeVisible({ timeout: 5000 })
    await expect(detail(page).getByRole('region', { name: 'Bot connection details', exact: true }).getByRole('alert')).toHaveText(terminalError)
    await expect(detail(page).getByText('Read-only while the connection or conversation is unavailable. Your draft stays here.', { exact: true })).toBeVisible()
    await expect(detail(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(detail(page).getByRole('button', { name: 'Retry original send', exact: true })).toBeDisabled()
    await expect(detail(page).getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem')).toHaveCount(1)
    await expect(detail(page).getByText(terminalText, { exact: true })).toBeVisible()
    await expect(detail(page).getByText('Not delivered', { exact: true })).toBeVisible()
    await expect(detail(page).getByText('View unsupported content in the original app; no safe link was supplied.', { exact: true })).toHaveCount(0)
    await expect(workspace(page).locator('[data-conversation-session]')).toHaveCount(0)
    await expect(workspace(page).getByRole('button', { name: /Select model|New session|New thread/i })).toHaveCount(0)
    await expect.poll(async () => counts(await proofFor(page)).closes).toBe(1)
    const proof = await proofFor(page)
    scenarioFor(page).failedCounts = counts(proof)
    scenarioFor(page).requestId = proof.events.find(event => event.kind === 'post')?.requestId
    expect(scenarioFor(page).requestId).toMatch(/^[0-9a-f-]{36}$/)
    await detail(page).getByText(terminalText, { exact: true }).scrollIntoViewIfNeeded()
    await expect(detail(page).getByText(terminalText, { exact: true })).toBeInViewport()
    const screenshot = test.info().outputPath('bots-terminal-failure.png')
    await page.screenshot({ path: screenshot })
    await test.info().attach('bots-terminal-failure', { path: screenshot, contentType: 'image/png' })
  })
})

When('another synthetic send is attempted while disconnected', async ({ page }: { page: Page }) => {
  // Draft editing stays available intentionally; read-only means no provider send, not discarded user input.
  await composer(page).fill('SYNTH blocked next-send draft')
  await expect(detail(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await composer(page).press('Enter')
})

Then('one native owner retains one failed send and no provider work resumes', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-terminal-single-owner-no-post-or-poll-after-retirement', async () => {
    const scenario = scenarioFor(page)
    const started = Date.now()
    let changed = false
    // Observe more than two actual adapter poll intervals; latch even a transient unexpected provider operation.
    await expect
      .poll(
        async () => {
          const proof = await proofFor(page)
          if (JSON.stringify(counts(proof)) !== JSON.stringify(scenario.failedCounts)) changed = true
          return Date.now() - started >= 2400
        },
        { timeout: 6000, intervals: [100, 250, 500] },
      )
      .toBe(true)
    expect(changed).toBe(false)
    const proof = await proofFor(page)
    expect(counts(proof)).toMatchObject({ opens: 1, posts: 1, reconciles: 0, closes: 1 })
    expect(proof.localDomainOpen).toBe(true)
    expect(proof.snapshot.connections).toHaveLength(1)
    expect(proof.snapshot.connections[0]).toMatchObject({ status: 'error', error: terminalError })
    expect(proof.snapshot.bots).toHaveLength(1)
    expect(proof.conversations).toHaveLength(1)
    expect(proof.conversations[0].messages).toHaveLength(1)
    expect(proof.conversations[0].messages[0]).toMatchObject({ text: terminalText, requestId: scenario.requestId, delivery: 'failed' })
    const files = await readdir(scenario.privateScratchRoot, { recursive: true })
    expect(files.filter(file => file.endsWith('durable_bots.json'))).toHaveLength(1)
    await test.info().attach('bots-terminal-retired-proof', { body: JSON.stringify({ counts: counts(proof), ...proof }), contentType: 'application/json' })
    await expect(detail(page).getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem')).toHaveCount(1)
  })
})

When('the terminal bot is explicitly reconnected', async ({ page }: { page: Page }) => {
  await detail(page).getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
})

Then('connection is restored without automatically resending the failed message', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-terminal-explicit-reconnect-never-resends', async () => {
    await expect.poll(async () => counts(await proofFor(page)).opens).toBe(2)
    const started = Date.now()
    let resent = false
    await expect
      .poll(
        async () => {
          const proof = await proofFor(page)
          if (counts(proof).posts !== 1 || counts(proof).reconciles !== 0) resent = true
          return Date.now() - started >= 1400
        },
        { timeout: 5000, intervals: [100, 250, 500] },
      )
      .toBe(true)
    expect(resent).toBe(false)
    const proof = await proofFor(page)
    expect(proof.snapshot.connections[0].status).toBe('connected')
    await test.info().attach('bots-terminal-reconnected-proof', { body: JSON.stringify({ counts: counts(proof), ...proof }), contentType: 'application/json' })
    expect(proof.conversations[0].messages).toHaveLength(1)
    expect(proof.conversations[0].messages[0]).toMatchObject({ requestId: scenarioFor(page).requestId, text: terminalText, delivery: 'failed' })
    await expect(composer(page)).toHaveValue(/SYNTH blocked next-send draft/)
    // The unresolved original intent deliberately blocks a different send even after reconnect.
    await expect(detail(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(detail(page).getByRole('button', { name: 'Retry original send', exact: true })).toBeEnabled()
    await expect(detail(page).getByText('Read-only while the connection or conversation is unavailable. Your draft stays here.', { exact: true })).toHaveCount(
      0,
    )
    await expect(detail(page).getByText('Not delivered', { exact: true })).toBeVisible()
  })
  await finishJourneyAssertions(page)
})

Then('all terminal fixture resources are gone', async ({ page }: { page: Page }) => {
  const scenario = scenarioFor(page)
  await expect(access(scenario.privateScratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(() => process.kill(scenario.hostPid, 0)).toThrow()
  scenarios.delete(page)
})
