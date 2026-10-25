// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startBotsNodeService } from '@dshfiles/bots/node'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { AuthAttemptError, AuthAttemptManager } from '../src/auth-attempt.js'
import { createDotEnrollmentEndpoints } from '../src/enrollment-server.js'
import { createDotEnrollmentProxy } from '../src/enrollment-proxy.js'
import { startDotAccountAuthorityListener } from '../src/account-authority-listener.js'
import { createDotAccountAuthorityHandler } from '../src/account-authority-server.js'
import { createDotAccountAuthorityClient } from '../src/account-authority-client.js'
import { DotAccountAuthorityProtocol } from '../src/account-authority-contract.js'
import { dotHostConfigSchema } from '../src/host-config.js'

const key = 'SYNTH-private-enrollment-service-credential'
const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  let failed = false
  for (const close of resources.splice(0).reverse()) {
    try {
      await close()
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('Synthetic enrollment cleanup was not confirmed.')
})
const fixture = async (wrongKey = false) => {
  const root = await mkdtemp(join(tmpdir(), 'dot-enrollment-http-'))
  resources.push(async () => {
    expect(await realpath(root)).toBe(root)
    expect(dirname(root)).toBe(await realpath(tmpdir()))
    expect(basename(root).startsWith('dot-enrollment-http-')).toBe(true)
    await rm(root, { recursive: true })
  })
  let opens = 0,
    inputs = 0,
    closes = 0,
    completions = 0,
    keyReads = 0
  const manager = new AuthAttemptManager({
    open: async () => {
      opens++
      return {
        frame: async () => ({ bytes: new Uint8Array([255, 216, 255, 0, 255, 217]), width: 4, height: 3 }),
        input: async () => {
          inputs++
        },
        close: async () => {
          closes++
        },
      }
    },
    onComplete: async () => {
      completions++
    },
  })
  resources.push(() => manager.close())
  const service = await startBotsNodeService({
    storageRoot: join(root, 'data'),
    bearerToken: key,
    registry: createBotAdapterRegistry(),
    privateEndpoints: createDotEnrollmentEndpoints(manager),
  })
  resources.push(service.close)
  const proxy = createDotEnrollmentProxy({
    origin: service.origin,
    resolveBearerToken: async () => {
      keyReads++
      return wrongKey ? 'SYNTH-wrong-service-credential-still-long' : key
    },
  })
  resources.push(() => proxy.close())
  return { proxy, service, counts: () => ({ opens, inputs, closes, completions, keyReads }) }
}

it('carries one private human attempt over authenticated real HTTP and retires it on explicit completion', async () => {
  const test = await fixture()
  const start = await test.proxy.start({ acceptRisks: true })
  expect((await test.proxy.status(start.capability)).state).toBe('ready')
  const frame = await test.proxy.frame(start.capability)
  expect(frame).toEqual({ bytes: new Uint8Array([255, 216, 255, 0, 255, 217]), width: 4, height: 3 })
  await test.proxy.input(start.capability, { attemptId: start.attempt.id, sequence: 1, input: { kind: 'text', text: 'SYNTH-only-input' } })
  const finished = await test.proxy.complete(start.capability, { attemptId: start.attempt.id, sequence: 2 })
  expect(finished.state).toBe('completed')
  expect(test.counts()).toMatchObject({ opens: 1, inputs: 1, closes: 1, completions: 1 })
  await expect(test.proxy.status(start.capability)).rejects.toMatchObject({ code: 'forbidden' })
  const snapshot = await fetch(`${test.service.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${key}` } })
  const publicText = await snapshot.text()
  expect(publicText.includes(start.capability)).toBe(false)
  expect(publicText).not.toContain('SYNTH-only-input')
})

