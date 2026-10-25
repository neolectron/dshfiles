// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthViewer } from '../src/auth-viewer.js'
import { AuthAttemptManager } from '../src/auth-attempt.js'
import type { AuthAttemptSnapshot, AuthStartResult } from '../src/auth-protocol.js'
import { createAuthFetchTransport, NativeAuthTransport } from '../src/auth-viewer-transport.js'
import type { AuthViewerTransport } from '../src/auth-viewer-transport.js'

const ID = 'a07e3e20-55a0-4400-b048-49668a1bd1ad'
const CAP = 'fixture-private-capability'
const snapshot = (state: AuthAttemptSnapshot['state'] = 'ready'): AuthAttemptSnapshot => ({
  id: ID,
  state,
  width: 800,
  height: 400,
  expiresAt: Date.now() + 60_000,
})
const frame = () => ({ bytes: new Uint8Array([255, 216, 255, 0, 255, 217]), width: 800, height: 400 })
function fixture(): AuthViewerTransport {
  return {
    start: vi.fn(async () => ({ attempt: snapshot(), capability: CAP })),
    frame: vi.fn(async () => frame()),
    input: vi.fn(async () => undefined),
    status: vi.fn(async () => snapshot()),
    cancel: vi.fn(async () => snapshot('closed')),
    complete: vi.fn(async () => snapshot('completed')),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
let root: Root, host: HTMLDivElement
let handlers: Map<EventTarget, Map<string, EventListener>>
const clearRect = vi.fn(),
  drawImage = vi.fn(),
  revoke = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  handlers = new Map()
  const original = HTMLElement.prototype.addEventListener
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (options && options !== true && options.signal && listener) {
      const byType = handlers.get(this) ?? new Map<string, EventListener>()
      const callback: EventListener = 'handleEvent' in listener ? event => listener.handleEvent(event) : listener
      byType.set(type, callback)
      handlers.set(this, byType)
    }
    original.call(this, type, listener, options)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect, drawImage } as never)
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 800
      naturalHeight = 400
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(value: string) {
        if (value) Promise.resolve().then(() => this.onload?.())
      }
    },
  )
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:fixture-raster')
      static override revokeObjectURL = revoke
    },
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function mount(transport: AuthViewerTransport) {
  await act(async () => {
    root.render(<AuthViewer transport={transport} />)
  })
}
async function start() {
  const checkbox = host.querySelector('input')
  if (!checkbox) throw new Error('Missing consent')
  await act(async () => checkbox.click())
  await click('Start browser')
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === text)
  if (!button) throw new Error('Missing button')
  await act(async () => button.click())
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const found = host.querySelector(tag)
  if (!found) throw new Error('Missing viewer element')
  return found
}
type NativeInputFixture = Event &
  Pick<MouseEvent, 'clientX' | 'clientY' | 'button' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> &
  Pick<KeyboardEvent, 'key' | 'isComposing' | 'getModifierState'> &
  Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'> &
  Pick<InputEvent, 'data' | 'inputType'> & {
    pointerId: number
    clipboardData: Pick<DataTransfer, 'getData'>
  }
/** Explicit typed event fixture ONLY; no browser/session/provider is opened.
 * Production listeners still require native isTrusted; no production test hook. */
