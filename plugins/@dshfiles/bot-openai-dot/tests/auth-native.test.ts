// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as nativeConnection from '@deepseek-ai/dsh-client-connection'
import type { ConnectionIndexResponse, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { JsonText } from '@dshfiles/dshx/api'
import { afterEach, expect, it } from 'vitest'
import { AuthAttemptManager } from '../src/auth-attempt.js'
import { authStartResultSchema, dotAuthCapabilityHeader, dotAuthRoutes } from '../src/auth-protocol.js'
import { registerDotAuthRoutes } from '../src/auth-transport.js'

// SYNTHETIC integration: installed DSH 0.2.1-rc.2 apply owns BrowserAuth,
// signed cookies, Host/Origin admission, Peer identities and exact Fetch routes.
// Only the page I/O/JPEG and index-response sink are synthetic. No HTTP listener,
// provider, browser launch, account, vault, existing profile or live GUI is used.
// The physical node:http bridge and actual provider sign-in are NOT proved here.
// Stock PrincipalMap supplies only owner; no non-owner business driver is loaded.
// Non-owner-principal dispatch is unverified, not fabricated by a cast/augmentation.
const origin = 'http://127.0.0.1:3199'
const host = new URL(origin).host
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(completion: 'ready' | 'fail' | undefined = undefined) {
  const root = await realpath(tmpdir())
  const home = await mkdtemp(join(root, 'dot-auth-native-'))
  const ctx = new Context()
  let disposeRoutes: (() => Promise<void>) | undefined
  cleanups.push(async () => {
    let failed = false
    const steps = [
      async () => {
        await disposeRoutes?.()
      },
      () => ctx.fiber.dispose(),
      async () => {
        // Verify the exact owned absolute directory before recursive deletion.
        if (!isAbsolute(home) || dirname(home) !== root || !basename(home).startsWith('dot-auth-native-') || (await realpath(home)) !== home)
          throw new Error('Refusing unsafe synthetic-store cleanup.')
        await rm(home, { recursive: true })
      },
    ]
    for (const step of steps) {
      try {
        await step()
      } catch {
        failed = true
      }
    }
    // All steps run in order; no finally failure masks another or leaks raw errors.
    if (failed) throw new Error('Synthetic authentication fixture cleanup failed.')
  })
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  await ctx.plugin(nativeConnection)
  const connection = ctx.get('connection')
  if (!(connection instanceof nativeConnection.HostConnectionService)) throw new Error('Native Connection did not activate.')
  expect((await ctx.credentials.listRecords()).length).toBe(1)

  const canary = randomBytes(24).toString('hex')
  const privateValues = [canary]
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(canary), 0xff, 0xd9])
  let opens = 0
  let inputs = 0
  let closes = 0
  let completions = 0
  let failFrame = false
  const onComplete = async (signal: AbortSignal) => {
    if (completion === 'fail' || signal.aborted) throw new Error(canary)
    completions++
  }
  const open = async () => {
    opens++
    return {
      frame: async () => {
        if (failFrame) throw new Error(canary)
        return { bytes: jpeg, width: 640, height: 480 }
      },
      input: async () => {
        inputs++
      },
      close: async () => {
        closes++
      },
    }
  }
  const manager = new AuthAttemptManager(completion ? { open, onComplete } : { open })
  disposeRoutes = registerDotAuthRoutes(connection, manager, { browserOrigin: origin })
  const handler = connection.createSharedFetchHandler('/api')
  function noEcho(raw: string) {
    // Boolean assertions deliberately keep secret/canary values out of failure diffs.
    expect(privateValues.some(value => raw.includes(value))).toBe(false)
  }
  async function clean(response: Response, status: number) {
    expect(response.status).toBe(status)
    noEcho(await response.text())
    noEcho(JSON.stringify([...response.headers]))
  }
  const exchange = (api = false) => {
    const url = connection.authenticatedUrl(`${origin}${api ? '/connect' : '/'}`)
    privateValues.push(url, new URL(url).searchParams.get('token') ?? url)
    let status = 0
    let headers: Readonly<Record<string, string>> = {}
    let ended = false
    const response: ConnectionIndexResponse = {
      writeHead(code, values) {
        status = code
        headers = values ?? {}
      },
      end() {
        ended = true
      },
    }
    const request = { method: 'GET', url, headers: { host } }
    if (api) connection.authorizeConnect(request, response)
    else expect(connection.authorizeIndex(request, response)).toBe(false)
    expect(status).toBe(api ? 302 : 303)
    expect(ended).toBe(true)
    const cookie = headers['set-cookie']?.split(';')[0]
    if (!cookie || !cookie.includes('=')) throw new Error('Native exchange did not mint a cookie.')
    privateValues.push(cookie, cookie.slice(cookie.indexOf('=') + 1))
    return cookie
  }
  const send = (
    operation: keyof typeof dotAuthRoutes,
    options: {
      cookie?: string
      cap?: string
      body?: string | ReadableStream<Uint8Array> | undefined
      origin?: string | null
      host?: string
      peer?: PeerScope
      headers?: Record<string, string>
    } = {},
  ) => {
    // Native node:http presents streaming routes with a Request body, which GET
    // forbids. Every private operation therefore uses POST, JSON and CSRF Origin.
    const method = 'POST'
    const headers = new Headers({ host: options.host ?? host, 'content-type': 'application/json', ...options.headers })
    if (options.origin !== null) headers.set('origin', options.origin ?? origin)
    if (options.cookie !== undefined) headers.set('cookie', options.cookie)
    if (options.cap !== undefined) headers.set(dotAuthCapabilityHeader, options.cap)
    const init = { method, headers, body: options.body ?? '{}', duplex: 'half' }
    const request = new Request(`http://dsh.internal${dotAuthRoutes[operation]}`, init)
    expect(handler.requestBodyMode({ method, url: new URL(request.url) })).toBe('streaming')
    expect(handler.requestBodyMode({ method: 'GET', url: new URL(request.url) })).toBe('buffered')
    // Public exact-route seam, not an invented carrier: the route itself calls
    // the unmodified native connection.admit(request), including cookie checks.
    return handler.fetch(request, options.peer ?? connection.browserPeer)
  }
  const cookie = exchange()
  async function start(body = '{"acceptRisks":true}') {
    const response = await send('start', { cookie, body })
    expect(response.status).toBe(200)
    const raw = await response.text()
    noEcho(raw)
    const result = JsonText.parse(raw, authStartResultSchema)
    privateValues.push(result.capability)
    noEcho(JSON.stringify([...response.headers]))
    return result
  }
  return {
    connection,
    handler,
    cookie,
    canary,
    jpeg,
    send,
    start,
    clean,
    exchange,
    noEcho,
    counts: () => ({ opens, inputs, closes, completions }),
    failFrame: () => {
      failFrame = true
    },
  }
}

