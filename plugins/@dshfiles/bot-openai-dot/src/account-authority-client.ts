// SPDX-License-Identifier: AGPL-3.0-only
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError } from '@dshfiles/bots/adapter'
import type { DotAccountAccess } from './adapter.js'
import type { HttpFetch } from './http.js'
import { DotAccountAuthorityProtocol } from './account-authority-contract.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'

export interface DotAccountAuthorityClientOptions {
  readonly origin: string
  /** A separate purpose-specific backend credential, never a Bots control key or OpenAI token. */
  readonly resolveBearerToken: (signal: AbortSignal) => Promise<string | undefined>
  readonly fetch?: HttpFetch
}
export interface DotAccountAuthorityClient extends DotAccountAccess {
  close(): void
}
const failure = (code: 'auth-required' | 'unavailable'): BotAdapterError =>
  new BotAdapterError(
    code,
    code === 'auth-required'
      ? 'The selected OpenAI account authority refused or returned an unsupported result. Recover its backend grant and reconnect.'
      : 'The selected OpenAI account authority is unavailable or interrupted. No other account or endpoint was tried.',
  )
const cancelResponse = (response: Response): void => {
  void response.body?.cancel().catch(() => undefined)
}

async function readResponse(response: Response, signal: AbortSignal, accountId: string): Promise<string> {
  if (response.body === null) throw failure('auth-required')
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (response.status !== 200) throw failure(response.status === 401 || response.status === 403 ? 'auth-required' : 'unavailable')
    if (response.redirected || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      throw failure('auth-required')
    const encoding = response.headers.get('content-encoding')
    if (encoding !== null && encoding.toLowerCase() !== 'identity') throw failure('auth-required')
    const declared = response.headers.get('content-length')
    const limit = 64 * 1024
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > limit)) throw failure('auth-required')
    const bytes = new Uint8Array(limit)
    let size = 0
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (chunk.value.byteLength > limit - size) throw failure('auth-required')
      bytes.set(chunk.value, size)
      size += chunk.value.byteLength
    }
    if (declared !== null && size !== Number(declared)) throw failure('auth-required')
    try {
      const output = JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), DotAccountAuthorityProtocol.output)
      if (output.accountId !== accountId) throw failure('auth-required')
      return output.accessToken
    } catch {
      throw failure('auth-required')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    // A hostile producer may never settle cancel(); do not extend the credential operation's deadline.
    cancel()
    reader.releaseLock()
  }
}

/** Backend-only private channel. No cache, retry, provider worker, browser authority or durable credential copy. */
export function createDotAccountAuthorityClient(options: DotAccountAuthorityClientOptions): DotAccountAuthorityClient {
  let origin: string
  try {
    origin = parseAccountAuthorityOrigin(options.origin).origin
  } catch {
    throw failure('auth-required')
  }
  const endpoint = new URL(DotAccountAuthorityProtocol.path, origin).href
  const fetch = options.fetch ?? globalThis.fetch
  const lifetime = new AbortController()
  return {
    close() {
      lifetime.abort()
    },
    async readAccessToken(accountId, caller) {
      if (caller.aborted || lifetime.signal.aborted) throw failure('unavailable')
      const input = DotAccountAuthorityProtocol.input.safeParse({ accountId })
      if (!input.success) throw failure('auth-required')
      const body = JSON.stringify(input.data)
      if (Buffer.byteLength(body, 'utf8') > 2048) throw failure('auth-required')
      const controller = new AbortController()
      const signal = AbortSignal.any([caller, lifetime.signal, controller.signal])
      const deadline = setTimeout(() => controller.abort(), 15000)
      deadline.unref()
      const canceled = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(failure('unavailable')), { once: true }))
      const running = async (): Promise<string> => {
        signal.throwIfAborted()
        let bearer: string | undefined
        try {
          bearer = await options.resolveBearerToken(signal)
        } catch {
          throw failure('auth-required')
        }
        signal.throwIfAborted()
        const credential = DotAccountAuthorityProtocol.bearer.safeParse(bearer)
        if (!credential.success) throw failure('auth-required')
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.data}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'accept-encoding': 'identity',
          },
          credentials: 'omit',
          redirect: 'error',
          signal,
          body,
        })
        if (signal.aborted) {
          cancelResponse(response)
          throw failure('unavailable')
        }
        const token = await readResponse(response, signal, input.data.accountId)
        signal.throwIfAborted()
        return token
      }
      try {
        return await Promise.race([running(), canceled])
      } catch (error) {
        // Reconstruct even known errors: an injected transport/resolver may attach private causes or mutate messages.
        throw failure(!signal.aborted && error instanceof BotAdapterError && error.code === 'auth-required' ? 'auth-required' : 'unavailable')
      } finally {
        clearTimeout(deadline)
        controller.abort()
      }
    },
  }
}
