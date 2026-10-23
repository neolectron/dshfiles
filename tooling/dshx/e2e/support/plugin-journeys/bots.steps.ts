import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { Given, Then, When } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { finishJourneyAssertions, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'

const workspace = (page: Page) => page.getByRole('main', { name: 'Bots workspace', exact: true })
const connectDialog = (page: Page) => page.getByRole('dialog', { name: 'Connect bot', exact: true })
const detail = (page: Page) => workspace(page).getByRole('region', { name: 'Fixture assistant details', exact: true })
const composer = (page: Page) => workspace(page).getByRole('textbox', { name: 'Message to Fixture assistant', exact: true })
const openFixtureBot = async (page: Page): Promise<void> => {
  await workspace(page)
    .getByRole('navigation', { name: 'Bots', exact: true })
    .getByRole('button', { name: /Fixture assistant/ })
    .click()
  await expect(detail(page)).toBeVisible()
}
const noNativeSession = async (page: Page): Promise<void> => {
  await expect(workspace(page).locator('[data-conversation-session]')).toHaveCount(0)
  await expect(workspace(page).getByRole('button', { name: /Select model|New session|New thread/i })).toHaveCount(0)
  await expect(workspace(page).getByRole('textbox', { name: /\/ commands, @ files or sessions/ })).toHaveCount(0)
}

Given('the Bots workspace with an isolated synthetic adapter is booted', async ({ page }: { page: Page }) => {
  const fixture = fileURLToPath(new URL('../../fixtures/bots-adapter.mjs', import.meta.url))
  const profile = await bootComposedPluginProfile({
    packageIds: ['@dshfiles/bots'],
    profileLabel: 'bots-fixture',
    cordisPatch: `- insert:\n    - id: bots-fixture-adapter\n      name: ${JSON.stringify(fixture)}\n`,
  })
  await visitIsolatedPluginProfile(page, profile)
})

When('the Bots workspace is opened', async ({ page }: { page: Page }) => {
  await page.getByRole('button', { name: 'Bots', exact: true }).click()
  await expect(workspace(page).getByRole('heading', { name: 'Bots', exact: true })).toBeVisible()
})

Then('the Bots roster is empty without native Session controls', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-empty-global-workspace', async () => {
    await expect(workspace(page).getByText('No bots connected', { exact: true })).toBeVisible()
    await expect(workspace(page).getByRole('button', { name: 'Connect bot', exact: true })).toBeEnabled()
    await noNativeSession(page)
  })
})
When('the bot connection dialog is opened', async ({ page }: { page: Page }) => {
  await workspace(page).getByRole('button', { name: 'Connect bot', exact: true }).click()
  await expect(connectDialog(page)).toBeVisible()
})
Then('bot adapters are unavailable rather than sample identities', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-no-fake-adapters', async () => {
    await expect(connectDialog(page)).toContainText('No bot adapters are available.')
    await expect(connectDialog(page).getByRole('textbox')).toHaveCount(0)
  })
  await finishJourneyAssertions(page)
})
Then('the bot adapter form uses two secret references and explicit risk acceptance', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-metadata-reference-fields-and-consent', async () => {
    const dialog = connectDialog(page)
    const references = dialog.locator('input[data-secret-input="reference"]')
    await expect(references).toHaveCount(2)
    await expect(dialog.getByRole('combobox', { name: 'Provider adapter', exact: true })).toContainText('OpenAI Dot (unofficial)')
    await expect(dialog.getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true })).not.toBeChecked()
    await expect(dialog.getByRole('region', { name: 'Optional credential management', exact: true }).getByRole('checkbox')).not.toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Connect existing bot', exact: true })).toBeDisabled()
    await references.nth(0).fill('secret:TEST_ACCESS')
    await references.nth(1).fill('secret:TEST_SESSION')
    await expect(dialog.getByRole('button', { name: 'Connect existing bot', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('region', { name: 'Connection risks', exact: true })).toContainText('broad ChatGPT account access')
    // No connect click: metadata proof must not touch an account, even when synthetic reference aliases are used.
  })
  await finishJourneyAssertions(page)
})

