// SPDX-License-Identifier: AGPL-3.0-only
/* Minimal reviewed port of browserXY, createKeyboardProxy's beforeinput/IME/
 * paste handling, and sendInput's visible-target gate. NO upstream transport,
 * auth, profile, tools, DOM inspection, worker, recorder, or global key capture.
 * Source: https://github.com/drscrewdriver/dsh-browser-cdp
 * Revision: da9891b9c8ee64b6c4da16d3ae654d0f1166cccd
 * src/client/index.ts lines 313-435, 1616-1667
 * Source SHA256: bdfd1e203eec23e2c365f50cbdb8227024de79c6e42c20901d2c15e56c12b675
 * LICENSE SHA256: 936deca2ff5619e507f65f2886ba48047e924fb9f1e129b42f734cee04576f90
 * Changes: typed fixed port; bounded/serialized no-retry input; reject letterbox,
 * browser shortcuts and synthetic input; component-scoped listeners; canvas only.
 *
 * MIT License
 *
 * Copyright (c) 2026 drscrewdriver
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as React from 'react'
import { Button } from '@dshfiles/plugin-ui/components/ui/button'
import { fromCallback, setup, useMachine } from '@dshfiles/plugin-ui/machine'
import { authFrameMaxBytes, authInputSchema } from './auth-protocol.js'
import type { AuthAttemptSnapshot, AuthInput, AuthInputRequest } from './auth-protocol.js'
import type { AuthViewerTransport } from './auth-viewer-transport.js'

const MAX_DIMENSION = 4096
const MAX_PIXELS = 8_000_000
const KEYS = [
  'Backspace',
  'Delete',
  'Tab',
  'Enter',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const
const SHIFT_KEYS = new Set<string>(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
type FlowEvent = { type: 'START' | 'READY' | 'CANCEL' | 'CLOSED' | 'DENIED' | 'EXPIRED' | 'FAILED' | 'UNCONFIRMED' | 'TEXT_REJECTED' | 'TEXT_ACCEPTED' }
interface ViewerPort {
  cancel(): void
}
interface InputDispatch {
  readonly id: string
  readonly capability: string
  readonly request: AuthInputRequest
}
interface ViewerInput {
  transport: AuthViewerTransport
  canvas: React.RefObject<HTMLCanvasElement | null>
  keyboard: React.RefObject<HTMLTextAreaElement | null>
  port: React.MutableRefObject<ViewerPort | null>
}

function stopEvent(state: AuthAttemptSnapshot['state']): FlowEvent {
  switch (state) {
    case 'closed':
      return { type: 'CLOSED' }
    case 'denied':
      return { type: 'DENIED' }
    case 'expired':
      return { type: 'EXPIRED' }
    case 'failed':
      return { type: 'FAILED' }
    default:
      return { type: 'UNCONFIRMED' }
  }
}
function validSize(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    width * height <= MAX_PIXELS
  )
}
function validSnapshotSize(width: number, height: number): boolean {
  return (width === 0 && height === 0) || validSize(width, height)
}

/** Private callback actor: sensitive values never enter machine/Query snapshots. */
function openViewer(input: ViewerInput, send: (event: FlowEvent) => void): () => void {
  const abort = new AbortController()
  let attempt: AuthAttemptSnapshot | undefined
  let capability: string | undefined
  let stopped = false,
    disposed = false,
    cancelling = false,
    ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inputTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let duplicateTimer: ReturnType<typeof setTimeout> | undefined
  let sequence = 0,
    inputBusy = false,
    nextInputAt = 0
  let objectUrl: string | undefined, pendingImage: HTMLImageElement | undefined
  const queue: AuthInput[] = []
  const pressed = new Set<(typeof KEYS)[number]>()
  let pointer: { x: number; y: number; button: 'left' | 'right' } | undefined
  const listeners = new AbortController()
  let composing = false
  let duplicate: { text: string; until: number } | undefined
  const canvas = input.canvas.current
  const keyboard = input.keyboard.current
  const notify = (event: FlowEvent) => {
    if (!disposed) send(event)
  }
  const clearFrame = () => {
    if (pendingImage) {
      pendingImage.onload = null
      pendingImage.onerror = null
      pendingImage.src = ''
      pendingImage = undefined
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = undefined
    }
    if (canvas) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      canvas.width = 0
      canvas.height = 0
    }
  }
  const stopLocal = () => {
    stopped = true
    ready = false
    abort.abort()
    listeners.abort()
    clearTimeout(timer)
    clearTimeout(inputTimer)
    clearTimeout(expiryTimer)
    clearTimeout(duplicateTimer)
    queue.length = 0
    pressed.clear()
    pointer = undefined
    duplicate = undefined
    composing = false
    if (keyboard) {
      keyboard.value = ''
      keyboard.blur()
    }
    clearFrame()
  }
  const requestCancel = async () => {
    if (cancelling || !attempt || !capability) return
    cancelling = true
    const cancelAbort = new AbortController()
    const deadline = setTimeout(() => cancelAbort.abort(), 3000)
    try {
      const receipt = await input.transport.cancel(attempt.id, capability, cancelAbort.signal)
      if (receipt.id !== attempt.id) {
        notify({ type: 'UNCONFIRMED' })
        return
      }
      if (receipt.state === 'closed' || receipt.state === 'expired' || receipt.state === 'denied') notify(stopEvent(receipt.state))
      else notify({ type: 'UNCONFIRMED' })
    } catch {
      notify({ type: 'UNCONFIRMED' })
    } finally {
      clearTimeout(deadline)
      capability = undefined
    }
  }
  const cancel = () => {
    stopLocal()
    if (!attempt) notify({ type: 'UNCONFIRMED' })
    void requestCancel()
  }
  input.port.current = { cancel }
  const fail = () => {
    if (stopped) return
    stopLocal()
    notify({ type: 'FAILED' })
    void requestCancel()
  }
  const usable = () => !stopped && ready && !document.hidden && !!attempt && Date.now() < attempt.expiresAt
  const drain = () => {
    if (!usable() || inputBusy || !attempt || !capability || queue.length === 0) return
    const delay = nextInputAt - Date.now()
    if (delay > 0) {
      inputTimer = setTimeout(drain, delay)
      return
    }
    const event = queue.shift()
    if (!event) return
    inputBusy = true
    const dispatch: InputDispatch = {
      id: attempt.id,
      capability,
      request: { attemptId: attempt.id, sequence: ++sequence, input: event },
    }
    void Promise.resolve()
      .then(() => {
        if (!stopped) return input.transport.input(dispatch.id, dispatch.capability, dispatch.request, abort.signal)
      })
      .then(() => {
        inputBusy = false
        nextInputAt = Date.now() + 30
        drain()
      })
      .catch(() => {
        inputBusy = false
        fail()
      })
  }
  const enqueue = (event: AuthInput) => {
    if (!usable()) return false
    if (queue.length >= 32) {
      fail()
      return false
    }
    const last = queue[queue.length - 1]
    if (event.kind === 'pointer' && event.action === 'move' && last?.kind === 'pointer' && last.action === 'move') queue[queue.length - 1] = event
    else queue.push(event)
    drain()
    return true
  }
  const text = (value: string) => {
    if (!value || !usable()) return false
    const parsed = value.length <= 4096 && authInputSchema.safeParse({ kind: 'text', text: value })
    if (!parsed || !parsed.success) {
      notify({ type: 'TEXT_REJECTED' })
      return false
    }
    const accepted = enqueue(parsed.data)
    if (accepted) notify({ type: 'TEXT_ACCEPTED' })
    return accepted
  }
  const rememberDuplicate = (value: string) => {
    clearTimeout(duplicateTimer)
    duplicate = text(value) ? { text: value, until: Date.now() + 100 } : undefined
    if (duplicate)
      duplicateTimer = setTimeout(() => {
        duplicate = undefined
      }, 100)
  }
  const point = (e: MouseEvent) => {
    if (!canvas || !attempt || !usable() || !canvas.width || !canvas.height) return undefined
    const rect = canvas.getBoundingClientRect()
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
    const width = canvas.width * scale,
      height = canvas.height * scale
    const x = e.clientX - rect.left - (rect.width - width) / 2
    const y = e.clientY - rect.top - (rect.height - height) / 2
    if (!Number.isFinite(scale) || scale <= 0 || x < 0 || y < 0 || x >= width || y >= height) return undefined
    return {
      x: Math.min(attempt.width - 1, Math.floor((x / width) * attempt.width)),
      y: Math.min(attempt.height - 1, Math.floor((y / height) * attempt.height)),
    }
  }
  const listen = <K extends keyof HTMLElementEventMap>(element: HTMLElement, kind: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    element.addEventListener(kind, fn, { signal: listeners.signal, passive: false })
  }
  if (canvas && keyboard) {
    for (const [kind, action] of [
      ['pointerdown', 'down'],
      ['pointermove', 'move'],
      ['pointerup', 'up'],
    ] as const) {
      listen(canvas, kind, e => {
        if (!e.isTrusted) return
        e.preventDefault()
        e.stopPropagation()
        if (e.ctrlKey || e.metaKey || e.altKey || (e.button !== 0 && e.button !== 2 && action !== 'move')) return
        const p = point(e) ?? (action === 'up' ? pointer : undefined)
        if (!p || (action === 'up' && !pointer)) return
        if (action === 'down') {
          pointer = { ...p, button: e.button === 2 ? 'right' : 'left' }
          keyboard.style.left = `${Math.max(0, e.clientX)}px`
          keyboard.style.top = `${Math.max(0, e.clientY)}px`
          keyboard.focus({ preventScroll: true })
          canvas.setPointerCapture?.(e.pointerId)
        } else if (pointer) pointer = { ...p, button: pointer.button }
        enqueue({ kind: 'pointer', action, x: p.x, y: p.y, button: pointer?.button ?? (e.button === 2 ? 'right' : 'left') })
        if (action === 'up') pointer = undefined
      })
    }
    listen(canvas, 'pointercancel', e => {
      if (e.isTrusted) fail()
    })
    listen(canvas, 'wheel', e => {
      if (!e.isTrusted) return
      e.preventDefault()
      e.stopPropagation()
      if (e.ctrlKey || e.metaKey || e.altKey || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY)) return
      const p = point(e)
      if (!p) return
      let unit = 1
      if (e.deltaMode === 1) unit = 16
      else if (e.deltaMode === 2) unit = attempt?.height ?? 1
      const clamp = (n: number) => Math.round(Math.max(-1000, Math.min(1000, n * unit)))
      enqueue({ kind: 'wheel', ...p, deltaX: clamp(e.deltaX), deltaY: clamp(e.deltaY) })
    })
    listen(canvas, 'contextmenu', e => {
      e.preventDefault()
    })
    listen(keyboard, 'compositionstart', e => {
      if (e.isTrusted) {
        composing = true
        e.stopPropagation()
      }
    })
    listen(keyboard, 'compositionend', e => {
      if (!e.isTrusted) return
      e.stopPropagation()
      composing = false
      rememberDuplicate(e.data)
      keyboard.value = ''
    })
    listen(keyboard, 'beforeinput', e => {
      if (!e.isTrusted) {
        e.preventDefault()
        keyboard.value = ''
        return
      }
      e.stopPropagation()
      if (composing || /Composition/u.test(e.inputType)) return
      e.preventDefault()
      if (e.inputType === 'insertText' && e.data && !(duplicate && duplicate.text === e.data && Date.now() < duplicate.until)) text(e.data)
      duplicate = undefined
      keyboard.value = ''
    })
    listen(keyboard, 'input', () => {
      if (!composing) keyboard.value = ''
    })
    listen(keyboard, 'paste', e => {
      e.preventDefault()
      e.stopPropagation()
      if (e.isTrusted) {
        const value = e.clipboardData?.getData('text/plain') ?? ''
        rememberDuplicate(value)
      }
      keyboard.value = ''
    })
    for (const kind of ['copy', 'cut', 'drop', 'dragstart'] as const)
      listen(keyboard, kind, e => {
        e.preventDefault()
        e.stopPropagation()
      })
    listen(keyboard, 'keydown', e => {
      e.stopPropagation()
      if (!e.isTrusted) {
        e.preventDefault()
        return
      }
      if (composing || e.isComposing || e.key === 'Process' || e.key === 'Dead') return
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') return // native user paste, never navigator.clipboard
      if (e.getModifierState('AltGraph') && e.key.length === 1) return
      const key = KEYS.find(key => key === e.key)
      if (e.ctrlKey || e.metaKey || e.altKey || (e.shiftKey && key !== undefined && !SHIFT_KEYS.has(key))) {
        e.preventDefault()
        return
      }
      if (!key) {
        if (e.key.length > 1) e.preventDefault()
        return
      }
      e.preventDefault()
      pressed.add(key)
      enqueue({ kind: 'key', action: 'down', key, modifiers: e.shiftKey ? 8 : 0 })
    })
    listen(keyboard, 'keyup', e => {
      e.stopPropagation()
      const key = KEYS.find(key => key === e.key)
      if (!e.isTrusted || !key || !pressed.delete(key)) return
      e.preventDefault()
      enqueue({ kind: 'key', action: 'up', key, modifiers: 0 })
    })
    listen(keyboard, 'blur', e => {
      if (!e.isTrusted) return
      for (const key of pressed) enqueue({ kind: 'key', action: 'up', key, modifiers: 0 })
      pressed.clear()
      keyboard.value = ''
      duplicate = undefined
      composing = false
    })
  }
  const terminal = (snapshot: AuthAttemptSnapshot) => {
    if (snapshot.state === 'ready' || snapshot.state === 'starting') return false
    stopLocal()
    notify(stopEvent(snapshot.state))
    return true
  }
  const paint = (frame: { bytes: Uint8Array; width: number; height: number }) =>
    new Promise<void>((resolve, reject) => {
      if (stopped || !canvas) {
        resolve()
        return
      }
      if (
        !validSize(frame.width, frame.height) ||
        frame.bytes.byteLength < 5 ||
        frame.bytes.byteLength > authFrameMaxBytes ||
        frame.bytes[0] !== 255 ||
        frame.bytes[1] !== 216 ||
        frame.bytes[2] !== 255 ||
        frame.bytes[frame.bytes.length - 2] !== 255 ||
        frame.bytes[frame.bytes.length - 1] !== 217
      ) {
        reject(new Error('Invalid raster'))
        return
      }
      const image = new Image()
      const url = URL.createObjectURL(new Blob([new Uint8Array(frame.bytes)], { type: 'image/jpeg' }))
      objectUrl = url
      pendingImage = image
      const release = () => {
        image.onload = null
        image.onerror = null
        image.src = ''
        URL.revokeObjectURL(url)
        if (objectUrl === url) objectUrl = undefined
        pendingImage = undefined
      }
      image.onload = () => {
        if (stopped) {
          release()
          resolve()
          return
        }
        if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) {
          release()
          reject(new Error('Invalid raster size'))
          return
        }
        canvas.width = frame.width
        canvas.height = frame.height
        const context = canvas.getContext('2d')
        if (!context) {
          release()
          reject(new Error('Canvas unavailable'))
          return
        }
        context.drawImage(image, 0, 0)
        release()
        resolve()
      }
      image.onerror = () => {
        release()
        reject(new Error('Invalid raster'))
      }
      image.src = url
    })
  const poll = async () => {
    if (stopped || !attempt || !capability) return
    try {
      const snapshot = await input.transport.status(attempt.id, capability, abort.signal)
      if (stopped) return
      if (snapshot.id !== attempt.id || !validSnapshotSize(snapshot.width, snapshot.height)) {
        fail()
        return
      }
      attempt = snapshot
      if (terminal(snapshot)) return
      ready = snapshot.state === 'ready'
      if (ready && !document.hidden) {
        const frame = await input.transport.frame(attempt.id, capability, abort.signal)
        if (stopped) return
        await paint(frame)
        if (!stopped) {
          attempt = { ...attempt, width: frame.width, height: frame.height }
          notify({ type: 'READY' })
        }
      }
      if (!stopped)
        timer = setTimeout(() => {
          void poll()
        }, 500)
    } catch {
      fail()
    }
  }
  void Promise.resolve()
    .then(() => input.transport.start({ acceptRisks: true }, abort.signal))
    .then(result => {
      attempt = result.attempt
      capability = result.capability
      if (stopped) {
        void requestCancel()
        return
      }
      if (!validSnapshotSize(attempt.width, attempt.height) || !Number.isFinite(attempt.expiresAt) || attempt.expiresAt <= Date.now()) {
        fail()
        return
      }
      expiryTimer = setTimeout(
        () => {
          stopLocal()
          notify({ type: 'EXPIRED' })
          void requestCancel()
        },
        Math.min(attempt.expiresAt - Date.now(), 2_147_483_647),
      )
      if (!terminal(attempt)) void poll()
    })
    .catch(() => {
      if (!stopped) fail()
      else notify({ type: 'UNCONFIRMED' })
    })
  return () => {
    disposed = true
    stopLocal()
    input.port.current = null
    void requestCancel()
  }
}

