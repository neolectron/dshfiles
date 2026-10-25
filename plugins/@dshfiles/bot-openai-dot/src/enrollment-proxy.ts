// SPDX-License-Identifier: AGPL-3.0-only
import { timingSafeEqual } from 'node:crypto'
import { z, type ZodType } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { AuthAttemptError } from './auth-attempt.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'
import { DotAccountAuthorityProtocol } from './account-authority-contract.js'
import {
  authAttemptSnapshotSchema,
  authCompleteRequestSchema,
  authEmptyRequestSchema,
  authInputRequestSchema,
  authStartResultSchema,
  authStartSchema,
  authFrameMaxBytes,
  dotAuthCapabilityHeader,
} from './auth-protocol.js'
import type { AuthAttemptOperations, AuthAttemptSnapshot, AuthCompleteRequest, AuthInputRequest, AuthStartInput, AuthStartResult } from './auth-protocol.js'
import { dotEnrollmentServiceRoutes } from './enrollment-server.js'

type Operation = keyof typeof dotEnrollmentServiceRoutes
type WireBody = AuthStartInput | AuthInputRequest | AuthCompleteRequest | z.infer<typeof authEmptyRequestSchema>
interface StartingController {
  readonly phase: 'starting'
  admission: 'not-dispatched' | 'pending' | 'refused'
}
type OwnedController = StartingController | { readonly phase: 'uncertain' } | { readonly phase: 'active' | 'retiring'; readonly grant: AuthStartResult }
const terminalStates = new Set<AuthAttemptSnapshot['state']>(['closed', 'expired', 'failed', 'denied', 'completed'])
export interface DotEnrollmentProxyOptions {
  readonly origin: string
  readonly resolveBearerToken: (signal: AbortSignal) => Promise<string | undefined>
  readonly fetch?: typeof globalThis.fetch
}
const failed = (): AuthAttemptError => new AuthAttemptError('failed')
const dimensions = z.coerce.number().int().min(1).max(4096)

