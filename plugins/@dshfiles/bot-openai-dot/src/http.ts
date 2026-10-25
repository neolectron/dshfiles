// SPDX-License-Identifier: AGPL-3.0-only
// Ported from Beeper chatgpt-dots ee43cb5c; see ../PROVENANCE.md.
import type { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError } from '@dshfiles/bots/adapter'
import { decodeIdentity, DotCharacterPolicy, renewalSchema, type Identity } from './protocol.js'
import type { DotAccountAccess } from './adapter.js'

export interface Credentials {
  accessToken: string
  sessionToken: string
}
export interface DotSendBody {
  readonly content: { readonly text: string }
  readonly request_id: string
  readonly idempotency_token: string
}
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
const permittedPath =
  /^(?:\/api\/auth\/session|\/backend-api\/(?:tbo\/primary|tbo\/by-thread\/[^/?#]+|messaging\/rooms\/[^/?#]+(?:\/messages(?:\?limit=(?:1|32)(?:&after=[^&#]*)?)?)?))$/u

interface AccountCredentials {
  accessToken: string
  readonly accountId: string
  readonly accountAccess: DotAccountAccess
}
const accountFailure = (): BotAdapterError =>
  new BotAdapterError('auth-required', 'The selected OpenAI login is unavailable or expired. Recover it through its account owner and reconnect.')
const readAccountToken = async (accountAccess: DotAccountAccess, accountId: string, signal: AbortSignal): Promise<string> => {
  try {
    const token = await accountAccess.readAccessToken(accountId, signal)
    if (signal.aborted) throw fail('unavailable')
    return token
  } catch {
    throw signal.aborted ? fail('unavailable') : accountFailure()
  }
}
/** Also races an owner callback or fetch implementation that ignores AbortSignal; late results cannot authorize I/O. */
const withAccessDeadline = async <Result>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  if (signal.aborted) throw fail('unavailable')
  const timer = setTimeout(() => controller.abort(), 15000)
  timer.unref()
  const cancelled = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(fail('unavailable')), { once: true }))
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw fail('unavailable')
        return operation(signal)
      }),
      cancelled,
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Host-only credentials; optional explicitly granted persistence stays behind a provider-owned port. */
export class DotHttp {
  readonly identity: Identity
  private credentials: Credentials | AccountCredentials
  private refreshing: Promise<void> | undefined
  private expires: number
  private readonly lifetime = new AbortController()
  private failed = false
  constructor(
    credentials: Credentials | AccountCredentials,
    private readonly fetcher: HttpFetch,
    private readonly now: () => number,
    private readonly lifecycle?: { assertActive(): void; renewed(pair: Credentials): Promise<void> },
  ) {
    this.credentials = { ...credentials }
    this.identity = decodeIdentity(credentials.accessToken)
    this.expires = this.identity.expires
    if ('sessionToken' in credentials) this.validateSession(credentials.sessionToken)
    else if (this.expires <= this.now()) throw fail('auth-required')
  }
  static async openAccount(accountId: string, accountAccess: DotAccountAccess, fetcher: HttpFetch, now: () => number, signal: AbortSignal): Promise<DotHttp> {
    try {
      return await withAccessDeadline(signal, async bounded => {
        const accessToken = await readAccountToken(accountAccess, accountId, bounded)
        return new DotHttp({ accessToken, accountId, accountAccess }, fetcher, now)
      })
    } catch (error) {
      if (error instanceof BotAdapterError && error.code === 'unavailable') throw error
      throw accountFailure()
    }
  }
  close(): void {
    this.lifetime.abort()
    this.credentials.accessToken = ''
    if ('sessionToken' in this.credentials) this.credentials.sessionToken = ''
  }
  private validateSession(value: string): void {
    if (!value || value.length > 32768 || DotCharacterPolicy.hasForbiddenAscii(value) || value.includes(';') || value.includes(',')) throw fail('auth-required')
  }
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: DotSendBody,
    accessToken = this.credentials.accessToken,
  ): Promise<T> {
    this.assertActive(signal)
    const target = `https://chatgpt.com${path}`
    if (!permittedPath.test(path) || new URL(target).href !== target) throw fail('protocol-error')
    const renewal = path === '/api/auth/session'
    const sending = body !== undefined
    const boundedSignal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(15000)])
    if (boundedSignal.aborted) throw fail('unavailable')
    try {
      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DSHDotAdapter/0.1',
      })
      if (renewal) {
        if (!('sessionToken' in this.credentials)) throw fail('auth-required')
        headers.set('Cookie', `__Secure-next-auth.session-token=${this.credentials.sessionToken}`)
      } else {
        headers.set('ChatGPT-Account-Id', this.identity.account)
        headers.set('X-OpenAI-Expected-Account-Id', this.identity.account)
      }
      const request: RequestInit = {
        method: sending ? 'POST' : 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: boundedSignal,
        headers,
      }
      if (body !== undefined) request.body = JSON.stringify(body)
      this.assertActive(signal)
      const response = await this.fetcher(target, request)
      try {
        this.assertActive(boundedSignal)
      } catch (error) {
        await response.body?.cancel()
        throw error
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel()
        throw fail(sending ? 'delivery-unknown' : 'access-denied')
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401) throw fail('auth-required')
        if (response.status === 403) {
          if (response.headers.get('cf-mitigated') === 'challenge')
            throw new BotAdapterError(
              'access-denied',
              'ChatGPT stopped this request at a Cloudflare browser security check. Compatibility of this login with Dot is unknown. Use native ChatGPT; no bypass is attempted.',
            )
          throw fail('access-denied')
        }
        if (response.status === 429) throw fail('rate-limited')
        throw fail(sending ? 'delivery-unknown' : response.status >= 500 ? 'unavailable' : 'protocol-error')
      }
      const limit = renewal ? 65536 : 4 * 1024 * 1024
      const advertised = response.headers.get('content-length')
      if (advertised && Number(advertised) > limit) {
        await response.body?.cancel()
        throw fail('protocol-error')
      }
      if (!response.body) throw fail('protocol-error')
      const reader = response.body.getReader()
      const cancel = (): void => {
        void reader.cancel().catch(() => undefined)
      }
      boundedSignal.addEventListener('abort', cancel, { once: true })
      let length = 0
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          boundedSignal.throwIfAborted()
          this.assertActive(signal)
          const result = await reader.read()
          this.assertActive(signal)
          if (result.done) break
          length += result.value.byteLength
          if (length > limit) {
            await reader.cancel()
            throw fail('protocol-error')
          }
          chunks.push(result.value)
        }
      } finally {
        boundedSignal.removeEventListener('abort', cancel)
        reader.releaseLock()
      }
      try {
        return JsonText.parse(Buffer.concat(chunks, length).toString('utf8'), schema)
      } catch {
        throw fail('protocol-error')
      }
    } catch (error) {
      if (error instanceof BotAdapterError) {
        if (sending && error.code === 'protocol-error') throw fail('delivery-unknown')
        throw error
      }
      // Fetch/JSON/zod errors may include headers, response bodies or URLs: never retain their causes.
      throw fail(sending ? 'delivery-unknown' : 'unavailable')
    }
  }
  private assertActive(signal: AbortSignal): void {
    if (this.failed || signal.aborted || this.lifetime.signal.aborted) throw fail('unavailable')
    this.lifecycle?.assertActive()
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    this.assertActive(signal)
    if (!('sessionToken' in this.credentials)) throw fail('auth-required')
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const renewed = await this.request('/api/auth/session', renewalSchema, signal)
        const identity = decodeIdentity(renewed.accessToken)
        if (
          identity.account !== this.identity.account ||
          identity.user !== this.identity.user ||
          identity.accountUser !== this.identity.accountUser ||
          identity.expires < this.now() + 60000
        ) {
          throw new BotAdapterError('identity-mismatch', 'ChatGPT renewal changed the linked account or user. Reconnect the original account.')
        }
        this.validateSession(renewed.sessionToken)
        if (signal.aborted || this.lifetime.signal.aborted) throw fail('unavailable')
        const pair = { accessToken: renewed.accessToken, sessionToken: renewed.sessionToken }
        try {
          await this.lifecycle?.renewed(pair)
          this.assertActive(signal)
        } catch (error) {
          this.failed = true // No blind provider refresh or message POST after local commit failure.
          if (error instanceof BotAdapterError) throw error
          throw fail('auth-required')
        }
        this.credentials = pair
        this.expires = identity.expires
      })().finally(() => {
        this.refreshing = undefined
      })
    }
    await this.refreshing
  }
  async api<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: DotSendBody): Promise<T> {
    this.assertActive(signal)
    if ('accountAccess' in this.credentials) {
      const source = this.credentials
      try {
        return await withAccessDeadline(AbortSignal.any([signal, this.lifetime.signal]), async bounded => {
          const access = await readAccountToken(source.accountAccess, source.accountId, bounded)
          this.assertActive(bounded)
          const identity = decodeIdentity(access)
          if (identity.expires <= this.now()) throw fail('auth-required')
          if (identity.account !== this.identity.account || identity.user !== this.identity.user || identity.accountUser !== this.identity.accountUser)
            throw new BotAdapterError('identity-mismatch', 'The selected OpenAI account identity changed. Reconnect the original account.')
          return this.request(`/backend-api${path}`, schema, bounded, body, access)
        })
      } catch (error) {
        if (error instanceof BotAdapterError) {
          if (error.code === 'auth-required' || error.code === 'access-denied' || error.code === 'identity-mismatch') this.failed = true
          if (error.code === 'auth-required') throw accountFailure()
          throw error
        }
        this.failed = true
        throw accountFailure()
      }
    }
    if (this.expires < this.now() + 300000) await this.refresh(signal)
    const access = this.credentials.accessToken
    try {
      return await this.request(`/backend-api${path}`, schema, signal, body)
    } catch (error) {
      if (!(error instanceof BotAdapterError) || error.code !== 'auth-required') throw error
      if (access === this.credentials.accessToken) await this.refresh(signal)
      return this.request(`/backend-api${path}`, schema, signal, body)
    }
  }
}

export function segment(value: string): string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    DotCharacterPolicy.hasForbiddenAscii(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.length > 300
  )
    throw fail('protocol-error')
  return encodeURIComponent(value)
}