const viewerMachine = setup({
  types: {
    // SAFETY: XState setup.types is a compile-time marker; context is initialized only from the required typed machine input below.
    context: {} as ViewerInput,
    // SAFETY: XState's documented input marker does not construct a ViewerInput; useMachine supplies all required DOM refs and transport.
    input: {} as ViewerInput,
    // SAFETY: XState's documented event marker declares the closed local event union; no external value is cast to FlowEvent.
    events: {} as FlowEvent,
  },
  actors: { viewer: fromCallback<FlowEvent, ViewerInput>(({ input, sendBack }) => openViewer(input, sendBack)) },
  actions: { cancel: ({ context }) => context.port.current?.cancel() },
}).createMachine({
  id: 'dot-human-auth-viewer',
  context: ({ input }) => input,
  initial: 'consent',
  states: {
    consent: { on: { START: 'running' } },
    running: {
      invoke: { src: 'viewer', input: ({ context }) => context },
      initial: 'starting',
      states: { starting: { on: { READY: 'active' } }, active: {}, inputRejected: { on: { TEXT_ACCEPTED: 'active' } }, cancelling: {} },
      on: {
        TEXT_REJECTED: '.inputRejected',
        CANCEL: { target: '.cancelling', actions: 'cancel' },
        CLOSED: 'closed',
        DENIED: 'denied',
        EXPIRED: 'expired',
        FAILED: 'failed',
        UNCONFIRMED: 'unconfirmed',
      },
    },
    closed: {},
    denied: {},
    expired: {},
    failed: {},
    unconfirmed: {},
  },
})