async function human(target: HTMLElement, event: Event, pasteText = '') {
  const listener = handlers.get(target)?.get(event.type)
  if (!listener) throw new Error('Missing private actor listener')
  const mouse = event instanceof MouseEvent ? event : undefined
  const keyboard = event instanceof KeyboardEvent ? event : undefined
  const input = event instanceof InputEvent ? event : undefined
  const composition = event instanceof CompositionEvent ? event : undefined
  const wheel = event instanceof WheelEvent ? event : undefined
  const fixtureEvent: NativeInputFixture = {
    isTrusted: true,
    type: event.type,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    currentTarget: target,
    target,
    srcElement: target,
    eventPhase: event.eventPhase,
    timeStamp: event.timeStamp,
    cancelBubble: event.cancelBubble,
    returnValue: event.returnValue,
    NONE: event.NONE,
    CAPTURING_PHASE: event.CAPTURING_PHASE,
    AT_TARGET: event.AT_TARGET,
    BUBBLING_PHASE: event.BUBBLING_PHASE,
    get defaultPrevented() {
      return event.defaultPrevented
    },
    composedPath: () => event.composedPath(),
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    stopImmediatePropagation: () => event.stopImmediatePropagation(),
    initEvent: (type, bubbles, cancelable) => event.initEvent(type, bubbles, cancelable),
    clientX: mouse?.clientX ?? 0,
    clientY: mouse?.clientY ?? 0,
    button: mouse?.button ?? 0,
    ctrlKey: mouse?.ctrlKey ?? keyboard?.ctrlKey ?? false,
    metaKey: mouse?.metaKey ?? keyboard?.metaKey ?? false,
    altKey: mouse?.altKey ?? keyboard?.altKey ?? false,
    shiftKey: mouse?.shiftKey ?? keyboard?.shiftKey ?? false,
    key: keyboard?.key ?? '',
    isComposing: keyboard?.isComposing ?? input?.isComposing ?? false,
    getModifierState: key => keyboard?.getModifierState(key) ?? false,
    deltaX: wheel?.deltaX ?? 0,
    deltaY: wheel?.deltaY ?? 0,
    deltaMode: wheel?.deltaMode ?? 0,
    data: input?.data ?? composition?.data ?? null,
    inputType: input?.inputType ?? '',
    pointerId: 1,
    clipboardData: { getData: () => pasteText },
  }
  await act(async () => listener.call(target, fixtureEvent))
}
function placeCanvas() {
  const canvas = element('canvas')
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 400,
    width: 400,
    height: 400,
    toJSON() {
      return {}
    },
  })
  return canvas
}
async function advance(ms = 40) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const FETCH_CAP = 'a'.repeat(43)
const ORIGIN = 'https://dsh.fixture.test'
type AuthJsonFixture = AuthStartResult | AuthAttemptSnapshot | (AuthAttemptSnapshot & { raw: string })
function jsonResponse(value: AuthJsonFixture, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...extra } })
}
function fetchFixture(basePath = '/') {
  const fetch = vi.fn<typeof globalThis.fetch>(async url =>
    String(url).endsWith('/start')
      ? jsonResponse({ attempt: snapshot(), capability: FETCH_CAP })
      : jsonResponse(snapshot(String(url).endsWith('/cancel') ? 'closed' : 'ready')),
  )
  return { fetch, transport: createAuthFetchTransport({ browserOrigin: ORIGIN, pageOrigin: ORIGIN, basePath, fetch }), signal: new AbortController().signal }
}
async function begun(basePath = '/') {
  const item = fetchFixture(basePath)
  await item.transport.start({ acceptRisks: true }, item.signal)
  return item
}
const jpeg = () => new Uint8Array([255, 216, 255, 192, 0, 17, 8, 1, 144, 3, 32, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 217])

