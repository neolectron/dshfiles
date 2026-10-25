import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { Given, Then, When } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { finishJourneyAssertions, profileFor, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'
import { browserContainsPrivateBytes, selectedAccountId, startDotEnrollmentFixture } from '../../fixtures/dot-enrollment.mjs'

const scenarios = new WeakMap<Page, { fixture: Awaited<ReturnType<typeof startDotEnrollmentFixture>>; leaks: string[] }>()
const scenario = (page: Page) => {
  const value = scenarios.get(page)
  if (!value) throw new Error('The synthetic enrollment fixture was not initialized.')
  return value
}
const raster = (page: Page) => page.getByLabel('Human-only sign-in browser raster', { exact: true })
const surface = (page: Page) => page.getByRole('heading', { name: 'Connect Dot in a fresh browser', exact: true }).locator('..')

Given('the real Dot connection page has an isolated browser and Node service', async ({ page }: { page: Page }) => {
  test.setTimeout(150_000)
  const fixture = await startDotEnrollmentFixture(),
    leaks: string[] = []
  scenarios.set(page, { fixture, leaks })
  page.on('request', request => {
    if ([fixture.serviceOrigin, fixture.wireOrigin].includes(new URL(request.url()).origin)) leaks.push('Backend origin reached from DSH browser')
    if (browserContainsPrivateBytes(`${request.url()}${request.postData() ?? ''}${JSON.stringify(request.headers())}`))
      leaks.push('Backend secret reached DSH browser')
  })
  let original: Awaited<ReturnType<typeof bootComposedPluginProfile>> | undefined
  try {
    const owner = fileURLToPath(new URL('../../fixtures/dot-enrollment.mjs', import.meta.url))
    original = await bootComposedPluginProfile({
      packageIds: ['@dshfiles/bots', '@dshfiles/bot-openai-dot'],
      profileLabel: 'dot-enrollment',
      cordisPatch: `- id: dshfiles-bots\n  config:\n    mode: service\n    serviceOrigin: ${JSON.stringify(fixture.serviceOrigin)}\n    serviceTokenReference: secret:SYNTH_DOT_ENROLLMENT\n- insert:\n    - id: dot-enrollment-fixture\n      name: ${JSON.stringify(owner)}\n`,
      seedHome: fixture.seedHome,
    })
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Capture the narrowed original lifetime for cleanup, not the optional catch-state binding.
    const profile = original
    const host = profile.host
    await visitIsolatedPluginProfile(page, {
      ...profile,
      close: async () => {
        let cleanup
        try {
          cleanup = await fixture.close()
        } finally {
          await profile.close()
        }
        expect(host.exitCode !== null || host.signalCode !== null).toBe(true)
        await test.info().attach('dot-enrollment-owned-cleanup', {
          body: JSON.stringify({ ...cleanup, nativeHostPid: host.pid, nativeHostExited: true }),
          contentType: 'application/json',
        })
      },
    })
    expect(profile.output()).not.toMatch(/did not activate|failed to activate|\bpending\b/i)
  } catch (error) {
    await Promise.allSettled([fixture.close(), original?.close()])
    throw error
  }
  await page.getByRole('button', { name: 'Dot connection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connect Dot in a fresh browser', exact: true })).toBeVisible()
})

Then('Dot enrollment requires human consent without opening any browser', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-enrollment-real-page-consent', async () => {
    await expect(surface(page).getByRole('checkbox')).not.toBeChecked()
    await expect(page.getByRole('button', { name: 'Start browser', exact: true })).toBeDisabled()
    expect(scenario(page).fixture.state.opens).toBe(0)
    await expect(page.getByText(/no separate ChatGPT tab or desktop helper is required/)).toBeVisible()
  })
})

