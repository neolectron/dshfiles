import { expect, test, type Page } from '@playwright/test'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Given, Then, When } from '../bdd.js'
import { bootComposedPluginProfile } from '../boot.js'
import { finishJourneyAssertions, recordAssertion, visitIsolatedPluginProfile } from '../steps.js'
import {
  cancellationPrompt,
  followupPrompt,
  followupReply,
  initialPrompt,
  initialReply,
  readGatewayProof,
  startExternalGateway,
} from '../../fixtures/external-mcp-gateway.mjs'

const scenarios = new WeakMap<
  Page,
  {
    gateway: Awaited<ReturnType<typeof startExternalGateway>>
    root: string
    hostPid: number
    taskId?: string
    sessionId?: string
    taskUrl?: string
  }
>()
const scenarioFor = (page: Page) => {
  const value = scenarios.get(page)
  if (value === undefined) throw new Error('External MCP gateway fixture was not initialized')
  return value
}
const readTask = (page: Page) => {
  const state = scenarioFor(page)
  return state.gateway.call('dsh_read_task', { taskId: state.taskId }, state.gateway.protocol.taskResultSchema)
}

Given('the external MCP gateway and synthetic provider use an isolated native DSH runtime', async ({ page }: { page: Page }) => {
  test.setTimeout(180_000)
  const fixturePath = fileURLToPath(new URL('../../fixtures/external-mcp-gateway.mjs', import.meta.url))
  const profile = await bootComposedPluginProfile({
    packageIds: ['@dshfiles/thread-sidebar'],
    profileLabel: 'external-mcp-gateway',
    cordisPatch: `- id: agent-default-model\n  config:\n    provider: SYNTH-task-provider\n    model: SYNTH-task-model\n- insert:\n    - id: external-mcp-gateway-fixture\n      name: ${JSON.stringify(fixturePath)}\n`,
  })
  let gateway: Awaited<ReturnType<typeof startExternalGateway>> | undefined
  try {
    expect(profile.host.pid).toBeDefined()
    gateway = await startExternalGateway(profile)
    // oxlint-disable-next-line antislop/no-passthrough-variable -- Capture this narrowed owner for deferred cleanup; the outer binding remains optional for the failure path.
    const ownedGateway = gateway
    const host = profile.host
    scenarios.set(page, { gateway, root: profile.homeRoot, hostPid: profile.host.pid! })
    await visitIsolatedPluginProfile(page, {
      ...profile,
      close: async () => {
        let cleanup
        try {
          cleanup = await ownedGateway.close()
        } finally {
          await profile.close()
        }
        expect(host.exitCode !== null || host.signalCode !== null).toBe(true)
        await test.info().attach('external-mcp-owned-cleanup', {
          body: JSON.stringify({ ...cleanup, nativeHostPid: host.pid, nativeHostExited: true }),
          contentType: 'application/json',
        })
      },
    })
    expect(profile.output()).not.toMatch(/did not activate|failed to activate|provider.*NO_ADAPTER/i)
  } catch (error) {
    await Promise.allSettled([gateway?.close(), profile.close()])
    throw error
  }
})

When('an external MCP client creates and repeats one task request', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'external-mcp-real-cli-admission-and-idempotency', async () => {
    const state = scenarioFor(page),
      gateway = state.gateway
    expect((await gateway.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'dsh_cancel_task',
      'dsh_create_task',
      'dsh_health',
      'dsh_list_tasks',
      'dsh_read_task',
      'dsh_send_message',
    ])
    expect(await gateway.call('dsh_health', {}, gateway.protocol.healthResultSchema)).toEqual({
      ready: true,
      projects: ['SYNTH-project'],
      protocol: 'dsh-task-gateway-v1',
    })
    const input = { project: 'SYNTH-project', title: 'SYNTH external MCP native task', prompt: initialPrompt, idempotencyKey: 'SYNTH-create-001' }
    const created = await gateway.call('dsh_create_task', input, gateway.protocol.taskResultSchema)
    await test.info().attach('external-mcp-create-admission', { body: JSON.stringify(created), contentType: 'application/json' })
    expect(created.admission, JSON.stringify({ state: created.state, admission: created.admission, sessionId: created.sessionId, error: created.error })).toBe(
      'accepted',
    )
    expect(created.state).toBe('accepted')
    expect(created.sessionId).toBeTruthy()
    expect(created.url).toBeTruthy()
    state.taskId = created.taskId
    state.sessionId = created.sessionId
    state.taskUrl = created.url
    const repeated = await gateway.call('dsh_create_task', input, gateway.protocol.taskResultSchema)
    expect(repeated.taskId).toBe(created.taskId)
    expect(repeated.sessionId).toBe(created.sessionId)
    await expect.poll(async () => (await readTask(page)).state, { timeout: 20_000 }).toBe('running')
    const nativeRows = await gateway.native.sessions.list([])
    expect(nativeRows.filter(row => row.cwd === gateway.projectPath)).toHaveLength(1)
    await expect.poll(async () => (await readGatewayProof(state.root)).calls.filter(call => call.kind === 'initial').length).toBe(1)
    await gateway.releaseInitial()
    await expect.poll(async () => (await readTask(page)).state, { timeout: 20_000 }).toBe('completed')
    expect((await readTask(page)).text).toBe(initialReply)
  })
})

