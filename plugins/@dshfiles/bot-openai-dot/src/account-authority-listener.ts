// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { z } from 'zod'
import type { DotAccountAuthorityHandler } from './account-authority-server.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'
const addressSchema = z.object({ port: z.number().int().min(1).max(65535) })

/** An owned loopback listener, not a forwarded-header exception or a rebind of the running DSH GUI. */
export async function startDotAccountAuthorityListener(options: {
  readonly origin: string
  readonly createHandler: (actualOrigin: string) => DotAccountAuthorityHandler
}): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const pinned = parseAccountAuthorityOrigin(options.origin)
  if (pinned.protocol !== 'http:' || pinned.hostname !== '127.0.0.1' || pinned.port === '')
    throw new Error('Private account listener requires explicit IPv4 loopback HTTP.')
  let authority: DotAccountAuthorityHandler | undefined
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 12000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (request, response) => {
    if (authority === undefined) {
      response.writeHead(503, { connection: 'close', 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end('{"error":"Account authority unavailable."}')
      return
    }
    void authority.handler(request, response).catch(() => response.destroy())
  })
  server.maxConnections = 16
  server.maxRequestsPerSocket = 1
  server.on('clientError', (_error, socket) => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(pinned.port), '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = addressSchema.safeParse(server.address())
    if (!address.success) throw new Error('Listener address unavailable.')
    const origin = `http://127.0.0.1:${address.data.port}`
    authority = options.createHandler(origin)
    let stopped: Promise<void> | undefined
    return {
      origin,
      close: () => {
        stopped ??= (async () => {
          authority?.close()
          const pending = new Promise<void>((resolve, reject) =>
            server.close(error => (error === undefined ? resolve() : reject(new Error('Private account listener cleanup unconfirmed.')))),
          )
          server.closeAllConnections()
          await pending
        })()
        return stopped
      },
    }
  } catch {
    authority?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('Private account listener could not start safely.')
  }
}
