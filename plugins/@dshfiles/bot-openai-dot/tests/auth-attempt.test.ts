// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthAttemptManager } from '../src/auth-attempt.js'
import type { BrowserPort } from '../src/auth-attempt.js'
import { authFrameMaxBytes, authInputSchema } from '../src/auth-protocol.js'
import type { AuthInput } from '../src/auth-protocol.js'

const canary = 'SYNTHETIC_PRIVATE_AUTH_CANARY'
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(canary), 0xff, 0xd9])
const text: AuthInput = { kind: 'text', text: canary }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
const managers: AuthAttemptManager[] = []
interface FixtureManagerOptions {
  open: (signal: AbortSignal) => Promise<BrowserPort>
  ttlMs?: number
  onComplete?: (signal: AbortSignal) => Promise<void>
  completeTimeoutMs?: number
}
function fixture(options: Partial<FixtureManagerOptions> & { port?: BrowserPort } = {}) {
  const port = options.port ?? {
    frame: vi.fn(async () => ({ bytes: jpeg, width: 640, height: 480 })),
    input: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const open = options.open ?? vi.fn(async () => port)
  const managerOptions: FixtureManagerOptions = { open }
  if (options.ttlMs !== undefined) managerOptions.ttlMs = options.ttlMs
  if (options.onComplete) managerOptions.onComplete = options.onComplete
  if (options.completeTimeoutMs !== undefined) managerOptions.completeTimeoutMs = options.completeTimeoutMs
  const manager = new AuthAttemptManager(managerOptions)
  managers.push(manager)
  return { manager, port, open }
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close().catch(() => {})))
  vi.useRealTimers()
})

