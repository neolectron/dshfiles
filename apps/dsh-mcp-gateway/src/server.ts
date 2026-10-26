import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createGatewayMcpServer } from './mcp.js'
import { GatewayError, type GatewayOperations, type GatewayPrincipal } from './contracts.js'

export interface GatewayCredential {
  readonly principal: GatewayPrincipal
  readonly resolveToken: () => string | undefined
}
export interface GatewayServerOptions {
  /** Loopback only. Put a private tunnel or a deliberately configured HTTPS reverse proxy in front. */
  readonly host: '127.0.0.1' | '::1'
  readonly port: number
  readonly credentials: readonly GatewayCredential[]
  readonly operations: GatewayOperations
}
const wireJson = z.json()
const tokenSchema = z.string().regex(/^[a-zA-Z0-9_-]{32,256}$/u)
const requestHeaderSchema = z.string().max(8192)
const listeningAddressSchema = z.object({ port: z.number().int().min(1).max(65535) })
const hash = (text: string): Buffer => createHash('sha256').update(text).digest()

const refuse = (response: ServerResponse, status: number): void => {
  if (response.headersSent || response.destroyed) return
  const headers: OutgoingHttpHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="dsh-task-gateway"'
  response.writeHead(status, headers)
  response.end(JSON.stringify({ error: 'DSH gateway request refused.' }))
}
const authenticate = (request: IncomingMessage, credentials: readonly GatewayCredential[]): GatewayPrincipal | undefined => {
  const header = requestHeaderSchema.safeParse(request.headers.authorization)
  if (!header.success || !header.data.startsWith('Bearer ')) return undefined
  const bearer = tokenSchema.safeParse(header.data.slice(7))
  if (!bearer.success) return undefined
  let principal: GatewayPrincipal | undefined
  for (const credential of credentials) {
    const configured = tokenSchema.safeParse(credential.resolveToken())
    if (!configured.success) continue
    if (timingSafeEqual(hash(bearer.data), hash(configured.data))) {
      if (principal !== undefined) return undefined // Duplicate operator keys must not merge privileges.
      principal = credential.principal
    }
  }
  return principal
}
const readBody = async (request: IncomingMessage): Promise<z.infer<typeof wireJson>> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new GatewayError('forbidden')
    size += chunk.byteLength
    if (size > 128 * 1024) throw new GatewayError('forbidden')
    chunks.push(chunk)
  }
  return JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), wireJson)
}

/** Stateful admission is owned by operations; MCP is stateless and authenticated independently on every request. */
export async function startGatewayServer(options: GatewayServerOptions): Promise<{ readonly origin: string; close(): Promise<void> }> {
  if (
    !['127.0.0.1', '::1'].includes(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    options.credentials.length < 1 ||
    options.credentials.length > 32
  )
    throw new GatewayError('invalid-config')
  let closing: Promise<void> | undefined
  let accepting = true
  let expectedHost = ''
  const work = new Set<Promise<void>>()
  const handlers = new Set<ReturnType<typeof createGatewayMcpServer>>()
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (!accepting) {
        refuse(response, 503)
        return
      }
      if (request.headers.host !== expectedHost || request.headers.origin !== undefined) {
        refuse(response, 403)
        return
      }
      // Absent routes, including OAuth discovery, must stay 404 rather than
      // advertising a nonexistent OAuth server. All actual MCP traffic remains
      // authenticated before methods, bodies or tool metadata are processed.
      if (request.url !== '/mcp') {
        refuse(response, 404)
        return
      }
      const principal = authenticate(request, options.credentials)
      if (principal === undefined) {
        refuse(response, 401)
        return
      }
      if (request.method !== 'POST') {
        refuse(response, 405)
        return
      }
      if (work.size >= 16) {
        refuse(response, 429)
        return
      }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        refuse(response, 415)
        return
      }
      const advertised = request.headers['content-length']
      if (advertised !== undefined && (!/^\d+$/u.test(advertised) || Number(advertised) > 128 * 1024)) {
        refuse(response, 413)
        return
      }
      const body = await readBody(request)
      if (!accepting || response.destroyed) {
        refuse(response, 503)
        return
      }
      const server = createGatewayMcpServer(options.operations, principal)
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      handlers.add(server)
      try {
        response.setHeader('cache-control', 'no-store')
        await server.connect(transport)
        const headers = new Headers({ 'content-type': 'application/json' })
        if (request.headers.accept !== undefined) headers.set('accept', request.headers.accept)
        const version = requestHeaderSchema.safeParse(request.headers['mcp-protocol-version'])
        if (version.success) headers.set('mcp-protocol-version', version.data)
        const result = await transport.handleRequest(new Request(`http://${expectedHost}/mcp`, { method: 'POST', headers }), { parsedBody: body })
        const chunks: Uint8Array[] = []
        let size = 0
        if (result.body !== null) {
          const reader = result.body.getReader()
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              if (size > 1024 * 1024) {
                await reader.cancel()
                throw new GatewayError('unavailable')
              }
              chunks.push(chunk.value)
            }
          } finally {
            reader.releaseLock()
          }
        }
        if (response.destroyed) return
        response.writeHead(result.status, { 'cache-control': 'no-store', 'content-type': result.headers.get('content-type') ?? 'application/json' })
        response.end(Buffer.concat(chunks, size))
      } finally {
        await server.close()
        handlers.delete(server)
      }
    } catch {
      refuse(response, 400)
    }
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    const running = handle(request, response)
    work.add(running)
    void running.finally(() => work.delete(running))
  })
  server.maxConnections = 64
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 1000
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    throw new GatewayError('unavailable')
  }
  const address = listeningAddressSchema.safeParse(server.address())
  if (!address.success) {
    server.close()
    throw new GatewayError('unavailable')
  }
  expectedHost = `${options.host === '::1' ? '[::1]' : options.host}:${address.data.port}`
  return {
    origin: `http://${expectedHost}`,
    close: () => {
      closing ??= (async () => {
        accepting = false
        const stopped = new Promise<void>((resolve, reject) =>
          server.close(error => (error === undefined ? resolve() : reject(new GatewayError('unavailable')))),
        )
        server.closeIdleConnections()
        await Promise.allSettled([...work])
        await Promise.all([...handlers].map(handler => handler.close()))
        await stopped
        await options.operations.close()
      })()
      return closing
    },
  }
}