When('the human starts Dot enrollment and types only synthetic text into its real browser', async ({ page }: { page: Page }) => {
  await surface(page).getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Start browser', exact: true }).click()
  await expect(surface(page).getByRole('status')).toContainText('Browser available.', { timeout: 30_000 })
  await expect(raster(page)).toBeVisible()
  expect(await raster(page).evaluate(element => element instanceof HTMLCanvasElement && element.width === 1280 && element.height === 900)).toBe(true)
  const box = await raster(page).boundingBox()
  if (!box) throw new Error('Actual raster canvas was not visible.')
  const scale = Math.min(box.width / 1280, box.height / 900)
  await raster(page).click({ position: { x: (box.width - 1280 * scale) / 2 + 300 * scale, y: (box.height - 900 * scale) / 2 + 250 * scale } })
  await page.keyboard.type('SYNTHETIC', { delay: 90 })
  try {
    await expect.poll(() => scenario(page).fixture.state.typed).toBe(true)
  } catch {
    throw new Error(`Synthetic-only enrollment counters: ${JSON.stringify(scenario(page).fixture.state)}`)
  }
  await expect(page.getByLabel('Type into sign-in browser', { exact: true })).toHaveValue('')
  expect(browserContainsPrivateBytes(await page.content())).toBe(false)
  await page.waitForResponse(response => response.url().endsWith('/api/dshfiles/dot-auth/frame') && response.status() === 200)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.screenshot({ path: test.info().outputPath('dot-connection.png') })
})

When('the human explicitly chooses Use this session on the real Dot page', async ({ page }: { page: Page }) => {
  await page.getByRole('button', { name: 'Use this session', exact: true }).click()
  await expect(surface(page).getByRole('status')).toContainText('Browser session ready. Return to Bots and connect/reconnect selected account.')
})

Then('the human viewer is revoked while the same browser remains usable only by Node', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-enrollment-completed-retained-browser', async () => {
    await expect(raster(page)).toBeHidden()
    expect(await raster(page).evaluate(element => element instanceof HTMLCanvasElement && element.width === 0 && element.height === 0)).toBe(true)
    await expect(page.getByLabel('Type into sign-in browser', { exact: true })).toBeDisabled()
    await scenario(page).fixture.verifyRetained()
    expect(scenario(page).fixture.state.completed).toBe(1)
    expect(scenario(page).leaks).toEqual([])
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state }))
    expect(scenario(page).fixture.containsPrivate(storage)).toBe(false)
    expect(scenario(page).fixture.containsPrivate(await page.content())).toBe(false)
    expect(await page.content()).not.toContain('SYNTHETIC HUMAN-ONLY BROWSER')
  })
})

When('the synthetic Dot account is connected and one message is sent through Bots', async ({ page }: { page: Page }) => {
  await page.getByRole('button', { name: 'Bots', exact: true }).click()
  const workspace = page.getByRole('main', { name: 'Bots workspace', exact: true })
  await workspace.getByRole('button', { name: 'Connect bot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect bot', exact: true })
  await dialog.getByRole('textbox', { name: 'Connection name', exact: false }).fill('Synthetic browser Dot')
  await dialog.getByRole('textbox', { name: 'DSH OpenAI account ID', exact: false }).fill(selectedAccountId)
  await dialog.getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect existing bot', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await workspace
    .getByRole('navigation', { name: 'Bots', exact: true })
    .getByRole('button', { name: /Synthetic Dot/ })
    .click()
  const composer = workspace.getByRole('textbox', { name: 'Message to Synthetic Dot', exact: true })
  await composer.fill('Synthetic retained-browser message')
  await composer.press('Enter')
  await expect(workspace.getByText('Synthetic reply through retained browser', { exact: true })).toBeVisible({ timeout: 20_000 })
})

Then('only Node owns the synthetic Dot conversation and one outbox operation', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-enrollment-node-only-send-reply', async () => {
    const workspace = page.getByRole('main', { name: 'Bots workspace', exact: true })
    await expect(workspace.locator('[data-conversation-session]')).toHaveCount(0)
    await expect(workspace.getByRole('button', { name: /Select model|New session|New thread/i })).toHaveCount(0)
    expect(await scenario(page).fixture.verifyOwnership(profileFor(page).homeRoot)).toEqual({
      localDomainOpen: false,
      connections: 1,
      bots: 1,
      outbox: 1,
      sends: 1,
    })
    expect(scenario(page).leaks).toEqual([])
    expect(browserContainsPrivateBytes(await page.content())).toBe(false)
  })
  await finishJourneyAssertions(page)
})
