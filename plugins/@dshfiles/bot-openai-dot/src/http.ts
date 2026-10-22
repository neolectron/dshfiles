// SPDX-License-Identifier: AGPL-3.0-only
// Ported from Beeper chatgpt-dots ee43cb5c; see ../PROVENANCE.md.
import { z } from 'zod'
import { BotAdapterError } from '@dshfiles/bots/adapter'
import { decodeIdentity, renewalSchema, type Identity } from './protocol.js'

export interface Credentials { accessToken: string; sessionToken: string }
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>
const messages = {
  'auth-required': 'ChatGPT authentication expired; reconnect using secret references.',
  'access-denied': 'ChatGPT denied access or requested a browser challenge. Use native ChatGPT; no bypass is attempted.',
  'rate-limited': 'ChatGPT rate limited this connection; try later.',
  unavailable: 'ChatGPT is unavailable; try later.',
  'protocol-error': 'ChatGPT returned an unsupported response. Use native ChatGPT.',
  'delivery-unknown': 'Dot delivery is unknown. Reconcile the original request before retrying; do not create a new send.',
} as const
const fail = (code: keyof typeof messages): BotAdapterError => new BotAdapterError(code, messages[code])
const permittedPath = /^(?:\/api\/auth\/session|\/backend-api\/(?:tbo\/primary|tbo\/by-thread\/[^/?#]+|messaging\/rooms\/[^/?#]+(?:\/messages(?:\?limit=(?:1|32)(?:&after=[^&#]*)?)?)?))$/u

/** All mutable credentials stay in this Host lifetime; never written to disk, vault, logs or public output. */
export class DotHttp {
  readonly identity: Identity
  private credentials: Credentials
  private refreshing: Promise<void> | undefined
  private expires: number
  private readonly lifetime = new AbortController()
  constructor(credentials: Credentials, private readonly fetcher: HttpFetch, private readonly now: () => number) {
    this.credentials = { ...credentials }
    this.identity = decodeIdentity(credentials.accessToken)
    this.expires = this.identity.expires
    this.validateSession(credentials.sessionToken)
  }
  close(): void { this.lifetime.abort(); this.credentials = { accessToken: '', sessionToken: '' } }
  private validateSession(value: string): void {
    if (!value || value.length > 32768 || /[\u0000-\u0020\u007f;,]/u.test(value)) throw fail('auth-required')
  }
  private async request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: object): Promise<T> {
    const target = `https://chatgpt.com${path}`
    if (!permittedPath.test(path) || new URL(target).href !== target) throw fail('protocol-error')
    const renewal = path === '/api/auth/session'
    const sending = body !== undefined
    const boundedSignal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(15000)])
    if (boundedSignal.aborted) throw fail('unavailable')
    try {
      const response = await this.fetcher(target, {
        method: sending ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: boundedSignal,
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          'Content-Type': 'application/json', 'User-Agent': 'DSHDotAdapter/0.1',
          ...(renewal ? { Cookie: `__Secure-next-auth.session-token=${this.credentials.sessionToken}` } : {
            'ChatGPT-Account-Id': this.identity.account, 'X-OpenAI-Expected-Account-Id': this.identity.account,
          }),
        },
        ...(sending ? { body: JSON.stringify(body) } : {}),
      })
      if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw fail(sending ? 'delivery-unknown' : 'access-denied') }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401) throw fail('auth-required')
        if (response.status === 403) throw fail('access-denied')
        if (response.status === 429) throw fail('rate-limited')
        throw fail(sending ? 'delivery-unknown' : response.status >= 500 ? 'unavailable' : 'protocol-error')
      }
      const limit = renewal ? 65536 : 4 * 1024 * 1024
      const advertised = response.headers.get('content-length')
      if (advertised && Number(advertised) > limit) { await response.body?.cancel(); throw fail('protocol-error') }
      if (!response.body) throw fail('protocol-error')
      const reader = response.body.getReader()
      let length = 0
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          boundedSignal.throwIfAborted()
          const result = await reader.read()
          if (result.done) break
          length += result.value.byteLength
          if (length > limit) { await reader.cancel(); throw fail('protocol-error') }
          chunks.push(result.value)
        }
      } finally { reader.releaseLock() }
      let data: unknown
      try { data = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) }
      catch { throw fail('protocol-error') }
      const decoded = schema.safeParse(data)
      if (!decoded.success) throw fail('protocol-error')
      return decoded.data
    } catch (error) {
      if (error instanceof BotAdapterError) {
        if (sending && error.code === 'protocol-error') throw fail('delivery-unknown')
        throw error
      }
      // Fetch/JSON/zod errors may include headers, response bodies or URLs: never retain their causes.
      throw fail(sending ? 'delivery-unknown' : 'unavailable')
    }
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const renewed = await this.request('/api/auth/session', renewalSchema, signal)
        const identity = decodeIdentity(renewed.accessToken)
        if (identity.account !== this.identity.account || identity.user !== this.identity.user || identity.accountUser !== this.identity.accountUser || identity.expires < this.now() + 60000) {
          throw new BotAdapterError('identity-mismatch', 'ChatGPT renewal changed the linked account or user. Reconnect the original account.')
        }
        this.validateSession(renewed.sessionToken)
        if (signal.aborted || this.lifetime.signal.aborted) throw fail('unavailable')
        this.credentials = { accessToken: renewed.accessToken, sessionToken: renewed.sessionToken }
        this.expires = identity.expires
      })().finally(() => { this.refreshing = undefined })
    }
    await this.refreshing
  }
  async api<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: object): Promise<T> {
    if (this.expires < this.now() + 300000) await this.refresh(signal)
    const access = this.credentials.accessToken
    try { return await this.request(`/backend-api${path}`, schema, signal, body) }
    catch (error) {
      if (!(error instanceof BotAdapterError) || error.code !== 'auth-required') throw error
      if (access === this.credentials.accessToken) await this.refresh(signal)
      return this.request(`/backend-api${path}`, schema, signal, body)
    }
  }
}

export function segment(value: string): string {
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u0020\u007f]/u.test(value) || value.length > 300) throw fail('protocol-error')
  return encodeURIComponent(value)
}
