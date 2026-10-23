import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { Given, Then, When, After } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { browserDiagnosticsFor, finishJourneyAssertions, profileFor, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'
import { buildDotAuthFixture } from '../../fixtures/dot-auth-build.js'
import { auditDotAuthNetwork } from '../../fixtures/dot-auth-network.js'
const network = new WeakMap<Page, ReturnType<typeof auditDotAuthNetwork>>()

const packages = new WeakMap<Page, Awaited<ReturnType<typeof buildDotAuthFixture>>>()
const fixtureProfiles = new WeakMap<Page, Awaited<ReturnType<typeof bootComposedPluginProfile>>>()
const counts = z.object({
  opens: z.number(),
  closes: z.number(),
  frames: z.number(),
  pointers: z.number(),
  x: z.number(),
  y: z.number(),
  textEvents: z.number(),
  textUnits: z.number(),
  keys: z.number(),
  statusFailures: z.number(),
  statusCalls: z.number(),
  statusEntries: z.number(),
  statusPathMatch: z.boolean(),
  statusMethodPost: z.boolean(),
  statusSearchEmpty: z.boolean(),
})
const state = async (page: Page) => JsonText.parse(await readFile(join(profileFor(page).homeRoot, 'dot-auth-synthetic-state.json'), 'utf8'), counts)
const surface = (page: Page) => page.getByRole('main', { name: 'Synthetic Dot auth verification', exact: true })
const canvas = (page: Page) => surface(page).getByLabel('Human-only sign-in browser raster', { exact: true })
const pixel = async (page: Page) =>
  canvas(page).evaluate(element => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected native canvas.')
    const context = element.getContext('2d')
    if (!context) throw new Error('Expected canvas pixel access.')
    return Array.from(context.getImageData(10, 10, 1, 1).data)
  })

