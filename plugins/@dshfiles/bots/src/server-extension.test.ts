import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { createBotAdapterRegistry } from './adapter.js'
import { startBotsNodeService } from './node.js'
import type { BotsPrivateEndpoint } from './server.js'

const bearer = 'SYNTH-private-endpoint-control-credential'
const route = '/v1/extensions/synthetic/enrollment'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const parent = async () => {
  const root = await mkdtemp(join(tmpdir(), 'bots-private-http-'))
  cleanups.push(async () => {
    expect(await realpath(root)).toBe(root)
    expect(dirname(root)).toBe(await realpath(tmpdir()))
    expect(basename(root).startsWith('bots-private-http-')).toBe(true)
    await rm(root, { recursive: true })
  })
  return root
}
const fixture = async (privateEndpoints: readonly BotsPrivateEndpoint[]) => {
  const root = await parent()
  const service = await startBotsNodeService({ storageRoot: join(root, 'data'), bearerToken: bearer, registry: createBotAdapterRegistry(), privateEndpoints })
  cleanups.push(service.close)
  const call = (path = route, headers: HeadersInit = {}, body = '{}') =>
    fetch(`${service.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
      body,
    })
  return { service, call }
}
const failure = z.object({ error: z.literal('internal') }).strict()

it('authenticates exact private endpoints before callbacks and never puts them in domain snapshots', async () => {
  let calls = 0
  const service = await fixture([
    {
      path: route,
      method: 'POST',
      handle: async () => {
        calls++
        return Response.json({ private: 'SYNTH-controller-only' })
      },
    },
  ])
  expect((await service.call(route, { authorization: 'Bearer SYNTH-wrong-key' })).status).toBe(401)
  expect((await service.call(route, { origin: service.service.origin })).status).toBe(400)
  expect((await service.call(`${route}/unknown`)).status).toBe(404)
  expect((await fetch(`${service.service.origin}${route}`, { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(405)
  expect(calls).toBe(0)
  const accepted = await service.call()
  expect(accepted.status).toBe(200)
  expect(await accepted.text()).toBe('{"private":"SYNTH-controller-only"}')
  expect(calls).toBe(1)
  const snapshot = await fetch(`${service.service.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${bearer}` } })
  expect(await snapshot.text()).not.toContain('SYNTH-controller-only')
})

it('forwards only declared private headers, not the service bearer or ambient browser authority', async () => {
  const bodySchema = z.object({ action: z.literal('SYNTH') }).strict()
  const resultSchema = z
    .object({ auth: z.null(), cookie: z.null(), host: z.null(), referer: z.null(), controller: z.literal('SYNTH-controller'), action: z.literal('SYNTH') })
    .strict()
  const service = await fixture([
    {
      path: route,
      method: 'POST',
      requestHeaders: ['x-synthetic-controller'],
      handle: async request => {
        const input = JsonText.parse(await request.text(), bodySchema)
        return Response.json({
          auth: request.headers.get('authorization'),
          cookie: request.headers.get('cookie'),
          host: request.headers.get('host'),
          referer: request.headers.get('referer'),
          controller: request.headers.get('x-synthetic-controller'),
          action: input.action,
        })
      },
    },
  ])
  const response = await service.call(
    route,
    { cookie: 'SYNTH-cookie', referer: 'http://synthetic.invalid/', 'x-synthetic-controller': 'SYNTH-controller' },
    '{"action":"SYNTH"}',
  )
  expect(response.status).toBe(200)
  expect(JsonText.parse(await response.text(), resultSchema).controller).toBe('SYNTH-controller')
})

it('serves bounded private raster bytes without forwarding cookies, redirects or undeclared headers', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  const service = await fixture([
    {
      path: route,
      method: 'POST',
      responseHeaders: ['x-synthetic-width'],
      handle: async () =>
        new Response(bytes, {
          headers: {
            'content-type': 'image/jpeg',
            'x-synthetic-width': '1280',
            'x-undeclared': 'SYNTH-hidden',
            'set-cookie': 'SYNTH-cookie',
            location: 'https://synthetic.invalid/',
          },
        }),
    },
  ])
  const response = await service.call()
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(response.headers.get('x-synthetic-width')).toBe('1280')
  expect(response.headers.get('x-undeclared')).toBeNull()
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('no-store')
})

it.each(['text/html', 'text/plain'])('refuses unsupported response content %s without publishing the body', async type => {
  const service = await fixture([
    { path: route, method: 'POST', handle: async () => new Response('SYNTH-PRIVATE-CANARY', { headers: { 'content-type': type } }) },
  ])
  const response = await service.call()
  expect(response.status).toBe(500)
  expect(JsonText.parse(await response.text(), failure)).toEqual({ error: 'internal' })
})

it('cancels oversized extension output and exposes only a fixed failure', async () => {
  let canceled = 0
  const service = await fixture([
    {
      path: route,
      method: 'POST',
      handle: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1))
            },
            cancel() {
              canceled++
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    },
  ])
  const response = await service.call()
  expect(response.status).toBe(500)
  expect(JsonText.parse(await response.text(), failure)).toEqual({ error: 'internal' })
  expect(canceled).toBe(1)
})

it.each(['/v1/send', '/healthz', '/v1/extensions/../snapshot', '/v1/extensions/synthetic?token=SYNTH', '/v1/extensions//empty'])(
  'rejects reserved or noncanonical mount %s before creating storage',
  async path => {
    const root = await parent()
    const storageRoot = join(root, 'data')
    await expect(
      startBotsNodeService({
        storageRoot,
        bearerToken: bearer,
        registry: createBotAdapterRegistry(),
        privateEndpoints: [{ path, method: 'POST', handle: async () => Response.json({}) }],
      }),
    ).rejects.toThrow('Invalid private Bots endpoint configuration')
    await expect(access(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('rejects duplicate endpoints and authority-header declarations before creating storage', async () => {
  for (const privateEndpoints of [
    [
      { path: route, method: 'POST', handle: async () => Response.json({}) },
      { path: route, method: 'POST', handle: async () => Response.json({}) },
    ],
    [{ path: route, method: 'POST', requestHeaders: ['authorization'], handle: async () => Response.json({}) }],
    [{ path: route, method: 'POST', responseHeaders: ['set-cookie'], handle: async () => Response.json({}) }],
    [{ path: route, method: 'POST', requestHeaders: ['x-forwarded-host'], handle: async () => Response.json({}) }],
  ] satisfies ReadonlyArray<readonly BotsPrivateEndpoint[]>) {
    const root = await parent()
    const storageRoot = join(root, 'data')
    await expect(startBotsNodeService({ storageRoot, bearerToken: bearer, registry: createBotAdapterRegistry(), privateEndpoints })).rejects.toThrow(
      'Invalid private Bots endpoint configuration',
    )
    await expect(access(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

interface PendingEndpointControl {
  finish?: (response: Response) => void
  signal?: AbortSignal
  entered?: () => void
}
it('aborts in-flight extension work at shutdown and cancels any late response without publishing it', async () => {
  const control: PendingEndpointControl = {}
  const entered = new Promise<void>(resolve => {
    control.entered = resolve
  })
  const service = await fixture([
    {
      path: route,
      method: 'POST',
      handle: request => {
        control.signal = request.signal
        return new Promise<Response>(resolve => {
          control.finish = resolve
          control.entered?.()
        })
      },
    },
  ])
  const pending = service.call().then(
    () => 'responded',
    () => 'disconnected',
  )
  await entered
  await service.service.close()
  expect(control.signal?.aborted).toBe(true)
  expect(await pending).toBe('disconnected')
  let canceled = 0
  if (control.finish === undefined) throw new Error('Synthetic callback was not entered')
  const canceledBody = new Promise<void>(resolve => {
    control.finish?.(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled++
            resolve()
          },
        }),
        { headers: { 'content-type': 'image/jpeg' } },
      ),
    )
  })
  await canceledBody
  expect(canceled).toBe(1)
})