it('uses native signed browser authentication, not cookie names or owner principal equivalence', async () => {
  const f = await fixture()
  const body = '{"acceptRisks":true}'
  const name = f.cookie.slice(0, f.cookie.indexOf('='))
  for (const cookie of [undefined, `forged-name=${f.cookie.slice(name.length + 1)}`, `${name}=invalid`, 'dsh-session=forged; dsh-browser=forged']) {
    const options: Parameters<typeof f.send>[1] = { body }
    if (cookie !== undefined) options.cookie = cookie
    await f.clean(await f.send('start', options), 401)
  }
  for (const options of [
    { origin: null },
    { origin: 'https://evil.invalid' },
    { host: 'evil.invalid' },
    { host: 'localhost:3199' },
    { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) {
    await f.clean(await f.send('start', { cookie: f.cookie, body, ...options }), 403)
  }
  const apiCookie = f.exchange(true)
  const admission = f.connection.admit({ headers: new Headers({ host, cookie: apiCookie, origin }) })
  expect('peer' in admission).toBe(true)
  if (!('peer' in admission)) throw new Error('Native API exchange was not admitted.')
  expect(admission.peer.principal.kind).toBe('owner')
  expect(admission.peer === f.connection.browserPeer).toBe(false)
  await f.clean(await f.send('start', { cookie: apiCookie, body, peer: admission.peer }), 403)
  expect(f.counts().opens).toBe(0)

  const first = await f.start()
  const cap = first.capability
  for (const operation of ['status', 'frame', 'input', 'cancel', 'complete'] as const) {
    await f.clean(await f.send(operation, { cap }), 401)
    await f.clean(await f.send(operation, { cookie: apiCookie, cap, peer: admission.peer }), 403)
    await f.clean(await f.send(operation, { cookie: f.cookie, cap, origin: 'https://evil.invalid' }), 403)
    await f.clean(await f.send(operation, { cookie: f.cookie, cap, origin: null }), 403)
    await f.clean(await f.send(operation, { cookie: f.cookie }), 403)
    await f.clean(await f.send(operation, { cookie: f.cookie, cap: randomBytes(32).toString('base64url') }), 403)
  }
  await f.clean(await f.send('status', { cookie: f.cookie, cap }), 200)
  const frame = await f.send('frame', { cookie: f.cookie, cap })
  expect(frame.status).toBe(200)
  expect(frame.headers.get('content-type')).toBe('image/jpeg')
  expect(frame.headers.get('cache-control')).toBe('no-store')
  f.noEcho(JSON.stringify([...frame.headers]))
  expect(Buffer.from(await frame.arrayBuffer()).equals(Buffer.from(f.jpeg))).toBe(true)
  await f.clean(
    await f.send('input', {
      cookie: f.cookie,
      cap,
      body: JSON.stringify({ attemptId: first.attempt.id, sequence: 1, input: { kind: 'text', text: f.canary } }),
    }),
    200,
  )
  expect(f.counts().inputs).toBe(1)
  await f.clean(await f.send('cancel', { cookie: f.cookie, cap, body: '{}' }), 200)
  expect(f.counts().closes).toBe(1)
  const second = await f.start()
  await f.clean(
    await f.send('input', {
      cookie: f.cookie,
      cap: second.capability,
      body: JSON.stringify({ attemptId: first.attempt.id, sequence: 1, input: { kind: 'text', text: f.canary } }),
    }),
    409,
  )
  for (const operation of ['status', 'frame', 'input', 'cancel', 'complete'] as const) {
    await f.clean(await f.send(operation, { cookie: f.cookie, cap }), 403)
  }
  f.failFrame()
  await f.clean(await f.send('frame', { cookie: f.cookie, cap: second.capability }), 502)
})

it('enforces the 8KiB streamed body ceiling under genuine native browser admission without echo', async () => {
  const f = await fixture()
  let cancelled = false
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(4096))
    },
    cancel() {
      cancelled = true
    },
  })
  await f.clean(await f.send('start', { cookie: f.cookie, body, headers: { 'content-length': '1' } }), 400)
  expect(cancelled).toBe(true)
  expect(pulls <= 4).toBe(true)
  for (const options of [
    { body: ' '.repeat(8193) },
    { body: '{"acceptRisks":true}', headers: { 'content-length': '8193' } },
    { body: f.canary },
    { body: JSON.stringify({ acceptRisks: true, extra: f.canary }) },
  ])
    await f.clean(await f.send('start', { cookie: f.cookie, ...options }), 400)
  expect(f.counts().opens).toBe(0)
  const json = '{"acceptRisks":true}'
  const result = await f.start(json.padEnd(8192, ' '))
  expect(f.counts().opens).toBe(1)
  await f.clean(await f.send('cancel', { cookie: f.cookie, cap: result.capability, body: '{}' }), 200)
})