describe('explicit-deployment private native Fetch adapter fixture', () => {
  it.each(['/', '/mounted/'])('POSTs bounded JSON for all five fixed routes beneath %s with capability headers and private fetch policy', async basePath => {
    const { fetch, transport, signal } = await begun(basePath)
    await transport.status(ID, FETCH_CAP, signal)
    fetch.mockResolvedValueOnce(new Response(jpeg(), { headers: { 'Content-Type': 'image/jpeg', 'X-Dot-Auth-Width': '800', 'X-Dot-Auth-Height': '400' } }))
    await transport.frame(ID, FETCH_CAP, signal)
    await transport.input(ID, FETCH_CAP, { attemptId: ID, sequence: 1, input: { kind: 'text', text: 'fixture-input' } }, signal)
    await transport.cancel(ID, FETCH_CAP, signal)
    const prefix = `${ORIGIN}${basePath.slice(0, -1)}/api/dshfiles/dot-auth/`
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['start', 'status', 'frame', 'input', 'cancel'].map(operation => `${prefix}${operation}`))
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain(FETCH_CAP)
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        mode: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal,
      })
      const headers = new Headers(init?.headers)
      expect(headers.get('Cache-Control')).toBe('no-store')
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(init?.body).toBeTypeOf('string')
      expect(new TextEncoder().encode(String(init?.body)).byteLength).toBeLessThanOrEqual(8192)
      expect(headers.get('Origin')).toBeNull()
      expect(headers.get('X-Dot-Auth-Capability')).toBe(String(url).endsWith('/start') ? null : FETCH_CAP)
    }
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"acceptRisks":true}')
    expect(fetch.mock.calls[1]?.[1]?.body).toBe('{}')
    expect(fetch.mock.calls[2]?.[1]?.body).toBe('{}')
    expect(fetch.mock.calls[3]?.[1]?.body).toContain('"attemptId"')
    expect(fetch.mock.calls[4]?.[1]?.body).toBe('{}')
  })
  it.each(['', 'mount/', '/mount', '//', '//evil.test/', '/a//b/', '/./', '/../', '/a/../b/', '/%2f/', '/%2e%2e/', '/a\\b/', '/a/?x=1', '/a/#secret'])(
    'rejects noncanonical mount %j before fetch',
    basePath => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      expect(() => createAuthFetchTransport({ browserOrigin: ORIGIN, pageOrigin: ORIGIN, basePath, fetch })).toThrow('private browser request')
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it.each(['https://other.fixture.test', `${ORIGIN}/`, 'https://user:pass@dsh.fixture.test', 'file:///private'])(
    'rejects origin mismatch/noncanonical %s without network',
    browserOrigin => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      expect(() => createAuthFetchTransport({ browserOrigin, pageOrigin: ORIGIN, basePath: '/', fetch })).toThrow('private browser request')
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('rejects unknown consent fields and serialized request overflow before fetch', async () => {
    const { fetch, transport, signal } = fetchFixture()
    const consent = { acceptRisks: true as const, unexpected: 'fixture-canary' }
    await expect(transport.start(consent, signal)).rejects.toThrow('private browser request')
    expect(fetch).not.toHaveBeenCalled()
    await transport.start({ acceptRisks: true }, signal)
    await expect(transport.input(ID, FETCH_CAP, { attemptId: ID, sequence: 1, input: { kind: 'text', text: '"'.repeat(4096) } }, signal)).rejects.toThrow(
      'private browser request',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('binds every private operation to the started attempt/capability before fetch', async () => {
    const { fetch, transport, signal } = await begun()
    await expect(transport.frame('wrong-attempt', FETCH_CAP, signal)).rejects.toThrow('private browser request')
    await expect(transport.status(ID, 'b'.repeat(43), signal)).rejects.toThrow('private browser request')
    await expect(transport.input(ID, FETCH_CAP, { attemptId: 'wrong-attempt', sequence: 1, input: { kind: 'text', text: 'fixture' } }, signal)).rejects.toThrow(
      'private browser request',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('strictly decodes owner responses without echoing unknown fields, parse errors or native throwables', async () => {
    const { fetch, transport, signal } = await begun()
    fetch.mockResolvedValueOnce(jsonResponse({ ...snapshot(), raw: 'fixture-canary' }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow(/^The private browser request could not be completed\.$/u)
    fetch.mockResolvedValueOnce(new Response('fixture-canary', { headers: { 'Content-Type': 'application/json' } }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow(/^The private browser request could not be completed\.$/u)
    fetch.mockRejectedValueOnce(new Error('fixture-canary'))
    await expect(transport.input(ID, FETCH_CAP, { attemptId: ID, sequence: 1, input: { kind: 'text', text: 'fixture-canary' } }, signal)).rejects.toThrow(
      /^The private browser request could not be completed\.$/u,
    )
    expect(fetch).toHaveBeenCalledTimes(4) // no retry
  })
  it('binds decoded status IDs and refuses oversized UTF-8 input', async () => {
    const { fetch, transport, signal } = await begun()
    fetch.mockResolvedValueOnce(jsonResponse({ ...snapshot(), id: 'b07e3e20-55a0-4400-b048-49668a1bd1ad' }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
    await expect(transport.input(ID, FETCH_CAP, { attemptId: ID, sequence: 1, input: { kind: 'text', text: 'é'.repeat(2049) } }, signal)).rejects.toThrow(
      'private browser request',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('bounds streamed JSON regardless of content-length and cancels the reader on overflow', async () => {
    const { fetch, transport, signal } = await begun()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8193))
      },
      cancel,
    })
    fetch.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('bounds declared response sizes and rejects non-JSON/error responses without reading sensitive bodies', async () => {
    const { fetch, transport, signal } = await begun()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    fetch.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' } }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
    expect(cancel).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValueOnce(new Response('fixture-canary', { status: 403, headers: { 'Content-Type': 'text/html' } }))
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow(/^The private browser request could not be completed\.$/u)
  })
  it('validates JPEG dimensions and cap before image decoding', async () => {
    const { fetch, transport, signal } = await begun('/mounted/')
    fetch.mockResolvedValueOnce(new Response(jpeg(), { headers: { 'Content-Type': 'image/jpeg', 'X-Dot-Auth-Width': '800', 'X-Dot-Auth-Height': '400' } }))
    expect(await transport.frame(ID, FETCH_CAP, signal)).toEqual({ bytes: jpeg(), width: 800, height: 400 })
    fetch.mockResolvedValueOnce(new Response(jpeg(), { headers: { 'Content-Type': 'image/jpeg', 'X-Dot-Auth-Width': '799', 'X-Dot-Auth-Height': '400' } }))
    await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'Content-Type': 'image/jpeg' } }))
    await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  })
  it('aborts a pending streamed response and never retries or performs a pre-aborted fetch', async () => {
    const { fetch, transport, signal } = await begun()
    const controller = new AbortController(),
      cancel = vi.fn()
    fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'application/json' } }))
    const pending = transport.status(ID, FETCH_CAP, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow('private browser request')
    expect(cancel).toHaveBeenCalled()
    const count = fetch.mock.calls.length
    await expect(transport.status(ID, FETCH_CAP, controller.signal)).rejects.toThrow('private browser request')
    expect(fetch).toHaveBeenCalledTimes(count)
    await transport.cancel(ID, FETCH_CAP, signal)
    await expect(transport.status(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  })
})

describe('human-only Dot raster fixture', () => {
  it('requires explicit consent and keeps capability/frame/input out of markup and stores', async () => {
    const transport = fixture()
    await mount(transport)
    expect(element('button').disabled).toBe(true)
    expect(transport.start).not.toHaveBeenCalled()
    expect(host.textContent).toContain('fresh browser on the DSH host')
    expect(host.textContent).toContain('same owner authority')
    expect(host.textContent).toContain('not confidential')
    await start()
    expect(transport.start).toHaveBeenCalledWith({ acceptRisks: true }, expect.any(AbortSignal))
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:fixture-raster')
    expect(host.innerHTML).not.toContain(CAP)
    expect(host.querySelector('img, video, a[download]')).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(host.textContent).toContain('not a sign-in success report')
  })
  it('integrates the actual manager zero-size opening snapshot with a synthetic browser port', async () => {
    const browser = { frame: vi.fn(async () => frame()), input: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    const manager = new AuthAttemptManager({ open: async () => browser })
    const transport: AuthViewerTransport = {
      start: async consent => manager.start(consent),
      status: async (_id, cap) => manager.status(cap),
      frame: async (_id, cap, signal) => manager.frame(cap, signal),
      input: async (_id, cap, request, signal) => {
        await manager.input(cap, request, signal)
      },
      cancel: async (_id, cap) => manager.cancel(cap),
      complete: async (_id, cap, request, signal) => manager.complete(cap, request, signal),
    }
    await mount(transport)
    await start()
    await advance(500)
    expect(drawImage).toHaveBeenCalled()
    expect(host.textContent).toContain('Browser available')
    const canvas = placeCanvas()
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    expect(browser.input).toHaveBeenCalledWith({ kind: 'pointer', action: 'down', x: 400, y: 200, button: 'left' }, expect.any(AbortSignal))
    await click('Cancel browser')
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('backend acknowledged')
  })
  it('maps object-contain pixels, rejects letterbox and synthetic input, bounds wheel', async () => {
    const transport = fixture()
    await mount(transport)
    await start()
    const canvas = placeCanvas()
    await act(async () => canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, clientY: 200 })))
    expect(transport.input).not.toHaveBeenCalled()
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 10 }))
    expect(transport.input).not.toHaveBeenCalled()
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    expect(transport.input).toHaveBeenLastCalledWith(
      ID,
      CAP,
      { attemptId: ID, sequence: 1, input: { kind: 'pointer', action: 'down', x: 400, y: 200, button: 'left' } },
      expect.any(AbortSignal),
    )
    await human(canvas, new WheelEvent('wheel', { clientX: 200, clientY: 200, deltaY: 999999.5 }))
    await advance()
    expect(transport.input).toHaveBeenLastCalledWith(
      ID,
      CAP,
      expect.objectContaining({ sequence: 2, input: { kind: 'wheel', x: 400, y: 200, deltaX: 0, deltaY: 1000 } }),
      expect.any(AbortSignal),
    )
  })
  it('releases a captured pointer outside the displayed raster at its last valid position', async () => {
    const transport = fixture()
    await mount(transport)
    await start()
    const canvas = placeCanvas()
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    await human(canvas, new MouseEvent('pointerup', { clientX: 900, clientY: -10 }))
    await advance()
    expect(transport.input).toHaveBeenLastCalledWith(
      ID,
      CAP,
      expect.objectContaining({ sequence: 2, input: { kind: 'pointer', action: 'up', x: 400, y: 200, button: 'left' } }),
      expect.any(AbortSignal),
    )
  })
  it('serializes sequence without retries and drops queued input immediately on cancel', async () => {
    const pending = deferred<void>(),
      receipt = deferred<AuthAttemptSnapshot>()
    const transport = fixture()
    transport.input = vi.fn(() => pending.promise)
    transport.cancel = vi.fn(() => receipt.promise)
    await mount(transport)
    await start()
    const canvas = placeCanvas()
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    await human(canvas, new MouseEvent('pointerup', { clientX: 200, clientY: 200 }))
    expect(transport.input).toHaveBeenCalledTimes(1)
    const inputSignal = vi.mocked(transport.input).mock.calls[0]?.[3]
    await click('Cancel browser')
    expect(inputSignal?.aborted).toBe(true)
    expect(canvas.width).toBe(0)
    expect(element('textarea').value).toBe('')
    expect(host.textContent).toContain('Requesting backend cancellation')
    await act(async () => pending.resolve())
    await advance(100)
    expect(transport.input).toHaveBeenCalledTimes(1)
    await act(async () => receipt.resolve(snapshot('closed')))
    expect(host.textContent).toContain('backend acknowledged')
  })
  it('handles composition once and permits only page keys, input-only paste, no shortcuts/export', async () => {
    const transport = fixture()
    await mount(transport)
    await start()
    const keyboard = element('textarea')
    await human(keyboard, new CompositionEvent('compositionstart'))
    await human(keyboard, new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'fixture' }))
    expect(transport.input).not.toHaveBeenCalled()
    await human(keyboard, new CompositionEvent('compositionend', { data: 'fixture' }))
    await human(keyboard, new InputEvent('beforeinput', { inputType: 'insertText', data: 'fixture' }))
    expect(transport.input).toHaveBeenCalledTimes(1)
    expect(keyboard.value).toBe('')
    for (const event of [
      new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: 'F12' }),
      new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true }),
      new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }),
      new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true }),
      new KeyboardEvent('keydown', { key: 'c', metaKey: true }),
    ])
      await human(keyboard, event)
    await advance()
    expect(transport.input).toHaveBeenCalledTimes(1)
    await human(keyboard, new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }))
    await advance()
    expect(transport.input).toHaveBeenLastCalledWith(
      ID,
      CAP,
      expect.objectContaining({ sequence: 2, input: { kind: 'key', action: 'down', key: 'ArrowLeft', modifiers: 8 } }),
      expect.any(AbortSignal),
    )
    const paste = new Event('paste', { cancelable: true })
    await human(keyboard, paste, 'fixture-pasted')
    await advance()
    expect(transport.input).toHaveBeenLastCalledWith(
      ID,
      CAP,
      expect.objectContaining({ sequence: 3, input: { kind: 'text', text: 'fixture-pasted' } }),
      expect.any(AbortSignal),
    )
    expect(host.innerHTML).not.toContain('fixture-pasted')
    for (const kind of ['copy', 'cut', 'drop']) {
      const event = new Event(kind, { cancelable: true })
      await human(keyboard, event)
      expect(event.defaultPrevented).toBe(true)
    }
  })
  it('respects denial without inference or retry and reports unconfirmed cancellation honestly', async () => {
    const transport = fixture()
    transport.status = vi.fn(async () => snapshot('denied'))
    await mount(transport)
    await start()
    expect(host.textContent).toContain('provider denied')
    expect(transport.frame).not.toHaveBeenCalled()
    await advance(2000)
    expect(transport.start).toHaveBeenCalledTimes(1)
  })
  it('cleans up on unmount and cancels even a late aborted start result', async () => {
    const transport = fixture(),
      pending = deferred<Awaited<ReturnType<AuthViewerTransport['start']>>>()
    transport.start = vi.fn(() => pending.promise)
    await mount(transport)
    await start()
    const startSignal = vi.mocked(transport.start).mock.calls[0]?.[1]
    await act(async () => root.unmount())
    expect(startSignal?.aborted).toBe(true)
    await act(async () => pending.resolve({ attempt: snapshot(), capability: CAP }))
    expect(transport.cancel).toHaveBeenCalledWith(ID, CAP, expect.any(AbortSignal))
    expect(transport.frame).not.toHaveBeenCalled()
  })
  it('rejects whole oversized UTF-8 paste without truncation or secret-bearing hints', async () => {
    const transport = fixture()
    await mount(transport)
    await start()
    const keyboard = element('textarea')
    const paste = new Event('paste', { cancelable: true })
    const secret = 'é'.repeat(2049)
    await human(keyboard, paste, secret)
    expect(transport.input).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Nothing was sent')
    expect(host.innerHTML).not.toContain(secret)
    expect(keyboard.value).toBe('')
    await human(keyboard, new KeyboardEvent('keydown', { key: 'A', shiftKey: true }))
    await human(keyboard, new InputEvent('beforeinput', { inputType: 'insertText', data: 'A' }))
    expect(transport.input).toHaveBeenLastCalledWith(ID, CAP, expect.objectContaining({ input: { kind: 'text', text: 'A' } }), expect.any(AbortSignal))
    expect(host.textContent).toContain('Browser available')
  })
  it('replaces only the latest raster and revokes each object URL', async () => {
    const transport = fixture()
    await mount(transport)
    await start()
    expect(transport.frame).toHaveBeenCalledTimes(1)
    await advance(500)
    expect(transport.frame).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(host.querySelectorAll('canvas')).toHaveLength(1)
    expect(host.querySelector('[src]')).toBeNull()
    await click('Cancel browser')
    await advance(2000)
    expect(transport.frame).toHaveBeenCalledTimes(2)
    expect(element('canvas').width).toBe(0)
  })
  it('never retries failed input and cancels the local lifetime', async () => {
    const transport = fixture()
    transport.input = vi.fn(async () => {
      throw new Error('fixture-sensitive-error-not-rendered')
    })
    await mount(transport)
    await start()
    await human(placeCanvas(), new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    await advance(1000)
    expect(transport.input).toHaveBeenCalledTimes(1)
    expect(transport.cancel).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Viewing stopped after a failure')
    expect(host.innerHTML).not.toContain('fixture-sensitive-error')
  })
  it('expires locally and does not infer success from the raster', async () => {
    const transport = fixture()
    transport.start = vi.fn(async () => ({ attempt: { ...snapshot(), expiresAt: Date.now() + 100 }, capability: CAP }))
    await mount(transport)
    await start()
    await advance(100)
    expect(host.textContent).toContain('attempt expired')
    expect(element('canvas').width).toBe(0)
    expect(transport.cancel).toHaveBeenCalledTimes(1)
  })
  it('does not acknowledge cancellation for a different attempt', async () => {
    const transport = fixture()
    transport.cancel = vi.fn(async () => ({ ...snapshot('closed'), id: 'other-attempt' }))
    await mount(transport)
    await start()
    await click('Cancel browser')
    expect(host.textContent).toContain('Backend cancellation is not confirmed')
    expect(host.textContent).not.toContain('backend acknowledged')
  })
  it('fails closed on oversized raster and never claims backend shutdown without ack', async () => {
    const transport = fixture()
    transport.frame = vi.fn(async () => ({ ...frame(), bytes: new Uint8Array(1024 * 1024 + 1) }))
    transport.cancel = vi.fn(async () => {
      throw new Error('fixture failure')
    })
    await mount(transport)
    await start()
    expect(host.textContent).toContain('Browser shutdown is not confirmed')
    expect(drawImage).not.toHaveBeenCalled()
    expect(element('canvas').width).toBe(0)
  })
})