/** Raster-only human surface. Composition must not give this port to an Agent. */
export function AuthViewer({ transport }: { transport: AuthViewerTransport }) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const keyboard = React.useRef<HTMLTextAreaElement>(null)
  const port = React.useRef<ViewerPort | null>(null)
  const [accepted, setAccepted] = React.useState(false)
  const [snapshot, send] = useMachine(viewerMachine, { input: { transport, canvas, keyboard, port } })
  const running = snapshot.matches('running')
  const active = snapshot.matches({ running: 'active' }) || snapshot.matches({ running: 'inputRejected' })
  const consent = snapshot.matches('consent')
  const message = (() => {
    if (snapshot.matches('denied')) return 'The provider denied this attempt. This viewer does not bypass that decision.'
    if (snapshot.matches('expired')) return 'This attempt expired. Local viewing and input have stopped.'
    if (snapshot.matches('closed')) return 'The backend acknowledged that this attempt is closed.'
    if (snapshot.matches('failed')) return 'Viewing stopped after a failure. Browser shutdown is not confirmed.'
    if (snapshot.matches('unconfirmed')) return 'Local viewing and input stopped. Backend cancellation is not confirmed.'
    if (snapshot.matches({ running: 'cancelling' })) return 'Local viewing and input stopped. Requesting backend cancellation…'
    if (snapshot.matches({ running: 'inputRejected' }))
      return 'That text exceeds the allowed size or contains unsupported control characters. Nothing was sent; edit it yourself before trying again.'
    if (active) return 'Browser available. Complete any challenge yourself; respect any provider denial. This is not a sign-in success report.'
    if (running) return 'Requesting a fresh browser. No sign-in outcome is inferred.'
    return 'No browser requested.'
  })()
  return (
    <section className="dshx-root dshx:flex dshx:min-w-0 dshx:flex-col dshx:gap-3 dshx:p-4">
      <h2 className="dshx:text-base dshx:font-semibold">Connect Dot in a fresh browser</h2>
      <p className="dshx:text-sm dshx:text-muted-foreground">
        This opens a fresh browser on the DSH host. Your mouse, keyboard and pasted text go to that browser, not to the Agent. All connected DSH browsers share
        the same owner authority. This is not confidential from software running as the same OS user or from malicious scripts in this page.
      </p>
      {consent && (
        <label className="dshx:flex dshx:items-start dshx:gap-2 dshx:text-sm">
          <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />I understand these risks and consent to starting this
          browser.
        </label>
      )}
      {consent && (
        <Button disabled={!accepted} onClick={() => send({ type: 'START' })}>
          Start browser
        </Button>
      )}
      <p role="status" className="dshx:text-sm">
        {message}
      </p>
      <canvas
        ref={canvas}
        width={0}
        height={0}
        hidden={!active}
        aria-label="Human-only sign-in browser raster"
        className="dshx:h-80 dshx:w-full dshx:touch-none dshx:object-contain dshx:bg-muted"
        onCopy={e => e.preventDefault()}
        onCut={e => e.preventDefault()}
        onDragStart={e => e.preventDefault()}
      />
      <textarea
        ref={keyboard}
        aria-label="Type into sign-in browser"
        disabled={!active}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="dshx:fixed dshx:h-px dshx:w-px dshx:resize-none dshx:border-0 dshx:p-0 dshx:opacity-0 dshx:pointer-events-none"
      />
      {active && (
        <p className="dshx:text-xs dshx:text-muted-foreground">
          Click the picture to focus browser input. Paste is input-only. Copy, browser shortcuts and DevTools are unavailable. Use the Cancel button to leave.
        </p>
      )}
      {running && (
        <Button variant="outline" disabled={snapshot.matches({ running: 'cancelling' })} onClick={() => send({ type: 'CANCEL' })}>
          Cancel browser
        </Button>
      )}
    </section>
  )
}