Given('the native synthetic Dot auth viewer profile is booted', async ({ page }: { page: Page }) => {
  network.set(page, auditDotAuthNetwork(page))
  const fixture = await buildDotAuthFixture()
  packages.set(page, fixture)
  const images = await page.evaluate(() => {
    const image = (changed: boolean) => {
      const c = document.createElement('canvas')
      c.width = 640
      c.height = 320
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('Synthetic JPEG generator needs a browser canvas.')
      ctx.fillStyle = changed ? '#008000' : '#b00000'
      ctx.fillRect(0, 0, 640, 320)
      ctx.fillStyle = '#ffffff'
      ctx.font = '28px sans-serif'
      ctx.fillText('SYNTHETIC DOT AUTH FIXTURE', 32, 64)
      ctx.fillText(changed ? 'LOCAL INPUT RECEIVED' : 'CLICK AND TYPE — NO ACCOUNT', 32, 160)
      const bytes = c.toDataURL('image/jpeg').split(',')[1]
      if (!bytes) throw new Error('Synthetic JPEG encoding failed.')
      return bytes
    }
    return { initial: image(false), typed: image(true) }
  })
  const profile = await bootComposedPluginProfile({
    packageIds: ['@dshfiles/ui-styles', '@dshfiles/shared-runtime'],
    profileLabel: 'dot-auth-synthetic',
    additionalBundleIds: [fixture.packageId],
    async seedHome(home) {
      // Register the temporary package only in this disposable profile, not the repository or a live profile.
      const localScope = join(home, 'profiles/dshx-boot/node_modules/@dshfiles')
      await mkdir(localScope, { recursive: true })
      await symlink(fixture.root, join(localScope, 'dot-auth-synthetic-fixture'), 'dir')
      await writeFile(join(home, 'initial.jpg'), Buffer.from(images.initial, 'base64'))
      await writeFile(join(home, 'typed.jpg'), Buffer.from(images.typed, 'base64'))
    },
  })
  fixtureProfiles.set(page, profile)
  let finalOutput = ''
  const owned = {
    ...profile,
    close: async () => {
      finalOutput = profile.output()
      await profile.close()
    },
  }
  try {
    await visitIsolatedPluginProfile(page, owned)
  } catch {
    await test.info().attach('dot-auth-sanitized-boot-failure', { body: finalOutput, contentType: 'text/plain' })
    await writeFile(test.info().outputPath('dot-auth-sanitized-boot.txt'), finalOutput)
    throw new Error(`Synthetic scratch startup failed: ${JSON.stringify(browserDiagnosticsFor(page))}. See sanitized boot attachment.`)
  }
  expect(profile.output()).not.toMatch(/did not activate|failed to activate|\bpending\b/i)
  await page.getByRole('button', { name: 'Synthetic Dot auth', exact: true }).click()
  await expect(surface(page)).toBeVisible()
})
After(async ({ page }: { page: Page }) => {
  // Never delete a compiled artifact while its owning Host still serves it.
  await fixtureProfiles.get(page)?.close()
  await packages.get(page)?.close()
})
Then('synthetic Dot consent is unchecked and no browser has opened', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-auth-native-default-off', async () => {
    await expect(surface(page).getByRole('checkbox')).not.toBeChecked()
    await expect(surface(page).getByRole('button', { name: 'Start browser', exact: true })).toBeDisabled()
    expect((await state(page)).opens).toBe(0)
  })
})
When('synthetic Dot consent is accepted and the raster is started', async ({ page }: { page: Page }) => {
  await surface(page).getByRole('checkbox').click()
  await surface(page).getByRole('button', { name: 'Start browser', exact: true }).click()
  try {
    await expect(surface(page).getByRole('status')).toContainText('Browser available.')
  } catch {
    throw new Error(
      `Synthetic viewer failed: ${JSON.stringify({ network: network.get(page), state: await state(page), diagnostics: browserDiagnosticsFor(page) })}`,
    )
  }
  await expect(canvas(page)).toBeVisible()
})
Then('the known synthetic JPEG is decoded in the real viewer canvas', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-auth-real-jpeg-decode', async () => {
    expect(await canvas(page).evaluate(e => e instanceof HTMLCanvasElement && e.width === 640 && e.height === 320)).toBe(true)
    const rgba = await pixel(page)
    expect(rgba[0]).toBeGreaterThan(150)
    expect(rgba[1]).toBeLessThan(10)
    await page.screenshot({ path: test.info().outputPath('dot-auth-synthetic-before.png') })
  })
})
When('trusted pointer keyboard and browser text input reach the synthetic port', async ({ page }: { page: Page }) => {
  await surface(page)
    .getByLabel('Type into sign-in browser', { exact: true })
    .evaluate(element => {
      for (const type of ['beforeinput', 'compositionstart', 'compositionend', 'keydown', 'keyup']) {
        element.addEventListener(type, event => {
          if (event.isTrusted) element.setAttribute(`data-trusted-${type}`, String(Number(element.getAttribute(`data-trusted-${type}`) ?? '0') + 1))
        })
      }
    })
  const box = await canvas(page).boundingBox()
  if (!box) throw new Error('Synthetic raster is not visible.')
  await canvas(page).click({ position: { x: box.width / 2, y: box.height / 2 } })
  await page.keyboard.type('hello', { delay: 80 })
  await page.keyboard.insertText('é')
  await expect.poll(async () => (await state(page)).textUnits).toBe(6)
  await page.keyboard.press('ArrowLeft')
  try {
    await expect.poll(async () => (await state(page)).keys).toBe(2)
  } catch {
    const trusted = await surface(page)
      .getByLabel('Type into sign-in browser', { exact: true })
      .evaluate(element =>
        Object.fromEntries(
          element
            .getAttributeNames()
            .filter(name => name.startsWith('data-trusted-'))
            .map(name => [name, element.getAttribute(name)]),
        ),
      )
    throw new Error(`Synthetic input counters: ${JSON.stringify({ trusted, state: await state(page), network: network.get(page), diagnostics: browserDiagnosticsFor(page) })}`)
  }
})
Then('mapped coordinates and text change only the synthetic pixels', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-auth-trusted-events-input-and-pixels', async () => {
    const observed = await state(page)
    expect(observed.pointers).toBeGreaterThanOrEqual(2)
    const proxy = surface(page).getByLabel('Type into sign-in browser', { exact: true })
    expect(Number(await proxy.getAttribute('data-trusted-beforeinput'))).toBe(6)
    expect(Number(await proxy.getAttribute('data-trusted-keydown'))).toBeGreaterThanOrEqual(6)
    expect(Math.abs(observed.x - 320)).toBeLessThanOrEqual(1)
    expect(Math.abs(observed.y - 160)).toBeLessThanOrEqual(1)
    await expect.poll(async () => (await pixel(page))[1]).toBeGreaterThan(100)
    await expect(surface(page).getByLabel('Type into sign-in browser', { exact: true })).toHaveValue('')
    await page.screenshot({ path: test.info().outputPath('dot-auth-synthetic-input.png') })
  })
})
When('the synthetic browser is cancelled', async ({ page }: { page: Page }) => {
  await surface(page).getByRole('button', { name: 'Cancel browser', exact: true }).click()
})
Then('native cancellation is acknowledged and private raster input is cleared', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-auth-native-cancel-and-clear', async () => {
    await expect(surface(page).getByRole('status')).toContainText('backend acknowledged')
    await expect.poll(async () => (await state(page)).closes).toBe(1)
    expect(await canvas(page).evaluate(e => e instanceof HTMLCanvasElement && e.width === 0 && e.height === 0)).toBe(true)
    await expect(canvas(page)).toBeHidden()
    await expect(surface(page).getByLabel('Type into sign-in browser', { exact: true })).toBeDisabled()
    const diagnostics = browserDiagnosticsFor(page)
    expect(diagnostics.filter(message => !message.startsWith('requestfailed: fetch net::ERR_ABORTED'))).toEqual([])
    const audit = network.get(page)
    if (!audit) throw new Error('Missing bounded network audit.')
    expect(audit.malformed).toBe(0)
    expect(audit.failures).toBe(0)
    expect(audit.protected).toBe(audit.status + audit.frame + audit.input + audit.cancel)
    expect(audit.noStore).toBe(audit.start + audit.protected)
    await test.info().attach('dot-auth-synthetic-summary', {
      body: JSON.stringify({
        scope: 'native root-only fixture; no provider/account/vault',
        browser: 'Chrome 155 override',
        caption: 'Synthetic red/green JPEG and local input indicator, not a real account',
        state: await state(page),
        network: audit,
        consoleErrors: 0,
        expectedCancellationAborts: diagnostics.length,
      }),
      contentType: 'application/json',
    })
  })
  await finishJourneyAssertions(page)
})