describe('explicit human session handoff', () => {
  it('clears the raster, keyboard and queued input immediately, completes once and does not cancel a promoted session', async () => {
    const transport = fixture(),
      receipt = deferred<AuthAttemptSnapshot>(),
      typing = deferred<void>()
    transport.complete = vi.fn(() => receipt.promise)
    transport.input = vi.fn(() => typing.promise)
    await mount(transport)
    await start()
    expect(host.textContent).toContain('no separate ChatGPT tab or desktop helper')
    const canvas = placeCanvas(),
      keyboard = element('textarea')
    await human(canvas, new MouseEvent('pointerdown', { clientX: 200, clientY: 200 }))
    await human(canvas, new MouseEvent('pointerup', { clientX: 200, clientY: 200 }))
    keyboard.value = 'fixture-not-retained'
    const inputSignal = vi.mocked(transport.input).mock.calls[0]?.[3]
    await click('Use this session')
    expect(inputSignal?.aborted).toBe(false)
    expect(canvas.width).toBe(0)
    expect(keyboard.value).toBe('')
    expect(keyboard.disabled).toBe(true)
    expect(transport.complete).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Preparing this browser session')
    await act(async () => typing.resolve())
    expect(inputSignal?.aborted).toBe(true)
    expect(transport.complete).toHaveBeenCalledWith(ID, CAP, { attemptId: ID, sequence: 2 }, expect.any(AbortSignal))
    await advance(1000)
    expect(transport.input).toHaveBeenCalledTimes(1)
    expect(transport.frame).toHaveBeenCalledTimes(1)
    await act(async () => receipt.resolve(snapshot('completed')))
    expect(host.textContent).toContain('Browser session ready. Return to Bots and connect/reconnect selected account.')
    expect(host.textContent).not.toContain('account connected')
    expect(transport.complete).toHaveBeenCalledTimes(1)
    expect(transport.cancel).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(transport.cancel).not.toHaveBeenCalled()
  })

  it('discards a late raster after completion starts and never reactivates input', async () => {
    const transport = fixture(),
      pending = deferred<ReturnType<typeof frame>>()
    await mount(transport)
    await start()
    transport.frame = vi.fn(() => pending.promise)
    await advance(500)
    const signal = vi.mocked(transport.frame).mock.calls[0]?.[2]
    await click('Use this session')
    expect(signal?.aborted).toBe(false)
    expect(transport.complete).not.toHaveBeenCalled()
    await act(async () => pending.resolve(frame()))
    expect(signal?.aborted).toBe(true)
    await advance(1000)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(element('canvas').width).toBe(0)
    expect(element('textarea').disabled).toBe(true)
    expect(transport.frame).toHaveBeenCalledTimes(1)
  })

  it.each(['reject', 'wrong-state', 'wrong-id', 'timeout'] as const)('fails completion safely on %s without retries or stale input', async kind => {
    const transport = fixture(),
      pending = deferred<AuthAttemptSnapshot>()
    transport.complete = vi.fn(async () => {
      if (kind === 'reject') throw new Error('fixture-sensitive-completion-error')
      if (kind === 'timeout') return pending.promise
      const receipt = snapshot(kind === 'wrong-state' ? 'ready' : 'completed')
      if (kind === 'wrong-id') receipt.id = 'other-attempt'
      return receipt
    })
    await mount(transport)
    await start()
    await click('Use this session')
    if (kind === 'timeout') await advance(20_000)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Session completion is unconfirmed')
    expect(host.textContent).toContain('No account connection is claimed')
    expect(host.innerHTML).not.toContain('fixture-sensitive-completion-error')
    expect(element('canvas').width).toBe(0)
    expect(element('textarea').disabled).toBe(true)
    await act(async () => pending.resolve(snapshot('completed')))
    await advance(1000)
    expect(host.textContent).not.toContain('Browser session ready.')
    expect(transport.complete).toHaveBeenCalledTimes(1)
    expect(transport.input).not.toHaveBeenCalled()
  })

  it('aborts completion on page departure and ignores a late success', async () => {
    const transport = fixture(),
      pending = deferred<AuthAttemptSnapshot>()
    transport.complete = vi.fn(() => pending.promise)
    await mount(transport)
    await start()
    await click('Use this session')
    const signal = vi.mocked(transport.complete).mock.calls[0]?.[3]
    await act(async () => root.unmount())
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(snapshot('completed')))
    expect(host.textContent).toBe('')
  })

  it('sends completion only to the fixed same-origin relative route and retires the private local binding before awaiting', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ attempt: snapshot(), capability: FETCH_CAP }))
    vi.stubGlobal('fetch', fetch)
    const transport = NativeAuthTransport(),
      signal = new AbortController().signal
    await transport.start({ acceptRisks: true }, signal)
    const pending = deferred<Response>()
    fetch.mockImplementationOnce(() => pending.promise)
    const completed = transport.complete(ID, FETCH_CAP, { attemptId: ID, sequence: 1 }, signal)
    await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/dshfiles/dot-auth/start', '/api/dshfiles/dot-auth/complete'])
    const init = fetch.mock.calls[1]?.[1]
    expect(init?.body).toBe(JSON.stringify({ attemptId: ID, sequence: 1 }))
    expect(new Headers(init?.headers).get('X-Dot-Auth-Capability')).toBe(FETCH_CAP)
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    pending.resolve(jsonResponse(snapshot('completed')))
    await expect(completed).resolves.toMatchObject({ state: 'completed' })
    await expect(transport.complete(ID, FETCH_CAP, { attemptId: ID, sequence: 2 }, signal)).rejects.toThrow('private browser request')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