Then('the real DSH page shows the native task result', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'external-mcp-native-ui-result', async () => {
    const state = scenarioFor(page)
    if (state.taskUrl === undefined) throw new Error('Gateway returned no native task URL')
    await page.goto(state.taskUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText(initialReply, { exact: true })).toBeVisible({ timeout: 20_000 })
    const screenshot = test.info().outputPath('external-mcp-native-task.png')
    await page.screenshot({ path: screenshot })
    await test.info().attach('external-mcp-native-task', { path: screenshot, contentType: 'image/png' })
  })
})

When('the external MCP client follows up and tests principal boundaries', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'external-mcp-followup-and-scope-boundary', async () => {
    const state = scenarioFor(page),
      gateway = state.gateway
    const sent = await gateway.call(
      'dsh_send_message',
      { taskId: state.taskId, prompt: followupPrompt, idempotencyKey: 'SYNTH-followup-001' },
      gateway.protocol.taskResultSchema,
    )
    expect(sent.admission).toBe('accepted')
    await expect.poll(async () => (await readTask(page)).text, { timeout: 20_000 }).toBe(followupReply)
    await expect.poll(async () => (await readTask(page)).state).toBe('completed')
    await expect(page.getByText(followupReply, { exact: true })).toBeVisible()
    const listing = await gateway.call('dsh_list_tasks', {}, gateway.protocol.listResultSchema)
    expect(listing.tasks.map(task => task.taskId)).toEqual([state.taskId])
    expect(listing.nextCursor).toBeNull()
    const otherList = await gateway.other.callTool({ name: 'dsh_list_tasks', arguments: {} })
    expect(gateway.protocol.listResultSchema.parse(otherList.structuredContent).result.tasks).toEqual([])
    const refused = await gateway.other.callTool({ name: 'dsh_read_task', arguments: { taskId: state.taskId } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).not.toContain(state.sessionId)
    await expect(gateway.wrongKey()).rejects.toThrow()
  })
})

When('the external MCP client cancels a blocked native turn', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'external-mcp-native-aborted-not-acknowledgement', async () => {
    const state = scenarioFor(page),
      gateway = state.gateway
    await gateway.call(
      'dsh_send_message',
      { taskId: state.taskId, prompt: cancellationPrompt, idempotencyKey: 'SYNTH-hold-001' },
      gateway.protocol.taskResultSchema,
    )
    await expect.poll(async () => (await readTask(page)).state, { timeout: 20_000 }).toBe('running')
    await expect.poll(async () => (await readGatewayProof(state.root)).calls.filter(call => call.kind === 'cancel').length).toBe(1)
    const requested = await gateway.call('dsh_cancel_task', { taskId: state.taskId, idempotencyKey: 'SYNTH-cancel-001' }, gateway.protocol.taskResultSchema)
    expect(requested.state).toBe('cancellation-requested')
    await expect.poll(async () => (await readTask(page)).state, { timeout: 20_000 }).toBe('cancelled')
    const proof = await readGatewayProof(state.root)
    expect(proof.ends.filter(end => end.sessionId === state.sessionId).map(end => end.kind)).toEqual(['completed', 'completed', 'aborted'])
    const nativeRows = await gateway.native.sessions.list(['inbox'])
    expect(nativeRows.find(row => row.sessionId === state.sessionId)).toMatchObject({ running: false, pendingMessages: 0 })
  })
})

Then('the gateway and native Session evidence agree without exposing private bytes', async ({ page }: { page: Page }) => {
  await recordAssertion(page, 'external-mcp-single-native-owner-and-redaction', async () => {
    const state = scenarioFor(page),
      gateway = state.gateway
    const proof = await readGatewayProof(state.root)
    expect(proof.calls.map(call => call.kind)).toEqual(['initial', 'followup', 'cancel'])
    expect(new Set(proof.calls.map(call => call.sessionId))).toEqual(new Set([state.sessionId]))
    const snapshot = await readTask(page)
    expect(snapshot).toMatchObject({ sessionId: state.sessionId, state: 'cancelled' })
    expect(snapshot.sequence).toBeGreaterThan(0)
    expect(gateway.containsPrivate(JSON.stringify(snapshot))).toBe(false)
    expect(gateway.containsPrivate(await page.content())).toBe(false)
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(gateway.containsPrivate(storage)).toBe(false)
    await test.info().attach('external-mcp-native-lifecycle-proof', {
      body: JSON.stringify({ calls: proof.calls, ends: proof.ends, final: snapshot, providerBoundaryOnly: true }),
      contentType: 'application/json',
    })
  })
  await finishJourneyAssertions(page)
})

Then('all external MCP gateway fixture resources are gone', async ({ page }: { page: Page }) => {
  const state = scenarioFor(page)
  await expect(access(state.root)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(() => process.kill(state.hostPid, 0)).toThrow()
  expect(state.gateway.child.exitCode).toBe(0)
  scenarios.delete(page)
})
