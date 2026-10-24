import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { accountDraftSchema } from './api.js'
import { AccountStoreModel, accountStoreService, type AccountStoreFile } from './account-store.js'
import { readCodexAccessToken } from './read-codex-token.js'

export interface OpenAIAccountAccessSource {
  readAccounts(signal: AbortSignal): Promise<AccountStoreFile>
  readAccessToken(effectiveHome: string, signal: AbortSignal): Promise<string>
}
export interface OpenAIAccountAccessOptions {
  readonly accountId: string
  readonly purpose: 'openai-dot'
  readonly acceptRisks: true
  readonly source?: OpenAIAccountAccessSource
  readonly now?: () => number
}
const errorCodeSchema = z.enum(['account-unavailable', 'access-unavailable', 'expired', 'identity-mismatch', 'canceled'])
const messages = {
  'account-unavailable': 'The selected OpenAI account is unavailable. No other account was tried.',
  'access-unavailable': 'The selected OpenAI login could not be used safely. Its owner must manage sign-in and refresh.',
  expired: 'The selected OpenAI login has no usable unexpired access token. No refresh or replacement was attempted.',
  'identity-mismatch': 'The selected OpenAI login identity changed. Explicitly authorize the intended account again.',
  canceled: 'The selected OpenAI account access was canceled or exceeded its deadline.',
} satisfies Readonly<Record<z.infer<typeof errorCodeSchema>, string>>
export class OpenAIAccountAccessError extends Error {
  readonly code: z.infer<typeof errorCodeSchema>
  constructor(code: z.infer<typeof errorCodeSchema>) {
    const result = errorCodeSchema.safeParse(code)
    const safeCode = result.success ? result.data : 'access-unavailable'
    super(messages[safeCode])
    this.code = safeCode
    this.name = 'OpenAIAccountAccessError'
  }
}
const claimsSchema = z
  .object({
    exp: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 1000),
    sub: z.string().min(1).max(512).optional(),
    'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1).max(300), chatgpt_user_id: z.string().min(1).max(300).optional() }),
  })
  .refine(claims => claims.sub !== undefined || claims['https://api.openai.com/auth'].chatgpt_user_id !== undefined)
const defaultSource: OpenAIAccountAccessSource = {
  readAccounts: () => accountStoreService.readAccountFile(),
  readAccessToken: (home, signal) => readCodexAccessToken(home, { signal }),
}

/**
 * Host-only, purpose-bound use of one already configured login. This is NOT an API/Client/tool DTO.
 * Never returns a credential record, refresh token, cookie or path. The trusted Host callback must not
 * serialize the access token to Clients/tools and must use its signal for I/O. Cancellation cannot
 * recall a bearer token already delivered to that callback or undo accepted remote work.
 */
export class OpenAIAccountAccess {
  readonly version = 1
  readonly #selectedAccountId: string
  get accountId(): string {
    return this.#selectedAccountId
  }
  readonly #lifetime = new AbortController()
  readonly #source: OpenAIAccountAccessSource
  readonly #now: () => number
  #principal: string | undefined
  #identityChanged = false
  private constructor(options: OpenAIAccountAccessOptions) {
    this.#selectedAccountId = options.accountId
    this.#source = options.source ?? defaultSource
    this.#now = options.now ?? Date.now
  }
  static create(options: OpenAIAccountAccessOptions): OpenAIAccountAccess {
    if (options.purpose !== 'openai-dot' || options.acceptRisks !== true || !accountDraftSchema.shape.instanceId.safeParse(options.accountId).success)
      throw new OpenAIAccountAccessError('account-unavailable')
    return new OpenAIAccountAccess(options)
  }
  close(): void {
    this.#lifetime.abort()
  }
  private assertUnexpired(expiry: number): void {
    const now = this.#now()
    if (!Number.isFinite(now) || expiry <= now + 60000) throw new OpenAIAccountAccessError('expired')
  }
  private async selectedHome(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const file = await this.#source.readAccounts(signal)
    signal.throwIfAborted()
    const matches = file.accounts.filter(account => account.instanceId === this.#selectedAccountId)
    const account = matches[0]
    if (matches.length !== 1 || account === undefined || !account.enabled || account.kind !== 'codex') throw new OpenAIAccountAccessError('account-unavailable')
    return AccountStoreModel.codexLayoutFor(account, file.shadowRoot).effectiveHomePath
  }
  async withAccessToken<Result>(caller: AbortSignal, operation: (accessToken: string, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    if (this.#identityChanged) throw new OpenAIAccountAccessError('identity-mismatch')
    if (caller.aborted || this.#lifetime.signal.aborted) throw new OpenAIAccountAccessError('canceled')
    const controller = new AbortController()
    const signal = AbortSignal.any([caller, this.#lifetime.signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10000)
    deadline.unref()
    const canceled = new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new OpenAIAccountAccessError('canceled')), { once: true }),
    )
    const running = async (): Promise<Result> => {
      const home = await this.selectedHome(signal)
      const token = await this.#source.readAccessToken(home, signal)
      signal.throwIfAborted()
      if (token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new OpenAIAccountAccessError('access-unavailable')
      const payload = token.split('.')[1]
      if (payload === undefined) throw new OpenAIAccountAccessError('access-unavailable')
      const claims = JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64url')), claimsSchema)
      this.assertUnexpired(claims.exp * 1000)
      if ((await this.selectedHome(signal)) !== home) throw new OpenAIAccountAccessError('account-unavailable')
      signal.throwIfAborted()
      // Decoded claims are continuity hints, NOT signature validation or provider authorization.
      const principal = JSON.stringify([
        claims.sub ?? null,
        claims['https://api.openai.com/auth'].chatgpt_account_id,
        claims['https://api.openai.com/auth'].chatgpt_user_id ?? null,
      ])
      if (this.#principal !== undefined && this.#principal !== principal) {
        this.#identityChanged = true
        this.#lifetime.abort()
        throw new OpenAIAccountAccessError('identity-mismatch')
      }
      this.assertUnexpired(claims.exp * 1000)
      this.#principal = principal
      const result = await operation(token, signal)
      signal.throwIfAborted()
      if ((await this.selectedHome(signal)) !== home) throw new OpenAIAccountAccessError('account-unavailable')
      signal.throwIfAborted()
      return result
    }
    try {
      return await Promise.race([running(), canceled])
    } catch (error) {
      if (this.#identityChanged) throw new OpenAIAccountAccessError('identity-mismatch')
      if (error instanceof OpenAIAccountAccessError) throw new OpenAIAccountAccessError(error.code)
      if (signal.aborted) throw new OpenAIAccountAccessError('canceled')
      throw new OpenAIAccountAccessError('access-unavailable')
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
  }
}