it('quiesces an acknowledged frame before one complete instead of aborting and revoking the browser', async () => {
  const transport = fixture(),
    pending = deferred<ReturnType<typeof frame>>()
  let borrowedBrowserClosed = false,
    frameAcknowledged = false
  await mount(transport)
  await start()
  transport.frame = vi.fn(async (_id, _cap, signal) => {
    const revoke = () => {
      if (!frameAcknowledged) borrowedBrowserClosed = true
    }
    signal.addEventListener('abort', revoke, { once: true })
    try {
      const result = await pending.promise
      frameAcknowledged = true
      return result
    } finally {
      signal.removeEventListener('abort', revoke)
    }
  })
  transport.complete = vi.fn(async () => {
    if (borrowedBrowserClosed || !frameAcknowledged) throw new Error('Synthetic borrow revoked before promotion')
    return snapshot('completed')
  })
  await advance(500)
  await click('Use this session')
  expect(element('canvas').width).toBe(0)
  expect(element('textarea').disabled).toBe(true)
  expect(borrowedBrowserClosed).toBe(false)
  expect(transport.complete).not.toHaveBeenCalled()
  await act(async () => pending.resolve(frame()))
  expect(transport.complete).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Browser session ready.')
  expect(borrowedBrowserClosed).toBe(false)
})