describe('private one-controller attempt ownership', () => {
  it('requires explicit risks, bounds TTL, starts only one, and never projects private values', async () => {
    expect(
      () =>
        new AuthAttemptManager({
          open: async () => {
            throw new Error(canary)
          },
          ttlMs: 600001,
        }),
    ).toThrow()
    const { manager, open } = fixture()
    // @ts-expect-error literal true is the public compile-time boundary too
    expect(() => manager.start({ acceptRisks: false })).toThrow()
    const started = manager.start({ acceptRisks: true })
    expect(started.attempt).toEqual({ id: expect.any(String), state: 'starting', expiresAt: expect.any(Number), width: 0, height: 0 })
    expect(started.capability).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
    const status = manager.status(started.capability)
    expect(status.state).toBe('ready')
    expect(JSON.stringify(status)).not.toContain(started.capability)
    expect(JSON.stringify(status)).not.toContain(canary)
    expect(() => manager.status('forged')).toThrow()
  })

  it('copies a bounded JPEG and rejects bad dimensions, malformed and oversize frames', async () => {
    const { manager } = fixture()
    const start = manager.start({ acceptRisks: true })
    await settle()
    const frame = await manager.frame(start.capability)
    expect(frame.bytes).toEqual(jpeg)
    expect(frame.bytes).not.toBe(jpeg)
    expect(manager.status(start.capability)).toMatchObject({ width: 640, height: 480 })
    for (const bad of [
      { bytes: new Uint8Array(authFrameMaxBytes + 1), width: 1, height: 1 },
      { bytes: new Uint8Array([1, 2, 3, 4, 5]), width: 1, height: 1 },
      { bytes: jpeg, width: 8193, height: 1 },
      { bytes: jpeg, width: 1, height: 0 },
    ]) {
      const port: BrowserPort = { frame: async () => bad, input: async () => {}, close: vi.fn(async () => {}) }
      const other = fixture({ port }).manager
      const attempt = other.start({ acceptRisks: true })
      await settle()
      await expect(other.frame(attempt.capability)).rejects.toMatchObject({ code: 'failed' })
      expect(() => other.status(attempt.capability)).toThrow()
      await settle()
      expect(port.close).toHaveBeenCalledTimes(1)
    }
  })

  it('enforces cross-attempt identity, monotonic sequence, viewport, rate and serial input with no retries', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const port: BrowserPort = {
      frame: async () => ({ bytes: jpeg, width: 640, height: 480 }),
      input: vi.fn(() => pending.promise),
      close: vi.fn(async () => {}),
    }
    const { manager } = fixture({ port })
    const start = manager.start({ acceptRisks: true })
    await settle()
    await manager.frame(start.capability)
    const request = { attemptId: start.attempt.id, sequence: 1, input: text }
    await expect(manager.input(start.capability, { ...request, attemptId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'stale' })
    await expect(
      manager.input(start.capability, { ...request, input: { kind: 'pointer', action: 'move', x: 640, y: 1, button: 'left' } }),
    ).rejects.toMatchObject({ code: 'invalid-request' })
    const first = manager.input(start.capability, request)
    await expect(manager.input(start.capability, { ...request, sequence: 2 })).rejects.toMatchObject({ code: 'busy' })
    pending.resolve()
    expect(JSON.stringify(await first)).not.toContain(canary)
    await expect(manager.input(start.capability, request)).rejects.toMatchObject({ code: 'stale' })
    await expect(manager.input(start.capability, { ...request, sequence: 2 })).rejects.toMatchObject({ code: 'rate-limited' })
    vi.advanceTimersByTime(25)
    await manager.input(start.capability, { ...request, sequence: 2 })
    expect(port.input).toHaveBeenCalledTimes(2)
  })

  it('bounds frame capture to one in flight and five per second without retries', async () => {
    vi.useFakeTimers()
    const pending = deferred<{ bytes: Uint8Array; width: number; height: number }>()
    const port: BrowserPort = { frame: vi.fn(() => pending.promise), input: async () => {}, close: async () => {} }
    const { manager } = fixture({ port })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const first = manager.frame(start.capability)
    await expect(manager.frame(start.capability)).rejects.toMatchObject({ code: 'busy' })
    pending.resolve({ bytes: jpeg, width: 1, height: 1 })
    await first
    await expect(manager.frame(start.capability)).rejects.toMatchObject({ code: 'rate-limited' })
    vi.advanceTimersByTime(200)
    await manager.frame(start.capability)
    expect(port.frame).toHaveBeenCalledTimes(2)
  })

  it('revokes and aborts before awaited close, and drops late frames and inputs', async () => {
    const closing = deferred<void>()
    const frame = deferred<{ bytes: Uint8Array; width: number; height: number }>()
    const input = deferred<void>()
    const signals: AbortSignal[] = []
    const port: BrowserPort = {
      frame: signal => {
        signals.push(signal)
        return frame.promise
      },
      input: (_value, signal) => {
        signals.push(signal)
        return input.promise
      },
      close: vi.fn(() => closing.promise),
    }
    const { manager } = fixture({ port })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const lateFrame = manager.frame(start.capability)
    const lateInput = manager.input(start.capability, { attemptId: start.attempt.id, sequence: 1, input: text })
    const cancelled = manager.cancel(start.capability)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(() => manager.status(start.capability)).toThrow()
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    frame.resolve({ bytes: jpeg, width: 640, height: 480 })
    input.resolve()
    await expect(lateFrame).rejects.toMatchObject({ code: 'stale' })
    await expect(lateInput).rejects.toMatchObject({ code: 'stale' })
    closing.resolve()
    expect(await cancelled).toMatchObject({ state: 'closed', width: 0, height: 0 })
    const fresh = manager.start({ acceptRisks: true })
    expect(fresh.attempt.id).not.toBe(start.attempt.id)
    expect(fresh.capability).not.toBe(start.capability)
    expect(() => manager.status(start.capability)).toThrow()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('closes a late opening port exactly once and blocks replacement until cleanup', async () => {
    const opening = deferred<BrowserPort>()
    const port: BrowserPort = { frame: async () => ({ bytes: jpeg, width: 1, height: 1 }), input: async () => {}, close: vi.fn(async () => {}) }
    const { manager } = fixture({ open: () => opening.promise })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const cancelled = manager.cancel(start.capability)
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    opening.resolve(port)
    await cancelled
    await manager.close()
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(() => manager.start({ acceptRisks: true })).toThrow()
  })

  it('expires even in flight, revokes before cleanup and never publishes late frame', async () => {
    vi.useFakeTimers()
    const pending = deferred<{ bytes: Uint8Array; width: number; height: number }>()
    const port: BrowserPort = { frame: () => pending.promise, input: async () => {}, close: vi.fn(async () => {}) }
    const { manager } = fixture({ port, ttlMs: 100 })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const late = manager.frame(start.capability)
    vi.advanceTimersByTime(100)
    expect(() => manager.status(start.capability)).toThrow()
    pending.resolve({ bytes: jpeg, width: 640, height: 480 })
    await expect(late).rejects.toMatchObject({ code: 'stale' })
    await settle()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('drops late input after TTL and closes without a retry', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    let inputSignal: AbortSignal | undefined
    const port: BrowserPort = {
      frame: async () => ({ bytes: jpeg, width: 1, height: 1 }),
      input: vi.fn((_input, signal) => {
        inputSignal = signal
        return pending.promise
      }),
      close: vi.fn(async () => {}),
    }
    const { manager } = fixture({ port, ttlMs: 100 })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const late = manager.input(start.capability, { attemptId: start.attempt.id, sequence: 1, input: text })
    vi.advanceTimersByTime(100)
    expect(inputSignal?.aborted).toBe(true)
    pending.resolve()
    await expect(late).rejects.toMatchObject({ code: 'stale' })
    await settle()
    expect(port.input).toHaveBeenCalledTimes(1)
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('fails permanently closed when browser cleanup cannot be confirmed, without a second open', async () => {
    const port: BrowserPort = {
      frame: async () => ({ bytes: jpeg, width: 1, height: 1 }),
      input: async () => {},
      close: vi.fn(async () => {
        throw new Error(canary)
      }),
    }
    const { manager, open } = fixture({ port })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const cancelled = manager.cancel(start.capability)
    expect(() => manager.status(start.capability)).toThrow()
    await expect(cancelled).rejects.toMatchObject({ code: 'failed', message: 'Dot authentication operation refused.' })
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    await expect(manager.close()).rejects.toMatchObject({ code: 'failed' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('sanitizes opening/input/close failures and never retries a possibly applied input', async () => {
    const openFailure = fixture({
      open: async () => {
        throw new Error(canary)
      },
    }).manager
    const first = openFailure.start({ acceptRisks: true })
    await settle()
    expect(() => openFailure.status(first.capability)).toThrow('Dot authentication operation refused.')
    const port: BrowserPort = {
      frame: async () => ({ bytes: jpeg, width: 1, height: 1 }),
      input: vi.fn(async () => {
        throw new Error(canary)
      }),
      close: vi.fn(async () => {
        throw new Error(canary)
      }),
    }
    const { manager } = fixture({ port })
    const start = manager.start({ acceptRisks: true })
    await settle()
    await expect(manager.input(start.capability, { attemptId: start.attempt.id, sequence: 1, input: text })).rejects.toMatchObject({
      code: 'failed',
      message: 'Dot authentication operation refused.',
    })
    await settle()
    expect(port.input).toHaveBeenCalledTimes(1)
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(() => manager.status(start.capability)).toThrow()
  })
})

describe('closed native input schema', () => {
  it.each([
    { kind: 'navigate', url: canary },
    { kind: 'text', text: canary, command: 'evaluate' },
    { kind: 'key', action: 'down', key: 'F12', modifiers: 0 },
    { kind: 'key', action: 'down', key: 'Tab', modifiers: 2 },
    { kind: 'key', action: 'down', key: 'Escape', modifiers: 8 },
    { kind: 'key', action: 'down', key: 'Delete', modifiers: 8 },
    { kind: 'key', action: 'down', key: 'c', modifiers: 4 },
    { kind: 'key', action: 'down', key: 'ArrowLeft', modifiers: 1 },
    { kind: 'text', text: 'x'.repeat(4097) },
    { kind: 'text', text: 'é'.repeat(2049) },
    { kind: 'text', text: '😀'.repeat(1025) },
    { kind: 'text', text: '\u001b' },
    { kind: 'pointer', action: 'move', x: -1, y: 0, button: 'left' },
    { kind: 'wheel', x: 0, y: 0, deltaX: 4097, deltaY: 0 },
  ])('rejects unsupported commands, escape chords, controls and unknown fields (%#)', input => {
    expect(authInputSchema.safeParse(input).success).toBe(false)
  })
  it('accepts only benign page inputs including shift navigation', () => {
    for (const input of [text, { kind: 'key', action: 'down', key: 'ArrowLeft', modifiers: 8 }, { kind: 'wheel', x: 1, y: 1, deltaX: -10, deltaY: 10 }]) {
      expect(authInputSchema.safeParse(input).success).toBe(true)
    }
  })
})

describe('manual browser-session completion ownership', () => {
  it('promotes through the owner callback, releases only the viewer lease and revokes capability atomically', async () => {
    let promoted = false,
      networkAlive = true
    const close = vi.fn(async () => {
      if (!promoted) networkAlive = false
    })
    const onComplete = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      promoted = true
    })
    const { manager } = fixture({ onComplete, port: { frame: async () => ({ bytes: jpeg, width: 1, height: 1 }), input: async () => {}, close } })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const receipt = await manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 })
    expect(receipt).toMatchObject({ id: start.attempt.id, state: 'completed' })
    expect(JSON.stringify(receipt)).not.toContain(start.capability)
    expect(close).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0]?.[0].aborted).toBe(true)
    expect(networkAlive).toBe(true)
    expect(() => manager.status(start.capability)).toThrow()
    await expect(manager.frame(start.capability)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 2 })).rejects.toMatchObject({ code: 'forbidden' })
    await manager.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('requires a ready attempt, exact identity, closed payload and monotonic shared input sequence', async () => {
    const opening = deferred<BrowserPort>()
    const onComplete = vi.fn(async () => {})
    const { manager, port } = fixture({ open: () => opening.promise, onComplete })
    const start = manager.start({ acceptRisks: true }),
      request = { attemptId: start.attempt.id, sequence: 2 }
    await expect(manager.complete(start.capability, request)).rejects.toMatchObject({ code: 'not-ready' })
    opening.resolve(port)
    await settle()
    await expect(manager.complete('forged', request)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(manager.complete(start.capability, { ...request, attemptId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'stale' })
    await expect(manager.complete(start.capability, { ...request, sequence: 0 })).rejects.toMatchObject({ code: 'invalid-request' })
    const extra = { ...request, credential: canary }
    await expect(manager.complete(start.capability, extra)).rejects.toMatchObject({ code: 'invalid-request' })
    await manager.input(start.capability, { ...request, input: text })
    await expect(manager.complete(start.capability, request)).rejects.toMatchObject({ code: 'stale' })
    expect(onComplete).not.toHaveBeenCalled()
    await expect(manager.complete(start.capability, { ...request, sequence: 3 })).resolves.toMatchObject({ state: 'completed' })
    const unsupported = fixture().manager,
      old = unsupported.start({ acceptRisks: true })
    await settle()
    await expect(unsupported.complete(old.capability, { attemptId: old.attempt.id, sequence: 1 })).rejects.toMatchObject({ code: 'not-ready' })
    expect(unsupported.status(old.capability).state).toBe('ready')
  })

  it('excludes concurrent frame/input/complete without retrying an owner callback', async () => {
    const capture = deferred<{ bytes: Uint8Array; width: number; height: number }>(),
      input = deferred<void>(),
      completion = deferred<void>()
    const onComplete = vi.fn(() => completion.promise)
    const { manager } = fixture({ onComplete, port: { frame: () => capture.promise, input: () => input.promise, close: async () => {} } })
    const start = manager.start({ acceptRisks: true }),
      request = { attemptId: start.attempt.id, sequence: 1 }
    await settle()
    const frame = manager.frame(start.capability)
    await expect(manager.complete(start.capability, request)).rejects.toMatchObject({ code: 'busy' })
    capture.resolve({ bytes: jpeg, width: 1, height: 1 })
    await frame
    const typing = manager.input(start.capability, { ...request, input: text })
    await expect(manager.complete(start.capability, { ...request, sequence: 2 })).rejects.toMatchObject({ code: 'busy' })
    input.resolve()
    await typing
    const done = manager.complete(start.capability, { ...request, sequence: 2 })
    await expect(manager.frame(start.capability)).rejects.toMatchObject({ code: 'busy' })
    await expect(manager.input(start.capability, { ...request, sequence: 3, input: text })).rejects.toMatchObject({ code: 'busy' })
    await expect(manager.complete(start.capability, { ...request, sequence: 3 })).rejects.toMatchObject({ code: 'busy' })
    completion.resolve()
    await done
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'ttl', 'abort', 'timeout'] as const)('fences %s and a callback that resolves after retirement', async kind => {
    vi.useFakeTimers()
    const completion = deferred<void>(),
      onComplete = vi.fn((_signal: AbortSignal) => completion.promise)
    const { manager, port } = fixture({ onComplete, ttlMs: kind === 'ttl' ? 50 : 1000, completeTimeoutMs: 100 })
    const start = manager.start({ acceptRisks: true }),
      abort = new AbortController()
    await settle()
    const pending = manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 }, abort.signal)
    const refusal = expect(pending).rejects.toMatchObject({ code: 'failed', message: 'Dot authentication operation refused.' })
    await settle()
    let cancelled: Promise<unknown> | undefined
    if (kind === 'cancel') cancelled = manager.cancel(start.capability)
    if (kind === 'ttl') vi.advanceTimersByTime(1000)
    if (kind === 'timeout') vi.advanceTimersByTime(100)
    if (kind === 'abort') abort.abort()
    await refusal
    await settle()
    expect(onComplete.mock.calls[0]?.[0].aborted).toBe(true)
    expect(() => manager.status(start.capability)).toThrow()
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    completion.resolve()
    await cancelled
    await settle()
    const fresh = manager.start({ acceptRisks: true })
    expect(fresh.attempt.id).not.toBe(start.attempt.id)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(() => manager.status(start.capability)).toThrow()
  })

  it('sanitizes completion failure, safely releases unpromoted browser and never reports completed', async () => {
    const onComplete = vi.fn(async () => {
      throw new Error(canary)
    })
    const { manager, port } = fixture({ onComplete })
    const start = manager.start({ acceptRisks: true })
    await settle()
    await expect(manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 })).rejects.toMatchObject({
      code: 'failed',
      message: 'Dot authentication operation refused.',
    })
    await settle()
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(() => manager.status(start.capability)).toThrow()
  })

  it('bounds promoted lease cleanup and never acknowledges an unconfirmed close', async () => {
    vi.useFakeTimers()
    const closing = deferred<void>()
    const { manager } = fixture({
      completeTimeoutMs: 100,
      onComplete: async () => {},
      port: { frame: async () => ({ bytes: jpeg, width: 1, height: 1 }), input: async () => {}, close: () => closing.promise },
    })
    const start = manager.start({ acceptRisks: true })
    await settle()
    const pending = manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 })
    const refusal = expect(pending).rejects.toMatchObject({ code: 'failed' })
    await settle()
    vi.advanceTimersByTime(100)
    await refusal
    expect(() => manager.status(start.capability)).toThrow()
    expect(() => manager.start({ acceptRisks: true })).toThrow()
    closing.resolve()
    await settle()
  })
})

it('never starts the completion callback after immediate cancellation and refuses a failed viewer release', async () => {
  const onComplete = vi.fn(async (_signal: AbortSignal) => {})
  const { manager } = fixture({ onComplete })
  const start = manager.start({ acceptRisks: true })
  await settle()
  const pending = manager.complete(start.capability, { attemptId: start.attempt.id, sequence: 1 })
  const refused = expect(pending).rejects.toMatchObject({ code: 'failed' })
  await manager.cancel(start.capability)
  await refused
  expect(onComplete).not.toHaveBeenCalled()
  expect(() => manager.status(start.capability)).toThrow()

  const broken = fixture({
    onComplete,
    port: {
      frame: async () => ({ bytes: jpeg, width: 1, height: 1 }),
      input: async () => {},
      close: async () => {
        throw new Error(canary)
      },
    },
  }).manager
  const other = broken.start({ acceptRisks: true })
  await settle()
  await expect(broken.complete(other.capability, { attemptId: other.attempt.id, sequence: 1 })).rejects.toMatchObject({
    code: 'failed',
    message: 'Dot authentication operation refused.',
  })
  expect(() => broken.status(other.capability)).toThrow()
  expect(() => broken.start({ acceptRisks: true })).toThrow()
})