it('accepts explicit complete under real native browser admission, rejects origin/Peer bypass and retires capability', async () => {
  const f = await fixture('ready'),
    start = await f.start(),
    cap = start.capability
  const body = JSON.stringify({ attemptId: start.attempt.id, sequence: 1 })
  for (const options of [
    { origin: null },
    { origin: 'http://localhost:3199' },
    { host: 'localhost:3199' },
    { host: 'evil.invalid' },
    { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) {
    await f.clean(await f.send('complete', { cookie: f.cookie, cap, body, ...options }), 403)
  }
  await f.clean(await f.send('complete', { cap, body }), 401)
  const apiCookie = f.exchange(true)
  const admission = f.connection.admit({ headers: new Headers({ host, cookie: apiCookie, origin }) })
  if (!('peer' in admission)) throw new Error('Native API exchange was not admitted.')
  await f.clean(await f.send('complete', { cookie: apiCookie, cap, body, peer: admission.peer }), 403)
  expect(f.counts().completions).toBe(0)
  const response = await f.send('complete', { cookie: f.cookie, cap, body })
  expect(response.status).toBe(200)
  const raw = await response.text()
  f.noEcho(raw)
  expect(raw).toContain('"state":"completed"')
  expect(f.counts()).toMatchObject({ opens: 1, closes: 1, completions: 1 })
  for (const operation of ['status', 'frame', 'input', 'complete', 'cancel'] as const) {
    await f.clean(await f.send(operation, { cookie: f.cookie, cap }), 403)
  }
})

it('sanitizes complete owner failure under real native admission without credentials or false acknowledgment', async () => {
  const f = await fixture('fail'),
    start = await f.start()
  await f.clean(await f.send('complete', { cookie: f.cookie, cap: start.capability, body: JSON.stringify({ attemptId: start.attempt.id, sequence: 1 }) }), 502)
  await f.clean(await f.send('status', { cookie: f.cookie, cap: start.capability }), 403)
  expect(f.counts()).toMatchObject({ completions: 0, closes: 1 })
})