/** Raw service credentials and controller capabilities live only in this backend closure; never RPC/tools. */
export function createDotEnrollmentProxy(options: DotEnrollmentProxyOptions): AuthAttemptOperations {
  const origin = parseAccountAuthorityOrigin(options.origin).origin
  const nativeFetch = options.fetch ?? globalThis.fetch
  const lifetime = new AbortController()
  let controller: OwnedController | undefined
  let closed = false
  let closing: Promise<void> | undefined
  const authorize = (capability: string, purpose: 'input' | 'cleanup' = 'input'): AuthStartResult => {
    if (closed || controller === undefined || (controller.phase !== 'active' && controller.phase !== 'retiring')) throw new AuthAttemptError('forbidden')
    if (purpose === 'input' && controller.phase !== 'active') throw new AuthAttemptError('forbidden')
    if (
      !authStartResultSchema.shape.capability.safeParse(capability).success ||
      !timingSafeEqual(Buffer.from(capability), Buffer.from(controller.grant.capability))
    )
      throw new AuthAttemptError('forbidden')
    return controller.grant
  }
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(16000), ...(signal === undefined ? [] : [signal])])
  const exchange = async (
    operation: Operation,
    body: WireBody,
    capability: string | undefined,
    signal: AbortSignal,
    admission?: StartingController,
  ): Promise<Response> => {
    let onAbort: () => void = () => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(failed())
    })
    if (signal.aborted) throw failed()
    signal.addEventListener('abort', onAbort, { once: true })
    const run = (async () => {
      const resolved = await options.resolveBearerToken(signal)
      signal.throwIfAborted()
      const bearer = DotAccountAuthorityProtocol.bearer.parse(resolved)
      const encoded = JSON.stringify(body)
      if (Buffer.byteLength(encoded) > 8192) throw failed()
      const headers = new Headers({
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: operation === 'frame' ? 'image/jpeg' : 'application/json',
      })
      if (capability !== undefined) headers.set(dotAuthCapabilityHeader, capability)
      if (admission !== undefined) admission.admission = 'pending'
      const response = await nativeFetch(`${origin}${dotEnrollmentServiceRoutes[operation]}`, {
        method: 'POST',
        headers,
        body: encoded,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      })
      // The pinned control service rejects these statuses before start admission; transport loss/200 parse failure remains uncertain.
      if (admission !== undefined && !signal.aborted && !response.redirected && [400, 401, 403, 409, 413, 415, 429].includes(response.status))
        admission.admission = 'refused'
      if (
        signal.aborted ||
        response.redirected ||
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== (operation === 'frame' ? 'image/jpeg' : 'application/json')
      ) {
        void response.body?.cancel().catch(() => undefined)
        throw failed()
      }
      return response
    })()
    void run.then(
      response => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined)
      },
      () => undefined,
    )
    try {
      return await Promise.race([run, aborted])
    } catch {
      throw failed()
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const bytes = async (response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> => {
    const declared = response.headers.get('content-length')
    if (response.headers.has('content-encoding') || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) || !response.body) {
      void response.body?.cancel().catch(() => undefined)
      throw failed()
    }
    const reader = response.body.getReader()
    const buffer = new Uint8Array(limit)
    let length = 0
    let rejectAbort: () => void = () => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(failed())
    })
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined)
      throw failed()
    }
    signal.addEventListener('abort', rejectAbort, { once: true })
    try {
      while (true) {
        const part = await Promise.race([reader.read(), aborted])
        if (part.done) {
          signal.throwIfAborted()
          return buffer.slice(0, length)
        }
        if (part.value.byteLength > limit - length) throw failed()
        buffer.set(part.value, length)
        length += part.value.byteLength
      }
    } catch {
      throw failed()
    } finally {
      signal.removeEventListener('abort', rejectAbort)
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  const json = async <T>(
    operation: Operation,
    body: WireBody,
    capability: string | undefined,
    schema: ZodType<T>,
    signal: AbortSignal,
    admission?: StartingController,
  ): Promise<T> => {
    const response = await exchange(operation, body, capability, signal, admission)
    try {
      return JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytes(response, 8192, signal)), schema)
    } catch {
      throw failed()
    }
  }
  const bound = (expected: AuthStartResult, snapshot: AuthAttemptSnapshot): AuthAttemptSnapshot => {
    if (snapshot.id !== expected.attempt.id) throw failed()
    return snapshot
  }
  const terminal = (expected: AuthStartResult, snapshot: AuthAttemptSnapshot): AuthAttemptSnapshot => {
    const receipt = bound(expected, snapshot)
    if (!terminalStates.has(receipt.state)) throw failed()
    if (controller !== undefined && (controller.phase === 'active' || controller.phase === 'retiring') && controller.grant === expected) controller = undefined
    return receipt
  }
  return {
    start: async input => {
      const parsed = authStartSchema.safeParse(input)
      if (closed || controller !== undefined) throw new AuthAttemptError('busy')
      if (!parsed.success) throw new AuthAttemptError('invalid-request')
      const pending: StartingController = { phase: 'starting', admission: 'not-dispatched' }
      controller = pending
      try {
        const result = await json('start', parsed.data, undefined, authStartResultSchema, signalFor(), pending)
        if (closed || controller !== pending) throw failed()
        controller = { phase: 'active', grant: result }
        return result
      } catch {
        if (controller === pending) controller = pending.admission === 'pending' ? { phase: 'uncertain' } : undefined
        throw failed()
      }
    },
    status: async capability => {
      const expected = authorize(capability, 'cleanup')
      return bound(expected, await json('status', {}, capability, authAttemptSnapshotSchema, signalFor()))
    },
    frame: async (capability, signal) => {
      const expected = authorize(capability)
      const activeSignal = signalFor(signal)
      const response = await exchange('frame', {}, capability, activeSignal)
      const parsedWidth = dimensions.safeParse(response.headers.get('x-dot-auth-width'))
      const parsedHeight = dimensions.safeParse(response.headers.get('x-dot-auth-height'))
      if (!parsedWidth.success || !parsedHeight.success || parsedWidth.data * parsedHeight.data > 8_000_000) {
        void response.body?.cancel().catch(() => undefined)
        throw failed()
      }
      const width = parsedWidth.data
      const height = parsedHeight.data
      const frame = await bytes(response, authFrameMaxBytes, activeSignal)
      if (authorize(capability).attempt.id !== expected.attempt.id) throw failed()
      return { bytes: frame, width, height }
    },
    input: async (capability, input, signal) => {
      const expected = authorize(capability)
      const parsed = authInputRequestSchema.safeParse(input)
      if (!parsed.success || parsed.data.attemptId !== expected.attempt.id) throw new AuthAttemptError('invalid-request')
      return bound(expected, await json('input', parsed.data, capability, authAttemptSnapshotSchema, signalFor(signal)))
    },
    complete: async (capability, input, signal) => {
      const expected = authorize(capability)
      const parsed = authCompleteRequestSchema.safeParse(input)
      if (!parsed.success || parsed.data.attemptId !== expected.attempt.id) throw new AuthAttemptError('invalid-request')
      controller = { phase: 'retiring', grant: expected }
      const result = terminal(expected, await json('complete', parsed.data, capability, authAttemptSnapshotSchema, signalFor(signal)))
      if (result.state !== 'completed') throw failed()
      return result
    },
    cancel: async capability => {
      const expected = authorize(capability, 'cleanup')
      controller = { phase: 'retiring', grant: expected }
      return terminal(expected, await json('cancel', {}, capability, authAttemptSnapshotSchema, signalFor()))
    },
    close: () => {
      closing ??= (async () => {
        // oxlint-disable-next-line antislop/no-passthrough-variable -- Snapshot ownership before aborting I/O; late settlement cannot erase a pending remote cleanup obligation.
        const owned = controller
        closed = true
        lifetime.abort()
        if (owned === undefined) return
        if (owned.phase === 'uncertain' || (owned.phase === 'starting' && owned.admission === 'pending')) throw failed()
        if (owned.phase === 'starting') {
          controller = undefined
          return
        }
        const receipt = await json('cancel', {}, owned.grant.capability, authAttemptSnapshotSchema, AbortSignal.timeout(5000))
        terminal(owned.grant, receipt)
      })()
      return closing
    },
  }
}