it.each(['deadline', 'departure', 'cancel'] as const)('never dispatches late complete after %s while waiting for private work to quiesce', async kind => {
  const transport = fixture(),
    pending = deferred<ReturnType<typeof frame>>()
  await mount(transport)
  await start()
  transport.frame = vi.fn(() => pending.promise)
  await advance(500)
  const signal = vi.mocked(transport.frame).mock.calls[0]?.[2]
  await click('Use this session')
  expect(signal?.aborted).toBe(false)
  expect(transport.complete).not.toHaveBeenCalled()
  if (kind === 'deadline') await advance(20_000)
  if (kind === 'departure') await act(async () => root.unmount())
  if (kind === 'cancel') await click('Cancel browser')
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve(frame()))
  await advance(1000)
  expect(transport.complete).not.toHaveBeenCalled()
  expect(transport.cancel).toHaveBeenCalledTimes(1)
})

it('waits for an outstanding status acknowledgment before completing once', async () => {
  const transport = fixture(),
    pending = deferred<AuthAttemptSnapshot>()
  await mount(transport)
  await start()
  transport.status = vi.fn(() => pending.promise)
  await advance(500)
  await click('Use this session')
  expect(transport.complete).not.toHaveBeenCalled()
  expect(element('canvas').width).toBe(0)
  await act(async () => pending.resolve(snapshot()))
  expect(transport.complete).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Browser session ready.')
})

