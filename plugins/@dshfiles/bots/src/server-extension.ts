import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { BotsPrivateEndpoint } from './server.js'
const privateRequestHeaderSchema = z.string().max(8192)
const maxResponseBytes = 1024 * 1024
const permittedHeader = (name: string): boolean => /^x-[a-z0-9-]{1,60}$/u.test(name) && !name.startsWith('x-forwarded-')
const invalid = (): never => {
  throw new Error('Invalid private Bots endpoint configuration.')
}

/** Checked before the Node composition touches storage, then copied so caller mutations cannot change admission. */
function validatePrivateEndpoints(endpoints: readonly BotsPrivateEndpoint[] = []): void {
  if (endpoints.length > 32) invalid()
  const paths = new Set<string>()
  for (const endpoint of endpoints) {
    if (!/^\/v1\/extensions\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*$/u.test(endpoint.path) || endpoint.path.length > 256 || paths.has(endpoint.path)) invalid()
    // oxlint-disable-next-line antislop/no-runtime-typeof -- This is a trusted programmatic function port, not JSON data; fail JS callers before opening storage if it is not callable.
    if ((endpoint.method !== 'GET' && endpoint.method !== 'POST') || typeof endpoint.handle !== 'function') invalid()
    paths.add(endpoint.path)
    for (const names of [endpoint.requestHeaders ?? [], endpoint.responseHeaders ?? []]) {
      if (names.length > 8 || new Set(names).size !== names.length || names.some(name => !permittedHeader(name))) invalid()
    }
  }
}

function cancelled(signal: AbortSignal) {
  let rejectAbort: (reason: Error) => void = () => undefined
  const pending = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const abort = (): void => rejectAbort(new Error('Private endpoint request canceled.'))
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return { pending, release: () => signal.removeEventListener('abort', abort) }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (response.headers.has('content-encoding') || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxResponseBytes))) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('Invalid private endpoint response.')
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const abort = cancelled(signal)
  const buffer = new Uint8Array(maxResponseBytes)
  let length = 0
  try {
    while (true) {
      const part = await Promise.race([reader.read(), abort.pending])
      if (part.done) break
      if (part.value.byteLength > buffer.byteLength - length) throw new Error('Private endpoint response exceeds its bound.')
      buffer.set(part.value, length)
      length += part.value.byteLength
    }
    signal.throwIfAborted()
    return buffer.slice(0, length)
  } finally {
    abort.release()
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** No provider knowledge: registration is exact, authenticated outside this dispatcher, and output is finite/private. */
function privateEndpointMap(endpoints: readonly BotsPrivateEndpoint[] = []): ReadonlyMap<string, BotsPrivateEndpoint> {
  validatePrivateEndpoints(endpoints)
  return new Map(
    endpoints.map(endpoint => [
      endpoint.path,
      Object.freeze({
        path: endpoint.path,
        method: endpoint.method,
        requestHeaders: Object.freeze([...(endpoint.requestHeaders ?? [])]),
        responseHeaders: Object.freeze([...(endpoint.responseHeaders ?? [])]),
        handle: endpoint.handle,
      }),
    ]),
  )
}

async function servePrivateEndpoint(
  endpoint: BotsPrivateEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  body: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers()
  if (body !== undefined) headers.set('content-type', 'application/json')
  for (const name of endpoint.requestHeaders ?? []) {
    const value = privateRequestHeaderSchema.safeParse(request.headers[name])
    if (value.success) headers.set(name, value.data)
  }
  // Never forward the control-service bearer, ambient cookies, Origin, Host or proxy headers to extensions.
  const init: RequestInit = { method: endpoint.method, headers, signal }
  if (body !== undefined) init.body = body
  const input = new Request(`http://bots.internal${endpoint.path}`, init)
  const abort = cancelled(signal)
  const operation = Promise.resolve().then(() => endpoint.handle(input))
  void operation.then(
    result => {
      if (signal.aborted) void result.body?.cancel().catch(() => undefined)
    },
    () => undefined,
  )
  try {
    const result = await Promise.race([operation, abort.pending])
    if (![200, 400, 401, 403, 404, 409, 429, 500, 502, 503].includes(result.status)) {
      void result.body?.cancel().catch(() => undefined)
      throw new Error('Unsupported private endpoint response.')
    }
    const type = result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/json' && type !== 'image/jpeg' && type !== 'image/png') {
      void result.body?.cancel().catch(() => undefined)
      throw new Error('Unsupported private endpoint response.')
    }
    const output = await boundedBody(result, signal)
    const outgoing: OutgoingHttpHeaders = {
      'content-type': type,
      'content-length': String(output.byteLength),
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    }
    for (const name of endpoint.responseHeaders ?? []) {
      const value = result.headers.get(name)
      if (value === null) continue
      if (value.length > 256 || /[^\x20-\x7e]/u.test(value)) throw new Error('Invalid private endpoint response header.')
      outgoing[name] = value
    }
    signal.throwIfAborted()
    if (response.destroyed || response.writableEnded) return
    response.writeHead(result.status, outgoing)
    response.end(output)
  } finally {
    abort.release()
  }
}

/** Cohesive internal transport boundary; the public server exports only the endpoint port. */
export class BotsPrivateEndpoints {
  static readonly validate = validatePrivateEndpoints
  static readonly map = privateEndpointMap
  static readonly serve = servePrivateEndpoint
}
