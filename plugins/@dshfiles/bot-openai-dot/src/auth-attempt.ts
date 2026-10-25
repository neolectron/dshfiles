// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { authCompleteRequestSchema, authFrameMaxBytes, authInputRequestSchema, authStartSchema } from './auth-protocol.js'
import type {
  AuthAttemptOperations,
  AuthAttemptSnapshot,
  AuthCompleteRequest,
  AuthInput,
  AuthInputRequest,
  AuthStartInput,
  AuthStartResult,
} from './auth-protocol.js'

/** Injected page-only I/O. This module cannot launch, navigate or address a browser. */
export interface BrowserPort {
  frame(signal: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }>
  input(input: AuthInput, signal: AbortSignal): Promise<void>
  /** Releases this viewer lease; a promoted network session remains driver-owned. */
  close(): Promise<void>
}
export type AuthAttemptErrorCode = 'invalid-request' | 'forbidden' | 'busy' | 'not-ready' | 'stale' | 'rate-limited' | 'failed'
/** Fixed public failures only; never attach browser errors, input, causes or validation issues. */
export class AuthAttemptError extends Error {
  constructor(readonly code: AuthAttemptErrorCode) {
    super('Dot authentication operation refused.')
    this.name = 'AuthAttemptError'
  }
}
interface Attempt {
  readonly id: string
  readonly generation: number
  readonly expiresAt: number
  readonly controller: AbortController
  capability: string | undefined
  state: AuthAttemptSnapshot['state']
  width: number
  height: number
  sequence: number
  lastInputAt: number
  lastFrameAt: number
  inputBusy: boolean
  frameBusy: boolean
  completeBusy: boolean
  completion: Promise<void> | undefined
  opening: Promise<BrowserPort | undefined>
  port: BrowserPort | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  closing: Promise<void> | undefined
  cleanupPending: boolean
}
export interface AuthAttemptOptions {
  readonly open: (signal: AbortSignal) => Promise<BrowserPort>
  /** Must fence promotion on signal abortion; never copy cookies between owners. */
  readonly onComplete?: (signal: AbortSignal) => Promise<void>
  readonly completeTimeoutMs?: number
  readonly now?: () => number
  readonly ttlMs?: number
}

/** One ephemeral controller; no persisted input, credentials, frames or reconnect/takeover path. */
export class AuthAttemptManager implements AuthAttemptOperations {
  private current: Attempt | undefined
  private generation = 0
  private disposed = false
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly completeTimeoutMs: number

