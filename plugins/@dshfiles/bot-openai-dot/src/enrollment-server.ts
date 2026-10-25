// SPDX-License-Identifier: AGPL-3.0-only
import type { BotsPrivateEndpoint } from '@dshfiles/bots/server'
import { JsonText } from '@dshfiles/dshx/api'
import { AuthAttemptError } from './auth-attempt.js'
import {
  authCompleteRequestSchema,
  authEmptyRequestSchema,
  authInputRequestSchema,
  authStartSchema,
  dotAuthCapabilityHeader,
  dotAuthRoutes,
} from './auth-protocol.js'
import type { AuthAttemptOperations } from './auth-protocol.js'

/** Same canonical operations, mounted on the already-authenticated private Node service. */
export const dotEnrollmentServiceRoutes = {
  start: `/v1/extensions${dotAuthRoutes.start}`,
  status: `/v1/extensions${dotAuthRoutes.status}`,
  frame: `/v1/extensions${dotAuthRoutes.frame}`,
  input: `/v1/extensions${dotAuthRoutes.input}`,
  cancel: `/v1/extensions${dotAuthRoutes.cancel}`,
  complete: `/v1/extensions${dotAuthRoutes.complete}`,
} as const
const privateHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' }
const statuses = { 'invalid-request': 400, forbidden: 403, busy: 409, 'not-ready': 409, stale: 409, 'rate-limited': 429, failed: 502 } as const
async function body(request: Request): Promise<string> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !request.body) throw new AuthAttemptError('invalid-request')
  const reader = request.body.getReader()
  const buffer = new Uint8Array(8192)
  let length = 0
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  request.signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      request.signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
      if (next.value.byteLength > buffer.byteLength - length) throw new AuthAttemptError('invalid-request')
      buffer.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    request.signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

/** No unauthenticated listener: Core authenticates before these exact handlers; only DSH's browser-peer proxy publishes them to humans. */
export function createDotEnrollmentEndpoints(manager: AuthAttemptOperations): readonly BotsPrivateEndpoint[] {
  return Object.entries(dotEnrollmentServiceRoutes).map(([operation, path]) => ({
    path,
    method: 'POST',
    requestHeaders: [dotAuthCapabilityHeader.toLowerCase()],
    responseHeaders: ['x-dot-auth-width', 'x-dot-auth-height'],
    handle: async request => {
      try {
        if (operation === 'start') {
          const input = JsonText.parse(await body(request), authStartSchema)
          return Response.json(await manager.start(input), { headers: privateHeaders })
        }
        const capability = request.headers.get(dotAuthCapabilityHeader) ?? ''
        await manager.status(capability)
        if (operation === 'input') {
          const input = JsonText.parse(await body(request), authInputRequestSchema)
          return Response.json(await manager.input(capability, input, request.signal), { headers: privateHeaders })
        }
        if (operation === 'complete') {
          const input = JsonText.parse(await body(request), authCompleteRequestSchema)
          return Response.json(await manager.complete(capability, input, request.signal), { headers: privateHeaders })
        }
        JsonText.parse(await body(request), authEmptyRequestSchema)
        if (operation === 'status') return Response.json(await manager.status(capability), { headers: privateHeaders })
        if (operation === 'frame') {
          const frame = await manager.frame(capability, request.signal)
          await manager.status(capability)
          return new Response(new Uint8Array(frame.bytes), {
            headers: { ...privateHeaders, 'Content-Type': 'image/jpeg', 'X-Dot-Auth-Width': String(frame.width), 'X-Dot-Auth-Height': String(frame.height) },
          })
        }
        return Response.json(await manager.cancel(capability), { headers: privateHeaders })
      } catch (error) {
        if (error instanceof AuthAttemptError) return Response.json({ error: error.code }, { status: statuses[error.code], headers: privateHeaders })
        return Response.json({ error: 'invalid-request' }, { status: 400, headers: privateHeaders })
      }
    },
  }))
}
