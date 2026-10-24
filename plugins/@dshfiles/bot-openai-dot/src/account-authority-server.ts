// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'
import { JsonText } from '@dshfiles/dshx/api'
import type { DotAccountAccess } from './adapter.js'
import { DotAccountAuthorityProtocol as protocol } from './account-authority-contract.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'

export interface DotAccountAuthorityHandlerOptions {
  readonly expectedOrigin: string
  readonly accountIds: readonly string[]
  readonly acceptRisks: true
  readonly resolveBearerToken: (signal: AbortSignal) => Promise<string | undefined>
  readonly accountAccess: DotAccountAccess
}
export interface DotAccountAuthorityHandler {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  close(): void
}
const loopback = (address: string | undefined) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
const digest = (value: string) => createHash('sha256').update(value).digest()
const refusal = (response: ServerResponse, status: number): void => {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  })
  response.end('{"error":"Account authority request refused."}')
}
const readBody = (request: IncomingMessage, signal: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    const clean = () => {
      request.off('data', data)
      request.off('end', end)
      request.off('error', fail)
      signal.removeEventListener('abort', abort)
    }
    const fail = () => {
      clean()
      request.pause()
      reject(new Error('Authority body unavailable'))
    }
    const abort = () => fail()
    const data = (part: Buffer) => {
      size += part.length
      if (size > 2048) {
        fail()
        return
      }
      parts.push(part)
    }
    const end = () => {
      clean()
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
      } catch {
        reject(new Error('Authority body unavailable'))
      }
    }
    if (signal.aborted) {
      fail()
      return
    }
    request.on('data', data)
    request.once('end', end)
    request.once('error', fail)
    signal.addEventListener('abort', abort, { once: true })
  })

/** Independently authenticated PRIVATE backend channel, not a native API/browser admission override. */
export function createDotAccountAuthorityHandler(options: DotAccountAuthorityHandlerOptions): DotAccountAuthorityHandler {
  const origin = parseAccountAuthorityOrigin(options.expectedOrigin)
  if (options.acceptRisks !== true || options.accountIds.length < 1 || options.accountIds.length > 64)
    throw new Error('Explicit account authority admission is required')
  const admitted = new Set(options.accountIds.map(accountId => protocol.input.parse({ accountId }).accountId))
  if (admitted.size !== options.accountIds.length) throw new Error('Duplicate account authority admission')
  const lifetime = new AbortController()
  let active = 0
  return {
    close: () => lifetime.abort(),
    handler: async (request, response) => {
      // Nothing using credentials may throw past this boundary: native WebServer logs uncaught errors.
      try {
        if (lifetime.signal.aborted || active >= 8) {
          refusal(response, 503)
          return
        }
        if (request.url !== protocol.path) {
          refusal(response, 404)
          return
        }
        if (request.method !== 'POST') {
          refusal(response, 405)
          return
        }
        let headerBytes = 0
        const names = new Set<string>()
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          const name = request.rawHeaders[index]?.toLowerCase()
          const value = request.rawHeaders[index + 1]
          if (name === undefined || value === undefined || names.has(name)) {
            refusal(response, 400)
            return
          }
          names.add(name)
          headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
        }
        if (headerBytes > 8192) {
          refusal(response, 431)
          return
        }
        if (
          request.headers.host !== origin.host ||
          request.headers.origin !== undefined ||
          request.headers.cookie !== undefined ||
          request.headers.referer !== undefined ||
          [...names].some(name => (name.startsWith('sec-fetch-') && name !== 'sec-fetch-mode') || name === 'forwarded' || name.startsWith('x-forwarded-'))
        ) {
          refusal(response, 403)
          return
        }
        const tls = request.socket instanceof TLSSocket && request.socket.encrypted
        if (
          (origin.protocol === 'https:' && !tls) ||
          (origin.protocol === 'http:' && (tls || !loopback(request.socket.remoteAddress) || !loopback(request.socket.localAddress)))
        ) {
          refusal(response, 403)
          return
        }
        if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
          refusal(response, 415)
          return
        }
        const length = request.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > 2048)) {
          refusal(response, 413)
          return
        }
        const authorization = request.headers.authorization
        const supplied = protocol.bearer.safeParse(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined)
        if (!supplied.success) {
          refusal(response, 401)
          return
        }
        active++
        const controller = new AbortController()
        const signal = AbortSignal.any([lifetime.signal, controller.signal])
        const abort = () => controller.abort()
        const closed = () => {
          if (!response.writableFinished) abort()
        }
        request.once('aborted', abort)
        request.once('error', abort)
        response.once('error', abort)
        response.once('close', closed)
        const timer = setTimeout(abort, 10000)
        timer.unref()
        const canceled = new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Authority request canceled')), { once: true }),
        )
        try {
          const run = async () => {
            signal.throwIfAborted()
            const current = protocol.bearer.safeParse(await options.resolveBearerToken(signal))
            signal.throwIfAborted()
            if (!current.success) {
              refusal(response, 503)
              return
            }
            if (!timingSafeEqual(digest(current.data), digest(supplied.data))) {
              refusal(response, 401)
              return
            }
            const input = JsonText.parse(await readBody(request, signal), protocol.input)
            signal.throwIfAborted()
            if (!admitted.has(input.accountId)) {
              refusal(response, 403)
              return
            }
            const accessToken = await options.accountAccess.readAccessToken(input.accountId, signal)
            signal.throwIfAborted()
            const output = protocol.output.parse({ version: 1, accountId: input.accountId, accessToken })
            const body = JSON.stringify(output)
            response.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              Pragma: 'no-cache',
              'X-Content-Type-Options': 'nosniff',
              Connection: 'close',
            })
            response.end(body)
          }
          await Promise.race([run(), canceled])
        } catch {
          refusal(response, signal.aborted ? 408 : 503)
        } finally {
          clearTimeout(timer)
          request.off('aborted', abort)
          request.off('error', abort)
          response.off('error', abort)
          response.off('close', closed)
          controller.abort()
          active--
        }
      } catch {
        refusal(response, 503)
      }
    },
  }
}
