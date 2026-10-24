import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { JsonText, PluginApiError, type ApiMethodDefinition } from '@dshfiles/dshx/api'
import { z } from 'zod'
import { botsApi } from './api.js'
import { BotsEngine, type BotsEngineOptions } from './engine.js'

const rawJsonSchema = z.json()
type RawJson = z.infer<typeof rawJsonSchema>
type FailureCode =
  | 'bad-request'
  | 'unauthorized'
  | 'not-found'
  | 'method-not-allowed'
  | 'unsupported-media'
  | 'too-large'
  | 'refused'
  | 'internal'
  | 'timeout'
  | 'unavailable'
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: FailureCode,
  ) {
    super(code)
  }
}
const failure = (status: number, code: FailureCode): never => {
  throw new HttpFailure(status, code)
}
const respond = (response: ServerResponse, status: number, value: RawJson): void => {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}
const readBody = (request: IncomingMessage): Promise<RawJson> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const deadline = setTimeout(() => {
      request.pause()
      reject(new HttpFailure(408, 'timeout'))
    }, 10000)
    deadline.unref()
    request.once('close', () => clearTimeout(deadline))
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) {
        request.pause()
        reject(new HttpFailure(413, 'too-large'))
      } else chunks.push(chunk)
    })
    request.once('error', () => reject(new HttpFailure(400, 'bad-request')))
    request.once('aborted', () => reject(new HttpFailure(400, 'bad-request')))
    request.once('end', () => {
      clearTimeout(deadline)
      try {
        resolve(JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), rawJsonSchema))
      } catch {
        reject(new HttpFailure(400, 'bad-request'))
      }
    })
  })

/** An embeddable server owns one engine; callers supply its exclusive durable store and adapter registry. */
export interface BotsServerOptions {
  readonly store: BotsEngineOptions['store']
  readonly registry: BotsEngineOptions['registry']
  readonly bearerToken: string
  readonly host?: '127.0.0.1' | '0.0.0.0'
  readonly port?: number
}
export async function startBotsServer(options: BotsServerOptions): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  // This is a service credential, never a provider credential or a URL parameter.
  if (!/^[\x21-\x7e]{32,512}$/.test(options.bearerToken)) throw new Error('Bots requires a 32–512 character printable ASCII service token.')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  if ((host !== '127.0.0.1' && host !== '0.0.0.0') || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Bots listen configuration.')
  const expected = createHash('sha256').update(`Bearer ${options.bearerToken}`).digest()
  const engine = new BotsEngine({ store: options.store, registry: options.registry })
  let closing = false
  type Route = (raw: RawJson | undefined, response: ServerResponse) => Promise<void>
  const route =
    <ClientInput, HostInput, HostOutput, ClientOutput>(
      definition: ApiMethodDefinition<ClientInput, HostInput, HostOutput, ClientOutput>,
      operation: (input: HostInput) => HostOutput | Promise<HostOutput>,
    ): Route =>
    async (raw, response) => {
      if (definition.input === undefined || definition.output === undefined) return failure(500, 'internal')
      const input = await definition.input['~standard'].validate(raw)
      if (input.issues !== undefined) return failure(400, 'bad-request')
      const output = await definition.output['~standard'].validate(await operation(input.value))
      if (output.issues !== undefined) return failure(500, 'internal')
      // Output has already passed the canonical domain schema; JSON validation keeps the transport closed.
      respond(response, 200, rawJsonSchema.parse(output.value))
    }
  const routes = new Map<string, Route>([
    ['/v1/snapshot', route(botsApi.methods.snapshot, () => engine.snapshot())],
    ['/v1/connect', route(botsApi.methods.connect, input => engine.connect(input))],
    ['/v1/reconnect', route(botsApi.methods.reconnect, input => engine.reconnect(input))],
    ['/v1/disconnect', route(botsApi.methods.disconnect, input => engine.disconnect(input))],
    ['/v1/remove', route(botsApi.methods.remove, input => engine.remove(input))],
    ['/v1/messages', route(botsApi.methods.messages, input => engine.messages(input))],
    ['/v1/send', route(botsApi.methods.send, input => engine.send(input))],
    ['/v1/markRead', route(botsApi.methods.markRead, input => engine.markRead(input))],
    ['/v1/setCredentialManagement', route(botsApi.methods.setCredentialManagement, input => engine.setCredentialManagement(input))],
  ])
  const dispatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) return failure(503, 'unavailable')
    // This first transport is server-to-server: no ambient browser authority, query credentials or absolute URLs.
    const path = request.url ?? ''
    if (request.headers.origin !== undefined || !/^\/[A-Za-z0-9/]+$/.test(path)) return failure(400, 'bad-request')
    if (request.headers['content-encoding'] !== undefined) return failure(415, 'unsupported-media')
    if (path === '/healthz') {
      if (request.method !== 'GET') return failure(405, 'method-not-allowed')
      if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) !== 0) return failure(400, 'bad-request')
      respond(response, 200, { status: 'alive' })
      return
    }
    const authorization = request.headers.authorization ?? ''
    if (!timingSafeEqual(expected, createHash('sha256').update(authorization).digest())) return failure(401, 'unauthorized')
    const handler = routes.get(path)
    if (handler === undefined) return failure(404, 'not-found')
    if (request.method !== (path === '/v1/snapshot' ? 'GET' : 'POST')) return failure(405, 'method-not-allowed')
    if (path === '/v1/snapshot') {
      if (request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) !== 0) return failure(400, 'bad-request')
      await handler(undefined, response)
      return
    }
    if (request.headers['content-type']?.trim().toLowerCase() !== 'application/json') return failure(415, 'unsupported-media')
    const length = Number(request.headers['content-length'] ?? 0)
    if (!Number.isSafeInteger(length) || length < 0) return failure(400, 'bad-request')
    if (length > 65536) return failure(413, 'too-large')
    await handler(await readBody(request), response)
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 12000, headersTimeout: 10000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 },
    (request, response) => {
      const deadline = setTimeout(() => {
        respond(response, 504, { error: 'timeout' })
        request.destroy()
      }, 20000)
      deadline.unref()
      response.once('close', () => clearTimeout(deadline))
      response.once('finish', () => request.destroy())
      void dispatch(request, response).catch(error => {
        if (error instanceof HttpFailure) respond(response, error.status, { error: error.code })
        else respond(response, error instanceof PluginApiError ? 409 : 500, { error: error instanceof PluginApiError ? 'refused' : 'internal' })
      })
    },
  )
  server.maxConnections = 128
  server.maxRequestsPerSocket = 1
  server.on('clientError', (_error, socket) => socket.destroy())
  try {
    await engine.start()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch {
    await engine.close().catch(() => undefined)
    throw new Error('Bots server could not start safely.')
  }
  const address = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(server.address())
  if (!address.success) {
    server.closeAllConnections()
    server.close()
    await engine.close()
    throw new Error('Bots server did not acquire a TCP listener.')
  }
  let closed: Promise<void> | undefined
  return {
    origin: `http://${host}:${address.data.port}`,
    close: () => {
      closed ??= (async () => {
        closing = true
        const stopped = new Promise<void>((resolve, reject) =>
          server.close(error => (error === undefined ? resolve() : reject(new Error('Bots listener could not close safely.')))),
        )
        server.closeAllConnections()
        await Promise.all([stopped, engine.close()])
      })()
      return closed
    },
  }
}