it('rejects wrong capabilities and mismatched attempt IDs locally, then cancels and permits an explicit fresh attempt', async () => {
  const test = await fixture()
  const start = await test.proxy.start({ acceptRisks: true })
  const reads = test.counts().keyReads
  await expect(test.proxy.status('x'.repeat(43))).rejects.toBeInstanceOf(AuthAttemptError)
  await expect(
    test.proxy.input(start.capability, { attemptId: randomUUID(), sequence: 1, input: { kind: 'text', text: 'SYNTH-rejected' } }),
  ).rejects.toMatchObject({ code: 'invalid-request' })
  expect(test.counts().keyReads).toBe(reads)
  expect((await test.proxy.cancel(start.capability)).state).toBe('closed')
  const next = await test.proxy.start({ acceptRisks: true })
  expect(next.attempt.id).not.toBe(start.attempt.id)
  await test.proxy.close()
  expect(test.counts()).toMatchObject({ opens: 2, closes: 2, inputs: 0, completions: 0 })
})

it('never opens the browser on an unadmitted control credential', async () => {
  const test = await fixture(true)
  await expect(test.proxy.start({ acceptRisks: true })).rejects.toMatchObject({ code: 'failed' })
  expect(test.counts().opens).toBe(0)
})

it.each(['http://service.invalid', 'https://service.invalid/path', 'https://user:password@service.invalid', 'http://127.0.0.1:8787/?credential=SYNTH'])(
  'rejects nonprivate or noncanonical enrollment origin before resolving credentials: %s',
  origin => {
    let reads = 0
    expect(() =>
      createDotEnrollmentProxy({
        origin,
        resolveBearerToken: async () => {
          reads++
          return key
        },
      }),
    ).toThrow()
    expect(reads).toBe(0)
  },
)

it('uses a real owned loopback socket for account authority instead of trusting forwarded LAN headers', async () => {
  let accountReads = 0
  const listener = await startDotAccountAuthorityListener({
    origin: 'http://127.0.0.1:0',
    createHandler: actualOrigin =>
      createDotAccountAuthorityHandler({
        expectedOrigin: actualOrigin,
        accountIds: ['SYNTH-selected'],
        acceptRisks: true,
        resolveBearerToken: async () => key,
        accountAccess: {
          readAccessToken: async () => {
            accountReads++
            return 'SYNTH-only-account-access'
          },
        },
      }),
  })
  resources.push(listener.close)
  const client = createDotAccountAuthorityClient({ origin: listener.origin, resolveBearerToken: async () => key })
  resources.push(() => Promise.resolve(client.close()))
  expect(await client.readAccessToken('SYNTH-selected', AbortSignal.timeout(2000))).toBe('SYNTH-only-account-access')
  expect(accountReads).toBe(1)
  const fromBrowser = await fetch(`${listener.origin}${DotAccountAuthorityProtocol.path}`, {
    method: 'POST',
    headers: { origin: listener.origin, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{"accountId":"SYNTH-selected"}',
  })
  expect(fromBrowser.status).toBe(403)
  await fromBrowser.text()
  expect(accountReads).toBe(1)
  await listener.close()
  await expect(fetch(`${listener.origin}/`)).rejects.toThrow()
})

it.each(['http://192.168.1.1:8788', 'https://127.0.0.1:8788', 'http://127.0.0.1'])('refuses a non-explicit plain loopback listener: %s', async origin => {
  await expect(
    startDotAccountAuthorityListener({
      origin,
      createHandler: () => {
        throw new Error('Must not construct authority')
      },
    }),
  ).rejects.toThrow()
})

it('requires secure human enrollment origin and complete explicit account-mode configuration', () => {
  const base = {
    mode: 'account',
    accountIds: ['SYNTH-selected'],
    acceptAccountRisks: true,
    authorityOrigin: 'http://127.0.0.1:8788',
    authorityTransport: 'loopback',
    enrollmentServiceOrigin: 'http://127.0.0.1:8787',
    browserOrigin: 'http://localhost:3198',
  }
  expect(dotHostConfigSchema.safeParse(base).success).toBe(true)
  expect(dotHostConfigSchema.safeParse({ ...base, browserOrigin: 'http://192.168.1.94:3198' }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ ...base, authorityOrigin: 'http://192.168.1.94:3198' }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ ...base, authorityOrigin: 'http://127.0.0.1:0' }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ ...base, enrollmentServiceOrigin: '' }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ ...base, additionalBrowserOrigins: [base.browserOrigin] }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ ...base, mode: 'references' }).success).toBe(false)
})