When('the native synthetic status route refuses once', async ({ page }: { page: Page }) => {
  const armed = await page.evaluate(async () => (await fetch('/api/dot-auth-fixture/refusal', { method: 'POST', cache: 'no-store' })).status)
  expect(armed).toBe(204)
  await expect(surface(page).getByRole('status')).toContainText('Viewing stopped after a failure.')
  await expect.poll(() => network.get(page)?.cancel).toBe(1)
})
Then('the viewer clears private pixels and does not retry status', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'dot-auth-native-status-failure-no-retry', async () => {
    const before = network.get(page)
    if (!before) throw new Error('Missing bounded network audit.')
    const requests = { status: before.status, frame: before.frame, cancel: before.cancel }
    await page.clock.install()
    await page.clock.fastForward(10_000)
    expect({ status: before.status, frame: before.frame, cancel: before.cancel }).toEqual(requests)
    expect(await canvas(page).evaluate(e => e instanceof HTMLCanvasElement && e.width === 0 && e.height === 0)).toBe(true)
    await expect(canvas(page)).toBeHidden()
    expect(before.malformed).toBe(0)
    const diagnostics = browserDiagnosticsFor(page)
    expect(diagnostics.filter(message => message.startsWith('pageerror:'))).toEqual([])
    // Expected native refusal has its own label; never call this console-zero evidence.
    await test.info().attach('dot-auth-expected-native-refusals', {
      body: JSON.stringify({
        expectedRefusal: 'native status and subsequent cancel both reject a synthetic armed failure',
        network: before,
        diagnostics,
        state: await state(page),
      }),
      contentType: 'application/json',
    })
    await page.screenshot({ path: test.info().outputPath('dot-auth-synthetic-status-failure.png') })
  })
  await finishJourneyAssertions(page)
})
