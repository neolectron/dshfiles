// SPDX-License-Identifier: AGPL-3.0-only
import { JsonText } from '@dshfiles/dshx/api'
import type { ZodType } from 'zod'
import {
  authAttemptSnapshotSchema,
  authStartResultSchema,
  authStartSchema,
  authInputRequestSchema,
  authEmptyRequestSchema,
  authFrameMaxBytes,
  dotAuthCapabilityHeader,
  dotAuthRoutes,
} from './auth-protocol.js'
import type { AuthAttemptSnapshot, AuthInputRequest, AuthStartInput, AuthStartResult } from './auth-protocol.js'

/** Human-view-only port. Implementations must not expose it as an Agent tool or retain input/frames. */
export interface AuthViewerTransport {
  start(consent: { acceptRisks: true }, signal: AbortSignal): Promise<AuthStartResult>
  frame(id: string, capability: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }>
  input(id: string, capability: string, request: AuthInputRequest, signal: AbortSignal): Promise<void>
  status(id: string, capability: string, signal: AbortSignal): Promise<AuthAttemptSnapshot>
  cancel(id: string, capability: string, signal: AbortSignal): Promise<AuthAttemptSnapshot>
}

/** Explicit deployment facts, NOT guessed from private Host bootstrap/Connection fields.
 * Composition supplies pageOrigin from public window.location.origin and a bound
 * native window.fetch. This source-only factory is not wired into the plugin.
 * Never substitute generic RPC: its pre-handler buffering/error echo do not meet
 * this private input channel's bounds/redaction policy.
 */
export interface AuthFetchConfiguration {
  readonly browserOrigin: string
  readonly basePath: string
  readonly pageOrigin: string
  readonly fetch: typeof globalThis.fetch
}
type AuthWireBody = AuthStartInput | AuthInputRequest | ReturnType<typeof authEmptyRequestSchema.parse>
const JSON_LIMIT = 8192
function refused(): Error {
  return new Error('The private browser request could not be completed.')
}
function abortCheck(signal: AbortSignal): void {
  if (signal.aborted) throw refused()
}
function checkedBase(config: AuthFetchConfiguration): string {
  try {
    const origin = new URL(config.browserOrigin)
    const page = new URL(config.pageOrigin)
    if (
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.origin !== config.browserOrigin ||
      page.origin !== config.pageOrigin ||
      origin.origin !== page.origin
    )
      throw refused()
    const path = config.basePath
    if (path.length > 512 || !/^\/(?:[A-Za-z0-9._~-]+\/)*$/u.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw refused()
    return `${origin.origin}${path.slice(0, -1)}`
  } catch {
    throw refused()
  }
}
async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  abortCheck(signal)
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {})
    throw refused()
  }
  if (!response.body) throw refused()
  const reader = response.body.getReader()
  const bytes = new Uint8Array(limit)
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      abortCheck(signal)
      const part = await reader.read()
      abortCheck(signal)
      if (part.done) return bytes.slice(0, length)
      if (part.value.byteLength > limit - length) throw refused()
      bytes.set(part.value, length)
      length += part.value.byteLength
    }
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function jpegSize(bytes: Uint8Array) {
  if (bytes.length < 5 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw refused()
  let offset = 2
  while (offset < bytes.length - 1) {
    if (bytes[offset++] !== 255) throw refused()
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 218) throw refused()
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    const length = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
    if (length < 2 || offset + length > bytes.length) throw refused()
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) throw refused()
      const height = (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0)
      const width = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0)
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_000_000) throw refused()
      return { width, height }
    }
    offset += length
  }
  throw refused()
}

/** Private, fixed-route HTTP only. Capability travels in a header, never a URL.
 * Explicit trusted basePath preserves mounted deployments without private APIs.
 * No cache, persistent storage, retry, logging, tool, generic URL or input export.
 */
export function createAuthFetchTransport(configuration: AuthFetchConfiguration): AuthViewerTransport {
  const base = checkedBase(configuration)
  const nativeFetch = configuration.fetch
  let binding: { id: string; capability: string } | undefined
  let starting = false
  const authorize = (id: string, capability: string) => {
    if (!binding || binding.id !== id || binding.capability !== capability) throw refused()
  }
  const request = async (operation: keyof typeof dotAuthRoutes, signal: AbortSignal, body: AuthWireBody, capability?: string): Promise<Response> => {
    abortCheck(signal)
    const headers = new Headers({ Accept: operation === 'frame' ? 'image/jpeg' : 'application/json', 'Cache-Control': 'no-store' })
    if (capability !== undefined) {
      if (!authStartResultSchema.shape.capability.safeParse(capability).success) throw refused()
      headers.set(dotAuthCapabilityHeader, capability)
    }
    const encoded = JSON.stringify(body)
    if (new TextEncoder().encode(encoded).byteLength > JSON_LIMIT) throw refused()
    headers.set('Content-Type', 'application/json')
    // Every operation is POST: the native streaming bridge supplies a body even
    // for status/frame, which the platform Request constructor forbids with GET.
    const init: RequestInit = {
      method: 'POST',
      body: encoded,
      headers,
      signal,
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }
    const response = await nativeFetch(`${base}${dotAuthRoutes[operation]}`, init)
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {})
      throw refused()
    }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {})
      throw refused()
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (mime !== (operation === 'frame' ? 'image/jpeg' : 'application/json')) {
      void response.body?.cancel().catch(() => {})
      throw refused()
    }
    return response
  }
  const json = async <T>(
    operation: keyof typeof dotAuthRoutes,
    schema: ZodType<T>,
    signal: AbortSignal,
    body: AuthWireBody,
    capability?: string,
  ): Promise<T> => {
    const response = await request(operation, signal, body, capability)
    const bytes = await boundedBytes(response, JSON_LIMIT, signal)
    return JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), schema)
  }
  const bound = (id: string, snapshot: AuthAttemptSnapshot): AuthAttemptSnapshot => {
    if (snapshot.id !== id) throw refused()
    return snapshot
  }
  const protect = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch {
      throw refused()
    }
  }
  return {
    start: (consent, signal) =>
      protect(async () => {
        const parsed = authStartSchema.safeParse(consent)
        if (!parsed.success || starting || binding) throw refused()
        starting = true
        try {
          const result = await json('start', authStartResultSchema, signal, parsed.data)
          binding = { id: result.attempt.id, capability: result.capability }
          return result
        } finally {
          starting = false
        }
      }),
    status: (id, cap, signal) =>
      protect(async () => {
        authorize(id, cap)
        return bound(id, await json('status', authAttemptSnapshotSchema, signal, {}, cap))
      }),
    cancel: (id, cap, signal) =>
      protect(async () => {
        authorize(id, cap)
        try {
          return bound(id, await json('cancel', authAttemptSnapshotSchema, signal, {}, cap))
        } finally {
          binding = undefined
        }
      }),
    input: (id, cap, input, signal) =>
      protect(async () => {
        authorize(id, cap)
        const parsed = authInputRequestSchema.safeParse(input)
        if (!parsed.success || parsed.data.attemptId !== id) throw refused()
        bound(id, await json('input', authAttemptSnapshotSchema, signal, parsed.data, cap))
      }),
    frame: (id, cap, signal) =>
      protect(async () => {
        authorize(id, cap)
        const response = await request('frame', signal, {}, cap)
        const bytes = await boundedBytes(response, authFrameMaxBytes, signal)
        const size = jpegSize(bytes)
        if (String(size.width) !== response.headers.get('x-dot-auth-width') || String(size.height) !== response.headers.get('x-dot-auth-height'))
          throw refused()
        return { bytes, ...size }
      }),
  }
}