it.each(['non-ok', 'malformed', 'lost'] as const)('retains cleanup-only authority after %s completion without reactivating input', async kind => {
  const { fetch, transport, signal } = await begun()
  if (kind === 'non-ok') fetch.mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json' } }))
  if (kind === 'malformed') fetch.mockResolvedValueOnce(jsonResponse({ ...snapshot('completed'), raw: 'synthetic-private-error' }))
  if (kind === 'lost') fetch.mockRejectedValueOnce(new Error('synthetic-lost-response'))
  await expect(transport.complete(ID, FETCH_CAP, { attemptId: ID, sequence: 1 }, signal)).rejects.toThrow('private browser request')
  fetch.mockResolvedValueOnce(jsonResponse(snapshot()))
  await expect(transport.status(ID, FETCH_CAP, signal)).resolves.toMatchObject({ state: 'ready' })
  const before = fetch.mock.calls.length
  await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  await expect(transport.input(ID, FETCH_CAP, { attemptId: ID, sequence: 2, input: { kind: 'text', text: 'never-sent' } }, signal)).rejects.toThrow(
    'private browser request',
  )
  await expect(transport.complete(ID, FETCH_CAP, { attemptId: ID, sequence: 2 }, signal)).rejects.toThrow('private browser request')
  await expect(transport.start({ acceptRisks: true }, signal)).rejects.toThrow('private browser request')
  expect(fetch).toHaveBeenCalledTimes(before)
  fetch.mockResolvedValueOnce(jsonResponse(snapshot('closed')))
  await expect(transport.cancel(ID, FETCH_CAP, signal)).resolves.toMatchObject({ state: 'closed' })
  expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('X-Dot-Auth-Capability')).toBe(FETCH_CAP)
})

