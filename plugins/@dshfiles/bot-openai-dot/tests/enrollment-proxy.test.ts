// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest'
import { JsonText } from '@dshfiles/dshx/api'
import { AuthAttemptManager } from '../src/auth-attempt.js'
import type { BrowserPort } from '../src/auth-attempt.js'
import { authStartResultSchema } from '../src/auth-protocol.js'
import type { AuthStartResult } from '../src/auth-protocol.js'
import { createDotEnrollmentEndpoints, dotEnrollmentServiceRoutes } from '../src/enrollment-server.js'
import { createDotEnrollmentProxy } from '../src/enrollment-proxy.js'

interface HeldOperation {
  release?: () => void
  entered?: () => void
}
interface Capture {
  start?: AuthStartResult
}
type Fault = (request: Request, invoke: () => Promise<Response>) => Promise<Response>
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const fixture = (options: { holdOpen?: Promise<void>; complete?: () => Promise<void>; fault?: Fault } = {}) => {
  let closes = 0
  const port: BrowserPort = {
    frame: async () => ({ bytes: new Uint8Array([255, 216, 255, 0, 255, 217]), width: 4, height: 3 }),
    input: async () => undefined,
    close: async () => {
      closes++
    },
  }
  const open = async () => {
    await options.holdOpen
    return port
  }
  const manager = new AuthAttemptManager(options.complete === undefined ? { open } : { open, onComplete: options.complete })
  cleanups.push(() => manager.close())
  const endpoints = createDotEnrollmentEndpoints(manager)
  const transport: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const endpoint = endpoints.find(item => item.path === new URL(request.url).pathname)
    if (endpoint === undefined) throw new Error('Unexpected synthetic endpoint')
    return options.fault === undefined ? endpoint.handle(request) : options.fault(request, () => endpoint.handle(request))
  }
  const proxy = createDotEnrollmentProxy({
    origin: 'http://127.0.0.1:8787',
    resolveBearerToken: async () => 'SYNTH-private-proxy-control-service-key',
    fetch: transport,
  })
  return { manager, proxy, closes: () => closes }
}

it('retains cleanup ownership after completion is refused while the remote browser is still opening', async () => {
  const gate: HeldOperation = {}
  const opening = new Promise<void>(resolve => {
    gate.release = resolve
  })
  const test = fixture({ holdOpen: opening })
  const start = await test.proxy.start({ acceptRisks: true })
  await expect(test.proxy.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 })).rejects.toMatchObject({ code: 'failed' })
  gate.release?.()
  await vi.waitFor(() => expect(test.manager.status(start.capability).state).toBe('ready'))
  expect((await test.proxy.status(start.capability)).state).toBe('ready')
  await expect(test.proxy.frame(start.capability)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(test.proxy.start({ acceptRisks: true })).rejects.toMatchObject({ code: 'busy' })
  await test.proxy.close()
  expect(test.closes()).toBe(1)
})

it.each(['refused', 'malformed', 'nonterminal'])('keeps a failed %s cancellation cleanup obligation until a terminal receipt', async failure => {
  let cancellations = 0
  const test = fixture({
    fault: async (request, invoke) => {
      if (new URL(request.url).pathname === dotEnrollmentServiceRoutes.cancel && ++cancellations === 1) {
        if (failure === 'refused') return Response.json({ error: 'busy' }, { status: 409 })
        if (failure === 'malformed') return new Response('{', { headers: { 'content-type': 'application/json' } })
        return Response.json(test.manager.status(request.headers.get('X-Dot-Auth-Capability') ?? ''))
      }
      return invoke()
    },
  })
  const start = await test.proxy.start({ acceptRisks: true })
  await vi.waitFor(() => expect(test.manager.status(start.capability).state).toBe('ready'))
  await expect(test.proxy.cancel(start.capability)).rejects.toMatchObject({ code: 'failed' })
  expect(test.closes()).toBe(0)
  await expect(test.proxy.frame(start.capability)).rejects.toMatchObject({ code: 'forbidden' })
  await test.proxy.close()
  expect(test.closes()).toBe(1)
  expect(cancellations).toBe(2)
})

it('reports uncertain cleanup after an admitted start response is lost instead of acknowledging a nonexistent close', async () => {
  const capture: Capture = {}
  const test = fixture({
    fault: async (request, invoke) => {
      const response = await invoke()
      if (new URL(request.url).pathname === dotEnrollmentServiceRoutes.start) {
        capture.start = JsonText.parse(await response.text(), authStartResultSchema)
        throw new Error('SYNTH lost start response')
      }
      return response
    },
  })
  await expect(test.proxy.start({ acceptRisks: true })).rejects.toMatchObject({ code: 'failed' })
  if (capture.start === undefined) throw new Error('Synthetic server did not admit a controller')
  await vi.waitFor(() => expect(test.manager.status(capture.start?.capability ?? '').state).toBe('ready'))
  await expect(test.proxy.start({ acceptRisks: true })).rejects.toMatchObject({ code: 'busy' })
  await expect(test.proxy.close()).rejects.toMatchObject({ code: 'failed' })
  expect(test.closes()).toBe(0)
  await test.manager.close()
  expect(test.closes()).toBe(1)
})

it('reports uncertainty rather than a false cleanup acknowledgment when close aborts an in-flight completion', async () => {
  const gate: HeldOperation = {}
  const entered = new Promise<void>(resolve => {
    gate.entered = resolve
  })
  const finish = new Promise<void>(resolve => {
    gate.release = resolve
  })
  const test = fixture({
    complete: async () => {
      gate.entered?.()
      await finish
    },
  })
  const start = await test.proxy.start({ acceptRisks: true })
  await vi.waitFor(() => expect(test.manager.status(start.capability).state).toBe('ready'))
  const completion = test.proxy.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 }).then(
    () => 'completed',
    () => 'refused',
  )
  await entered
  const closing = test.proxy.close()
  gate.release?.()
  await expect(closing).rejects.toMatchObject({ code: 'failed' })
  expect(await completion).toBe('refused')
  expect(test.closes()).toBe(1)
})

it('does not label a known pre-admission refusal as orphaned ownership and permits explicit correction', async () => {
  let wrong = true
  const test = fixture({ fault: async (_request, invoke) => (wrong ? Response.json({ error: 'unauthorized' }, { status: 401 }) : invoke()) })
  await expect(test.proxy.start({ acceptRisks: true })).rejects.toMatchObject({ code: 'failed' })
  wrong = false
  const start = await test.proxy.start({ acceptRisks: true })
  await test.proxy.cancel(start.capability)
  await test.proxy.close()
  expect(test.closes()).toBe(1)
})
