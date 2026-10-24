import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Given, Then, When } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { DSHFILES_ROOT, buildPlugin } from '../../../packages/dshx/src/project/local-bundles.js'
import { finishJourneyAssertions, profileFor, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'
import { browserContainsPrivateBytes, selectedAccountId, startRemoteBotsFixture } from '../../fixtures/bots-remote-values.mjs'

const workspace = (page: Page) => page.getByRole('main', { name: 'Bots workspace', exact: true })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Connect bot', exact: true })
const scenarios = new WeakMap<Page, { remote: Awaited<ReturnType<typeof startRemoteBotsFixture>>; leaks: string[] }>()
const scenarioFor = (page: Page) => {
  const scenario = scenarios.get(page)
  if (scenario === undefined) throw new Error('The remote Bots journey was not initialized.')
  return scenario
}

Given('the Bots workspace is backed by an isolated Node account service', async ({ page }: { page: Page }) => {
  // The public Node adapter is exercised outside the Host composition. Cache/build selection must include its owner.
  if (process.env.DSHX_E2E_PREBUILT !== '1') await buildPlugin(join(DSHFILES_ROOT, 'plugins/@dshfiles/bot-openai-dot'), '@dshfiles/bot-openai-dot')
  const remote = await startRemoteBotsFixture()
  const leaks: string[] = []
  scenarios.set(page, { remote, leaks })
  page.on('request', request => {
    const origin = new URL(request.url()).origin
    if (origin === remote.serviceOrigin || origin === remote.authorityOrigin) leaks.push('Private backend HTTP was attempted by the browser.')
    if (browserContainsPrivateBytes(`${request.url()}${request.postData() ?? ''}${JSON.stringify(request.headers())}`))
      leaks.push('Backend bytes entered a browser request.')
  })
  let booted: Awaited<ReturnType<typeof bootComposedPluginProfile>> | undefined
  try {
    const fixture = fileURLToPath(new URL('../../fixtures/bots-remote-values.mjs', import.meta.url))
    booted = await bootComposedPluginProfile({
      packageIds: ['@dshfiles/bots'],
      profileLabel: 'bots-remote-service',
      cordisPatch: `- id: dshfiles-bots\n  config:\n    mode: service\n    serviceOrigin: ${JSON.stringify(remote.serviceOrigin)}\n    serviceTokenReference: secret:SYNTH_REMOTE_CONTROL\n- insert:\n    - id: bots-remote-values\n      name: ${JSON.stringify(fixture)}\n`,
    })
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Snapshot the narrowed original lifetime: the decorator must not close itself or capture optional catch-state.
    const original = booted
    const profile: typeof original = {
      ...original,
      close: async () => {
        try {
          await remote.close()
        } finally {
          await original.close()
        }
      },
    }
    await visitIsolatedPluginProfile(page, profile)
  } catch (error) {
    await remote.close()
    await booted?.close()
    throw error
  }
})

Then('the remote service supplies one nonsecret account field and requires risk acceptance', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-remote-account-metadata-and-consent', async () => {
    const form = dialog(page)
    await expect(form.getByRole('combobox', { name: 'Provider adapter', exact: true })).toContainText('OpenAI Dot (unofficial)')
    await expect(form.locator('input[data-secret-input="reference"]')).toHaveCount(0)
    await expect(form.getByRole('region', { name: 'Optional credential management', exact: true })).toHaveCount(0)
    await expect(form.getByRole('textbox', { name: 'DSH OpenAI account ID', exact: false })).toBeVisible()
    await expect(form.getByRole('textbox')).toHaveCount(2)
    await form.getByRole('textbox', { name: 'Connection name', exact: false }).fill('Remote account denial')
    await form.getByRole('textbox', { name: 'DSH OpenAI account ID', exact: false }).fill(selectedAccountId)
    await expect(form.getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true })).not.toBeChecked()
    await expect(form.getByRole('button', { name: 'Connect existing bot', exact: true })).toBeDisabled()
    await expect(form.getByRole('region', { name: 'Connection risks', exact: true })).toContainText('broad account authority')
    expect(browserContainsPrivateBytes(await page.content())).toBe(false)
    await page.screenshot({ path: test.info().outputPath('bots-remote-account-form.png') })
  })
})

When('the remote account connection risks are accepted and submitted', async ({ page }: { page: Page }) => {
  await dialog(page).getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true }).check()
  await expect(dialog(page).getByRole('button', { name: 'Connect existing bot', exact: true })).toBeEnabled()
  await dialog(page).getByRole('button', { name: 'Connect existing bot', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
})

Then('the remote authority refusal is sanitized without a bot or private browser bytes', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-remote-private-authority-refused-safely', async () => {
    const connection = workspace(page).getByRole('region', { name: 'Connection Remote account denial', exact: true })
    await expect(connection).toContainText('Authentication required')
    await expect(connection.getByRole('alert')).toContainText('selected OpenAI login is unavailable or expired')
    await expect(workspace(page).getByText('No bots connected', { exact: true })).toBeVisible()
    await expect(workspace(page).getByRole('navigation', { name: 'Bots', exact: true }).getByRole('button')).toHaveCount(0)
    await expect(workspace(page).locator('[data-conversation-session]')).toHaveCount(0)
    await expect(workspace(page).getByRole('button', { name: /Select model|New session|New thread/i })).toHaveCount(0)
    await expect(workspace(page).getByRole('textbox', { name: /Message to|\/ commands, @ files or sessions/ })).toHaveCount(0)
    await expect(workspace(page).getByRole('region', { name: 'Credential management', exact: true })).toHaveCount(0)
    expect(browserContainsPrivateBytes(await page.content())).toBe(false)
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(browserContainsPrivateBytes(storage)).toBe(false)
    expect(scenarioFor(page).leaks).toEqual([])
    await page.screenshot({ path: test.info().outputPath('bots-remote-account-denied.png') })
  })
})

Then('only the standalone service owns the denied Bots connection state', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-remote-service-only-data-owner-no-provider', async () => {
    const { remote, leaks } = scenarioFor(page)
    await expect
      .poll(async () => {
        try {
          await remote.verifyOwnership(profileFor(page).homeRoot)
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
    expect(leaks).toEqual([])
  })
  await finishJourneyAssertions(page)
})
