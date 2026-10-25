// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createBotAdapterRegistry } from '@dshfiles/bots/adapter'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createDotAccountAuthorityHandler, type DotAccountAuthorityHandler, type DotAccountAuthorityHandlerOptions } from '../src/account-authority-server.js'
import { DotAccountAuthorityProtocol as protocol } from '../src/account-authority-contract.js'
import { dotHostConfigSchema } from '../src/host-config.js'
import host from '../src/host.js'

const key = 'SYNTHETIC_AUTHORITY_KEY_SEPARATE_FROM_CONTROL_12345'
const token = 'SYNTHETIC_UPSTREAM_ACCESS_FOR_PRIVATE_BACKEND_ONLY'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(overrides: Partial<DotAccountAuthorityHandlerOptions> = {}) {
  let authority: DotAccountAuthorityHandler | undefined
  let keys = 0
  let accesses = 0
  const server = createServer((req, res) => {
    if (authority === undefined) {
      res.writeHead(503)
      res.end()
      return
    }
    void authority.handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = z.object({ port: z.number().int().positive() }).parse(server.address())
  const origin = `http://127.0.0.1:${address.port}`
  authority = createDotAccountAuthorityHandler({
    expectedOrigin: origin,
    accountIds: ['selected'],
    acceptRisks: true,
    resolveBearerToken: async () => {
      keys++
      return key
    },
    accountAccess: {
      readAccessToken: async () => {
        accesses++
        return token
      },
    },
    ...overrides,
  })
  cleanup.push(async () => {
    authority?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  })
  const send = (headers: HeadersInit = {}, body = JSON.stringify({ accountId: 'selected' }), path: string = protocol.path, method = 'POST') => {
    const request: RequestInit = { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, ...headers }, redirect: 'error' }
    if (method !== 'GET') request.body = body
    return fetch(`${origin}${path}`, request)
  }
  return { origin, authority, send, keys: () => keys, accesses: () => accesses }
}

it('delivers selected access only to the independent purpose-bearer channel, never native cookie admission', async () => {
  const test = await fixture()
  const allowed = await test.send()
  expect(allowed.status).toBe(200)
  expect(allowed.headers.get('cache-control')).toBe('no-store')
  expect(await allowed.json()).toEqual({ version: 1, accountId: 'selected', accessToken: token })
  expect(test.accesses()).toBe(1)
  for (const headers of [
    { Authorization: '' },
    { Cookie: 'SYNTHETIC_NATIVE_OWNER_COOKIE' },
    { Origin: test.origin },
    { Referer: test.origin },
    { 'Sec-Fetch-Site': 'same-origin' },
    { 'X-Forwarded-Proto': 'https' },
  ]) {
    const response = await test.send(headers)
    expect([401, 403]).toContain(response.status)
    const text = await response.text()
    expect(text.includes(key) || text.includes(token)).toBe(false)
  }
  expect(test.accesses()).toBe(1)
  expect(test.keys()).toBe(1)
})

it('refuses a different account, method, host, path, content type and oversized input before owner access', async () => {
  const test = await fixture()
  // Node fetch ignores a caller's Host override; send the actual hostile wire header with node:http.
  const wrongHost = new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      `${test.origin}${protocol.path}`,
      { method: 'POST', headers: { Host: 'not-the-pinned-authority.invalid', Authorization: `Bearer ${key}`, 'content-type': 'application/json' } },
      response => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 500 })))
      },
    )
    request.on('error', reject)
    request.setTimeout(1500, () => request.destroy(new Error('Synthetic hostile Host fixture timed out')))
    request.end(JSON.stringify({ accountId: 'selected' }))
  })
  const requests = [
    test.send({}, JSON.stringify({ accountId: 'other' })),
    test.send({}, '', protocol.path, 'GET'),
    wrongHost,
    test.send({}, '{}', `${protocol.path}?probe=1`),
    test.send({ 'content-type': 'text/plain' }),
    test.send({}, 'x'.repeat(2049)),
    test.send({ Authorization: `Bearer ${'WRONG_SYNTHETIC_KEY'.repeat(3)}` }),
  ]
  for (const [index, response] of (await Promise.all(requests)).entries()) {
    expect(response.status, `Refusal case ${index}`).toBeGreaterThanOrEqual(400)
    expect((await response.text()).includes(token)).toBe(false)
  }
  expect(test.accesses()).toBe(0)
})