  constructor(private readonly options: AuthAttemptOptions) {
    const timeout = options.completeTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new AuthAttemptError('invalid-request')
    this.completeTimeoutMs = timeout
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 10 * 60 * 1000) throw new AuthAttemptError('invalid-request')
  }

  start(input: AuthStartInput): AuthStartResult {
    if (!authStartSchema.safeParse(input).success) throw new AuthAttemptError('invalid-request')
    if (this.disposed) throw new AuthAttemptError('forbidden')
    this.expire()
    if (this.current && (this.active(this.current) || this.current.cleanupPending)) throw new AuthAttemptError('busy')
    const capability = randomBytes(32).toString('base64url')
    const attempt: Attempt = {
      id: randomUUID(),
      generation: ++this.generation,
      capability,
      state: 'starting',
      expiresAt: this.now() + this.ttlMs,
      width: 0,
      height: 0,
      sequence: 0,
      lastInputAt: -Infinity,
      lastFrameAt: -Infinity,
      inputBusy: false,
      frameBusy: false,
      completeBusy: false,
      completion: undefined,
      controller: new AbortController(),
      port: undefined,
      timer: undefined,
      opening: Promise.resolve(undefined),
      closing: undefined,
      cleanupPending: false,
    }
    this.current = attempt
    attempt.opening = Promise.resolve()
      .then(() => {
        if (!this.active(attempt)) return undefined
        return this.options.open(attempt.controller.signal)
      })
      .then(port => {
        this.expire()
        if (port && this.active(attempt)) {
          attempt.port = port
          attempt.state = 'ready'
        }
        return port
      })
      .catch(() => {
        if (this.active(attempt)) void this.terminate(attempt, 'failed').catch(() => {})
        return undefined
      })
    attempt.timer = setTimeout(() => this.expire(), this.ttlMs)
    attempt.timer.unref?.()
    return { attempt: this.snapshot(attempt), capability }
  }

  status(capability: string): AuthAttemptSnapshot {
    return this.snapshot(this.authorize(capability))
  }

  async frame(capability: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const attempt = this.authorize(capability)
    const port = this.ready(attempt)
    if (attempt.completeBusy || attempt.frameBusy) throw new AuthAttemptError('busy')
    if (signal?.aborted) throw new AuthAttemptError('stale')
    if (this.now() - attempt.lastFrameAt < 200) throw new AuthAttemptError('rate-limited')
    attempt.frameBusy = true
    attempt.lastFrameAt = this.now()
    try {
      const result = await port.frame(this.signal(attempt, signal))
      this.assertCurrent(attempt, signal)
      const { bytes, width, height } = result
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 5 ||
        bytes.byteLength > authFrameMaxBytes ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9 ||
        !Number.isInteger(width) ||
        width < 1 ||
        width > 8192 ||
        !Number.isInteger(height) ||
        height < 1 ||
        height > 8192
      ) {
        throw new AuthAttemptError('failed')
      }
      // Copy before publishing: the port cannot mutate a response after validation.
      const copy = new Uint8Array(bytes)
      attempt.width = width
      attempt.height = height
      return { bytes: copy, width, height }
    } catch {
      if (!this.active(attempt) || signal?.aborted) throw new AuthAttemptError('stale')
      void this.terminate(attempt, 'failed').catch(() => {})
      throw new AuthAttemptError('failed')
    } finally {
      attempt.frameBusy = false
    }
  }

  async input(capability: string, request: AuthInputRequest, signal?: AbortSignal): Promise<AuthAttemptSnapshot> {
    const attempt = this.authorize(capability)
    const parsed = authInputRequestSchema.safeParse(request)
    if (!parsed.success) throw new AuthAttemptError('invalid-request')
    const { attemptId, sequence, input } = parsed.data
    if (attemptId !== attempt.id || sequence <= attempt.sequence) throw new AuthAttemptError('stale')
    const port = this.ready(attempt)
    if (input.kind === 'pointer' || input.kind === 'wheel') {
      if (input.x >= attempt.width || input.y >= attempt.height) throw new AuthAttemptError('invalid-request')
    }
    if (signal?.aborted) throw new AuthAttemptError('stale')
    if (attempt.completeBusy || attempt.inputBusy) throw new AuthAttemptError('busy')
    if (this.now() - attempt.lastInputAt < 25) throw new AuthAttemptError('rate-limited')
    attempt.inputBusy = true
    attempt.sequence = sequence
    attempt.lastInputAt = this.now()
    try {
      await port.input(input, this.signal(attempt, signal))
      this.assertCurrent(attempt, signal)
      return this.snapshot(attempt)
    } catch {
      if (!this.active(attempt)) throw new AuthAttemptError('stale')
      // Input might already have taken effect: close instead of retrying or accepting more input.
      void this.terminate(attempt, 'failed').catch(() => {})
      throw new AuthAttemptError('failed')
    } finally {
      attempt.inputBusy = false
    }
  }

  async complete(capability: string, request: AuthCompleteRequest, signal?: AbortSignal): Promise<AuthAttemptSnapshot> {
    const attempt = this.authorize(capability)
    const parsed = authCompleteRequestSchema.safeParse(request)
    if (!parsed.success) throw new AuthAttemptError('invalid-request')
    if (parsed.data.attemptId !== attempt.id || parsed.data.sequence <= attempt.sequence) throw new AuthAttemptError('stale')
    this.ready(attempt)
    const onComplete = this.options.onComplete
    if (!onComplete) throw new AuthAttemptError('not-ready')
    if (attempt.completeBusy || attempt.inputBusy || attempt.frameBusy) throw new AuthAttemptError('busy')
    if (signal?.aborted) throw new AuthAttemptError('stale')
    attempt.completeBusy = true
    attempt.sequence = parsed.data.sequence
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.completeTimeoutMs)
    const operationSignal = AbortSignal.any([this.signal(attempt, signal), deadline.signal])
    let removeAbort = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      const refuse = () => reject(new AuthAttemptError('stale'))
      operationSignal.addEventListener('abort', refuse, { once: true })
      removeAbort = () => operationSignal.removeEventListener('abort', refuse)
      if (operationSignal.aborted) refuse()
    })
    attempt.completion = Promise.resolve().then(() => {
      this.assertCurrent(attempt, operationSignal)
      return onComplete(operationSignal)
    })
    try {
      await Promise.race([attempt.completion, aborted])
      this.assertCurrent(attempt, operationSignal)
      // Promotion is now driver-owned; retiring the human lease must not close it.
      const closing = this.terminate(attempt, 'completed')
      // terminate aborts the attempt signal intentionally; only bound lease cleanup here.
      const cleanupDeadline = new Promise<never>((_resolve, reject) => {
        const refuse = () => reject(new AuthAttemptError('failed'))
        deadline.signal.addEventListener('abort', refuse, { once: true })
        void closing.finally(() => deadline.signal.removeEventListener('abort', refuse)).catch(() => {})
      })
      await Promise.race([closing, cleanupDeadline])
      return this.snapshot(attempt)
    } catch {
      if (this.active(attempt)) void this.terminate(attempt, 'failed').catch(() => {})
      throw new AuthAttemptError('failed')
    } finally {
      clearTimeout(timer)
      removeAbort()
    }
  }

  async cancel(capability: string): Promise<AuthAttemptSnapshot> {
    const attempt = this.authorize(capability)
    const closing = this.terminate(attempt, 'closed')
    const snapshot = this.snapshot(attempt)
    await closing
    return snapshot
  }

  /** Owning plugin disposal. Also closes a port that resolves after cancellation. */
  async close(): Promise<void> {
    this.disposed = true
    const attempt = this.current
    if (attempt) await this.terminate(attempt, 'closed')
  }

  private active(attempt: Attempt): boolean {
    return this.current === attempt && this.generation === attempt.generation && (attempt.state === 'starting' || attempt.state === 'ready')
  }
  private expire(): void {
    const attempt = this.current
    if (attempt && this.active(attempt) && this.now() >= attempt.expiresAt) void this.terminate(attempt, 'expired').catch(() => {})
  }
  private authorize(capability: string): Attempt {
    this.expire()
    const attempt = this.current
    if (
      !attempt ||
      !this.active(attempt) ||
      !attempt.capability ||
      !/^[A-Za-z0-9_-]{43}$/u.test(capability) ||
      !timingSafeEqual(Buffer.from(capability), Buffer.from(attempt.capability))
    )
      throw new AuthAttemptError('forbidden')
    return attempt
  }
  private ready(attempt: Attempt): BrowserPort {
    if (attempt.state !== 'ready' || !attempt.port) throw new AuthAttemptError('not-ready')
    return attempt.port
  }
  private assertCurrent(attempt: Attempt, signal?: AbortSignal): void {
    this.expire()
    if (!this.active(attempt) || signal?.aborted) throw new AuthAttemptError('stale')
  }
  private signal(attempt: Attempt, signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([attempt.controller.signal, signal]) : attempt.controller.signal
  }
  private terminate(attempt: Attempt, state: 'closed' | 'expired' | 'failed' | 'completed'): Promise<void> {
    if (attempt.closing) return attempt.closing
    // Revoke BEFORE invoking or awaiting any external close work.
    attempt.capability = undefined
    attempt.state = state
    attempt.controller.abort()
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.timer = undefined
    attempt.cleanupPending = true
    attempt.closing = attempt.opening
      .then(async port => {
        if (port) await port.close()
        // A late callback must settle before a replacement can own a browser.
        await attempt.completion?.catch(() => {})
        // Only positive quiescence permits another browser to be opened.
        attempt.port = undefined
        attempt.cleanupPending = false
      })
      .catch(() => {
        attempt.state = 'failed'
        // Keep cleanupPending permanently true: an unconfirmed browser may still live.
        // Never retry close, acknowledge cancellation, or open a replacement silently.
        throw new AuthAttemptError('failed')
      })
    return attempt.closing
  }
  private snapshot(attempt: Attempt): AuthAttemptSnapshot {
    return { id: attempt.id, state: attempt.state, expiresAt: attempt.expiresAt, width: attempt.width, height: attempt.height }
  }
}