When('the synthetic existing bot is connected after accepting its risks', async ({ page }: { page: Page }) => {
  await workspace(page).getByRole('button', { name: 'Connect bot', exact: true }).click()
  const dialog = connectDialog(page)
  await dialog.getByRole('textbox', { name: 'Endpoint label', exact: false }).fill('test')
  await expect(dialog.getByRole('button', { name: 'Connect existing bot', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'I understand and accept these connection risks', exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect existing bot', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await openFixtureBot(page)
})
Then('the synthetic bot identity and local-cache scope are shown', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-existing-identity-scope-health', async () => {
    await expect(detail(page).getByRole('heading', { name: 'Fixture assistant', exact: true })).toBeVisible()
    await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
    await expect(detail(page)).toContainText('Activity unknown')
    await expect(detail(page)).toContainText('Local cache since linking, not a full history import.')
    await expect(detail(page).getByRole('combobox', { name: 'Conversation', exact: true }).getByRole('option')).toHaveCount(2)
    await noNativeSession(page)
  })
})
When('bot drafts are written in two provider conversations', async ({ page }: { page: Page }) => {
  await composer(page).fill('Main draft kept in memory')
  await detail(page).getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('conversation-2')
  await expect(composer(page)).toHaveValue('')
  await composer(page).fill('Project draft kept in memory')
})
Then('each bot conversation keeps its own draft', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-per-conversation-drafts', async () => {
    await detail(page).getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('conversation-1')
    await expect(composer(page)).toHaveValue('Main draft kept in memory')
    await detail(page).getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('conversation-2')
    await expect(composer(page)).toHaveValue('Project draft kept in memory')
    await detail(page).getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('conversation-1')
  })
})
When('{string} is sent to the synthetic bot', async ({ page }: { page: Page }, text: string) => {
  await composer(page).fill(text)
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue('')
})
Then('the bot echo and unsolicited update arrive without a native Session', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-real-api-send-and-proactive-poll', async () => {
    await expect(detail(page).getByText('Echo: Hello from the Bots workspace', { exact: true })).toBeVisible({ timeout: 15000 })
    await expect(detail(page).getByText('A proactive update from Fixture assistant.', { exact: true })).toBeVisible({ timeout: 15000 })
    await expect(detail(page).getByText('A proactive update from Fixture assistant.', { exact: true })).toBeInViewport({ ratio: 1 })
    await detail(page).getByRole('button', { name: 'Mark read', exact: true }).click()
    await noNativeSession(page)
    await page.screenshot({ path: test.info().outputPath('bots-workspace.png') })
  })
})
When('the Bots pane is {int} pixels wide', async ({ page }: { page: Page }, width: number) => {
  await workspace(page).evaluate((element, size) => {
    element.style.width = `${size}px`
    element.style.maxWidth = '100%'
  }, width)
  await expect(workspace(page)).toHaveCSS('width', `${width}px`)
})
Then('narrow Bots navigation returns to the roster and conversation', async ({ page }: { page: Page }) => {
  const width = Math.round(await workspace(page).evaluate(element => element.getBoundingClientRect().width))
  await recordAssertion(page, `bots-narrow-container-back-${width}`, async () => {
    await detail(page).getByRole('button', { name: 'Back to bots', exact: true }).click()
    await expect(workspace(page).getByRole('complementary', { name: 'Bot roster', exact: true })).toBeVisible()
    await openFixtureBot(page)
    expect(await workspace(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(composer(page)).toBeVisible()
    await expect(detail(page).getByText('A proactive update from Fixture assistant.', { exact: true })).toBeInViewport({ ratio: 1 })
  })
})
When('the synthetic bot is disconnected', async ({ page }: { page: Page }) => {
  await composer(page).fill('Never automatically resend this draft')
  await detail(page).getByRole('button', { name: 'Disconnect', exact: true }).click()
})
Then('its conversation becomes read-only while its draft stays', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-disconnect-retains-draft', async () => {
    await expect(detail(page).getByText('Disconnected', { exact: true })).toBeVisible()
    await expect(composer(page)).toHaveValue('Never automatically resend this draft')
    await expect(detail(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(detail(page)).toContainText('Disconnecting stops local sync only, not the remote bot.')
  })
})
When('the synthetic bot is reconnected', async ({ page }: { page: Page }) => {
  await detail(page).getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
})
Then('reconnect does not resend the draft', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-reconnect-no-automatic-send', async () => {
    await expect(composer(page)).toHaveValue('Never automatically resend this draft')
    await expect(detail(page).getByText('Echo: Never automatically resend this draft', { exact: true })).toHaveCount(0)
    await expect(detail(page).getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  })
})
When('local bot removal is cancelled', async ({ page }: { page: Page }) => {
  await detail(page).getByRole('button', { name: 'Remove local data', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove local bot data?', exact: true })
  await expect(dialog).toContainText('does not stop or delete the remote bot')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})
Then('the synthetic bot remains connected', async ({ page }: { page: Page }) => {
  await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
})
When('local bot removal is confirmed', async ({ page }: { page: Page }) => {
  await detail(page).getByRole('button', { name: 'Remove local data', exact: true }).click()
  await page.getByRole('dialog', { name: 'Remove local bot data?', exact: true }).getByRole('button', { name: 'Remove local data', exact: true }).click()
})
Then('the local roster is empty again', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-confirmed-local-remove', async () => {
    await expect(page.getByRole('dialog', { name: 'Remove local bot data?', exact: true })).toHaveCount(0)
    await expect(workspace(page).getByText('No bots connected', { exact: true })).toBeVisible()
  })
  await finishJourneyAssertions(page)
})