it('sanitizes credential-owner and bearer-resolver failures without uncaught handler causes', async () => {
  const first = await fixture({
    accountAccess: {
      readAccessToken: async () => {
        throw new Error('SYNTHETIC_PRIVATE_OWNER_CAUSE')
      },
    },
  })
  const response = await first.send()
  expect(response.status).toBe(503)
  expect((await response.text()).includes('SYNTHETIC_PRIVATE')).toBe(false)
  const second = await fixture({
    resolveBearerToken: async () => {
      throw new Error('SYNTHETIC_PRIVATE_KEY_CAUSE')
    },
  })
  const rejected = await second.send()
  expect(rejected.status).toBe(503)
  expect((await rejected.text()).includes('SYNTHETIC_PRIVATE')).toBe(false)
})

it('close cancels an uncooperative authority read and a late token cannot write a response', async () => {
  let entered: () => void = () => undefined
  let release: (value: string) => void = () => undefined
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const test = await fixture({
    accountAccess: {
      readAccessToken: async () => {
        entered()
        return new Promise(resolve => {
          release = resolve
        })
      },
    },
  })
  const request = test.send()
  await started
  test.authority.close()
  const response = await request
  expect(response.status).toBe(408)
  expect((await response.text()).includes(token)).toBe(false)
  release(token)
  await Promise.resolve()
  const closed = await test.send()
  expect(closed.status).toBe(503)
})

it('requires explicit nonduplicate admission and canonical secure backend origins', () => {
  const base = {
    expectedOrigin: 'http://127.0.0.1:3199',
    accountIds: ['selected'],
    acceptRisks: true as const,
    resolveBearerToken: async () => key,
    accountAccess: { readAccessToken: async () => token },
  }
  for (const origin of [
    'http://192.168.1.94:3198',
    'http://localhost:3198',
    'http://2130706433:3198',
    'https://example.invalid/path',
    'https://example.invalid?key=hidden',
    'https://user:pass@example.invalid',
  ])
    expect(() => createDotAccountAuthorityHandler({ ...base, expectedOrigin: origin })).toThrow()
  expect(() => createDotAccountAuthorityHandler({ ...base, accountIds: [] })).toThrow()
  expect(() => createDotAccountAuthorityHandler({ ...base, accountIds: ['selected', 'selected'] })).toThrow()
  expect(dotHostConfigSchema.parse(undefined).mode).toBe('references')
  expect(dotHostConfigSchema.safeParse({ accountIds: ['selected'] }).success).toBe(false)
  expect(dotHostConfigSchema.safeParse({ mode: 'account', accountIds: ['selected'], authorityOrigin: base.expectedOrigin }).success).toBe(false)
})

it('registers on the actual native WebServer public route and unload removes it without an account read', async () => {
  const ctx = new Context()
  cleanup.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.get('webServer')
  if (server === undefined) throw new Error('Expected real native WebServer')
  const registry = createBotAdapterRegistry()
  ctx.provide('botAdapters', registry)
  let keyReads = 0
  ctx.provide('secretCatalogValues', {
    resolve: async () => {
      keyReads++
      return key
    },
  })
  const fork = ctx.plugin(
    { name: host.name, inject: [...host.inject], Config: host.Config, apply: host.setup },
    dotHostConfigSchema.parse({
      mode: 'account',
      accountIds: ['SYNTHETIC_NO_LIVE_ACCOUNT'],
      acceptAccountRisks: true,
      authorityOrigin: server.getOrigin(),
      authorityTokenReference: 'secret:SYNTH_AUTHORITY',
    }),
  )
  await fork
  expect(registry.get('openai-dot')?.info.fields.map(field => field.key)).toEqual(['accountId'])
  expect(registry.get('openai-dot')?.info.credentialManagement).toBeUndefined()
  const url = `${server.getOrigin()}${protocol.path}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'UNADMITTED_SYNTHETIC' }),
  })
  expect(response.status).toBe(403)
  expect(keyReads).toBe(1)
  await response.text()
  await fork.dispose()
  expect(registry.list()).toEqual([])
  const removed = await fetch(url, { method: 'POST', body: '{}' })
  expect(removed.status).toBe(404)
  await removed.text()
})
