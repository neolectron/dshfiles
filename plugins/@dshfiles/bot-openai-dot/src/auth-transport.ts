// SPDX-License-Identifier: AGPL-3.0-only
import type { ConnectionFetchRoute, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { JsonText } from '@dshfiles/dshx/api'
import { AuthAttemptError } from './auth-attempt.js'
import type { AuthAttemptErrorCode, AuthAttemptManager } from './auth-attempt.js'
import { authEmptyRequestSchema, authInputRequestSchema, authStartSchema, dotAuthCapabilityHeader, dotAuthRoutes } from './auth-protocol.js'
import type { AuthAttemptSnapshot, AuthStartResult } from './auth-protocol.js'

const maxBodyBytes = 8 * 1024
const privateHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
}
const errorStatus = {
  'invalid-request': 400,
  forbidden: 403,
  busy: 409,
  'not-ready': 409,
  stale: 409,
  'rate-limited': 429,
  failed: 502,
} as const
interface AuthHttpError {
  readonly error: AuthAttemptErrorCode
}
type AuthHttpResponse = AuthAttemptSnapshot | AuthStartResult | AuthHttpError
function json(value: AuthHttpResponse, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...privateHeaders, 'Content-Type': 'application/json' } })
}
function refused(status: number, error: AuthAttemptErrorCode = 'forbidden'): Response {
  return json({ error }, status)
}

/** Stream incrementally, cancelling on overflow; never aggregate an unbounded request.json(). */
async function bodyText(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const declared = request.headers.get('content-length')
  if (
    contentType !== 'application/json' ||
    request.headers.has('content-encoding') ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBodyBytes))
  )
    throw new AuthAttemptError('invalid-request')
  if (!request.body) throw new AuthAttemptError('invalid-request')
  const reader = request.body.getReader()
  const bytes = new Uint8Array(maxBodyBytes)
  let length = 0
  try {
    while (true) {
      if (request.signal.aborted) throw new AuthAttemptError('stale')
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.byteLength > maxBodyBytes - length) throw new AuthAttemptError('invalid-request')
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    // Do not wait for a hostile producer's cancel promise before returning a refusal.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * SOURCE/FIXTURE ONLY: not called by the plugin Host. Parent must prove its page-only
 * BrowserPort and native Web admission before production composition.
 * No Remote API/tools expose these routes or their private controller capability.
 */
export function registerDotAuthRoutes(
  connection: Pick<HostConnectionHandle, 'fetch' | 'admit' | 'browserPeer'>,
  manager: AuthAttemptManager,
  options: { readonly browserOrigin: string },
): () => Promise<void> {
  // The native node:http bridge uses a synthetic dsh.internal Request URL.
  // Only the composition root can supply the proved external browser origin.
  let browserUrl: URL
  try {
    browserUrl = new URL(options.browserOrigin)
    if (browserUrl.origin !== options.browserOrigin || (browserUrl.protocol !== 'http:' && browserUrl.protocol !== 'https:')) throw new Error()
  } catch {
    throw new AuthAttemptError('invalid-request')
  }
  const disposers: Array<() => Promise<void>> = []
  let disposed = false
  for (const [operation, path] of Object.entries(dotAuthRoutes)) {
    const route: ConnectionFetchRoute = {
      path,
      // The native streaming bridge always attaches a body, including empty reads;
      // Fetch Request forbids bodies on GET/HEAD. Keep every bounded operation POST.
      methods: ['POST'],
      // Native buffered mode has a much larger aggregate cap. Own the narrow cap here.
      requestBody: 'streaming',
      async fetch(request) {
        try {
          if (disposed) return refused(403)
          // Native admission performs Host/Origin and live credential checks. An API
          // owner is NOT the browser owner Peer, even with an identical principal.
          const admission = connection.admit(request)
          if ('rejection' in admission) return refused(admission.rejection)
          if (admission.peer !== connection.browserPeer) return refused(403)
          const url = new URL(request.url)
          if (request.headers.get('host')?.toLowerCase() !== browserUrl.host.toLowerCase()) return refused(403)
          const origin = request.headers.get('origin')
          if (origin !== browserUrl.origin) return refused(403)
          const site = request.headers.get('sec-fetch-site')
          if (site !== null && site !== 'same-origin') return refused(403)
          if (url.pathname !== path || url.search || url.hash || request.method !== 'POST') return refused(400, 'invalid-request')
          if (operation === 'start') {
            const parsed = JsonText.parse(await bodyText(request), authStartSchema)
            return json(manager.start(parsed))
          }
          const capability = request.headers.get(dotAuthCapabilityHeader) ?? ''
          // Authorize before reading any private operation's request body.
          manager.status(capability)
          if (operation === 'input') {
            const parsed = JsonText.parse(await bodyText(request), authInputRequestSchema)
            await manager.input(capability, parsed, request.signal)
            return json(manager.status(capability))
          }
          JsonText.parse(await bodyText(request), authEmptyRequestSchema)
          if (operation === 'status') return json(manager.status(capability))
          if (operation === 'frame') {
            const frame = await manager.frame(capability, request.signal)
            // Recheck after the await boundary before publishing private bytes.
            manager.status(capability)
            return new Response(new Uint8Array(frame.bytes), {
              headers: {
                ...privateHeaders,
                'Content-Type': 'image/jpeg',
                'Content-Length': String(frame.bytes.byteLength),
                'X-Dot-Auth-Width': String(frame.width),
                'X-Dot-Auth-Height': String(frame.height),
              },
            })
          }
          return json(await manager.cancel(capability))
        } catch (error: unknown) {
          if (error instanceof AuthAttemptError) return refused(errorStatus[error.code], error.code)
          // Includes schema/JSON/UTF-8/native/port errors. No raw body, issue, cause or input.
          return refused(400, 'invalid-request')
        }
      },
    }
    try {
      disposers.push(connection.fetch.register(route))
    } catch {
      disposed = true
      for (const dispose of disposers) void dispose().catch(() => {})
      void manager.close().catch(() => {})
      throw new AuthAttemptError('failed')
    }
  }
  return async () => {
    if (disposed) return
    disposed = true
    // manager.close synchronously revokes/aborts, before unregistering anything.
    const closing = manager.close()
    const results = await Promise.allSettled([closing, ...disposers.map(dispose => dispose())])
    if (results.some(result => result.status === 'rejected')) throw new AuthAttemptError('failed')
  }
}