const credentialRegion = (page: Page) => detail(page).getByRole('region', { name: 'Credential management', exact: true })
const credentialDialog = (page: Page) => page.getByRole('dialog', { name: 'Enable credential management?', exact: true })
Then('synthetic credential management is not granted', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-credential-grant-default-off', async () => {
    await expect(credentialRegion(page)).toContainText('Automatic vault saves are not granted.')
    await expect(credentialRegion(page).getByRole('button', { name: 'Enable credential management…', exact: true })).toBeEnabled()
  })
})
When('the synthetic credential permission dialog is cancelled after consent', async ({ page }: { page: Page }) => {
  await credentialRegion(page).getByRole('button', { name: 'Enable credential management…', exact: true }).click()
  await credentialDialog(page).getByRole('checkbox', { name: 'Allow synthetic credential saves', exact: true }).check()
  await credentialDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
})
When('the synthetic credential permission dialog is reopened', async ({ page }: { page: Page }) => {
  await credentialRegion(page).getByRole('button', { name: 'Enable credential management…', exact: true }).click()
})
Then('synthetic credential consent is unchecked and enabling is disabled', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-credential-reopen-resets-consent', async () => {
    await expect(credentialDialog(page).getByRole('checkbox', { name: 'Allow synthetic credential saves', exact: true })).not.toBeChecked()
    await expect(credentialDialog(page).getByRole('button', { name: 'Enable credential management', exact: true })).toBeDisabled()
  })
})
When('synthetic credential management is explicitly enabled', async ({ page }: { page: Page }) => {
  await credentialDialog(page).getByRole('checkbox', { name: 'Allow synthetic credential saves', exact: true }).check()
  await credentialDialog(page).getByRole('button', { name: 'Enable credential management', exact: true }).click()
  await expect(credentialDialog(page)).toHaveCount(0)
})
Then('synthetic credential management remains enabled after a reload', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-credential-grant-survives-browser-reload', async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Bots', exact: true }).click()
    await openFixtureBot(page)
    await expect(credentialRegion(page)).toContainText('Managed credential references enabled.')
    await expect(credentialRegion(page).getByRole('button', { name: 'Revoke credential management', exact: true })).toBeEnabled()
  })
})
When('synthetic credential management is revoked', async ({ page }: { page: Page }) => {
  await credentialRegion(page).getByRole('button', { name: 'Revoke credential management', exact: true }).click()
})
Then('synthetic credential management is not granted and the conversation remains connected', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'bots-credential-revoke-retains-conversation', async () => {
    await expect(credentialRegion(page)).toContainText('Automatic vault saves are not granted.')
    await expect(detail(page).getByText('Connected', { exact: true })).toBeVisible()
    await expect(composer(page)).toBeEnabled()
  })
  await finishJourneyAssertions(page)
})