it('attempts one private cleanup cancel after an uncertain dispatched completion and never claims browser shutdown', async () => {
  const transport = fixture()
  transport.complete = vi.fn(async () => {
    throw new Error('synthetic-completion-response-lost')
  })
  transport.cancel = vi.fn(async () => {
    throw new Error('synthetic-cleanup-refused')
  })
  await mount(transport)
  await start()
  await click('Use this session')
  expect(transport.cancel).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Browser shutdown is not confirmed')
  expect(host.textContent).not.toContain('Browser session ready.')
  expect(element('canvas').width).toBe(0)
  expect(element('textarea').disabled).toBe(true)
})

it('keeps a refused cancellation retiring until a same-attempt terminal ACK', async () => {
  const { fetch, transport, signal } = await begun()
  fetch.mockResolvedValueOnce(jsonResponse(snapshot()))
  await expect(transport.cancel(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  const count = fetch.mock.calls.length
  await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  await expect(transport.start({ acceptRisks: true }, signal)).rejects.toThrow('private browser request')
  expect(fetch).toHaveBeenCalledTimes(count)
  fetch.mockResolvedValueOnce(jsonResponse(snapshot('closed')))
  await expect(transport.status(ID, FETCH_CAP, signal)).resolves.toMatchObject({ state: 'closed' })
  await expect(transport.start({ acceptRisks: true }, signal)).resolves.toMatchObject({ capability: FETCH_CAP })
})

it('blocks a fresh start after an unknown start response and renders shutdown uncertainty', async () => {
  const { fetch, transport, signal } = fetchFixture()
  fetch.mockRejectedValueOnce(new Error('synthetic-lost-start'))
  await expect(transport.start({ acceptRisks: true }, signal)).rejects.toThrow('private browser request')
  await expect(transport.start({ acceptRisks: true }, signal)).rejects.toThrow('private browser request')
  expect(fetch).toHaveBeenCalledTimes(1)
  await mount(transport)
  await start()
  expect(host.textContent).toContain('Browser shutdown is not confirmed')
  expect(host.textContent).not.toContain('backend acknowledged')
})

it('never publishes a late frame once its grant is retiring even if status still says ready', async () => {
  const { fetch, transport, signal } = await begun(),
    pending = deferred<Response>()
  fetch.mockImplementationOnce(() => pending.promise)
  const frameResult = transport.frame(ID, FETCH_CAP, signal)
  const refused = expect(frameResult).rejects.toThrow('private browser request')
  fetch.mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json' } }))
  await expect(transport.complete(ID, FETCH_CAP, { attemptId: ID, sequence: 1 }, signal)).rejects.toThrow('private browser request')
  pending.resolve(new Response(jpeg(), { headers: { 'Content-Type': 'image/jpeg', 'X-Dot-Auth-Width': '800', 'X-Dot-Auth-Height': '400' } }))
  await refused
  fetch.mockResolvedValueOnce(jsonResponse(snapshot('closed')))
  await transport.cancel(ID, FETCH_CAP, signal)
})

it.each(['non-ok', 'malformed', 'lost'] as const)('retains the same cleanup grant after %s cancellation without silently reopening', async kind => {
  const { fetch, transport, signal } = await begun()
  if (kind === 'non-ok') fetch.mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json' } }))
  if (kind === 'malformed') fetch.mockResolvedValueOnce(jsonResponse({ ...snapshot('closed'), raw: 'synthetic-private-error' }))
  if (kind === 'lost') fetch.mockRejectedValueOnce(new Error('synthetic-lost-cancel'))
  await expect(transport.cancel(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  const before = fetch.mock.calls.length
  await expect(transport.start({ acceptRisks: true }, signal)).rejects.toThrow('private browser request')
  await expect(transport.frame(ID, FETCH_CAP, signal)).rejects.toThrow('private browser request')
  expect(fetch).toHaveBeenCalledTimes(before)
  fetch.mockResolvedValueOnce(jsonResponse(snapshot('closed')))
  await expect(transport.cancel(ID, FETCH_CAP, signal)).resolves.toMatchObject({ state: 'closed' })
  expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('X-Dot-Auth-Capability')).toBe(FETCH_CAP)
})
