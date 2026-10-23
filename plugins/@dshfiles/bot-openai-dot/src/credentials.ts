// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError, type BotCredentialReferencePublisher } from '@dshfiles/bots/adapter'
import { formatSecretReference, parseSecretReference, secretReferenceSchema } from '@dshfiles/credential-port'
import type { Credentials } from './http.js'
import { decodeIdentity, DotCharacterPolicy, identifier } from './protocol.js'

/** Scalar writes only. Reads must use the canonical Host value resolver, never reveal RPC. */
export interface DotCredentialStore {
  create(input: { alias: string; value: string }): Promise<void>
  update(input: { alias: string; environment: string; value: string }): Promise<void>
}
const bundleSchema = z
  .object({
    formatVersion: z.literal(1),
    ownerConnectionId: z.string().min(1).max(300),
    reference: secretReferenceSchema.transform(formatSecretReference),
    generationId: z.string().uuid(),
    accessToken: z.string().min(1).max(32768),
    sessionToken: z.string().min(1).max(32768),
    accountBinding: z
      .object({ account: identifier, user: identifier, accountUser: identifier.nullable(), linkedAccountId: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict(),
  })
  .strict()
type Bundle = z.infer<typeof bundleSchema>
const failure = () =>
  new BotAdapterError(
    'auth-required',
    'Dot managed credentials could not be safely committed. Reauthorize before continuing; a potentially unlinked managed bundle may remain in the vault. No item was deleted or rolled back.',
  )
const mismatch = () => new BotAdapterError('identity-mismatch', 'Dot credential bundle does not match this connection or verified account.')
function validatePair(pair: Credentials): void {
  decodeIdentity(pair.accessToken)
  if (!pair.sessionToken || pair.sessionToken.length > 32768 || DotCharacterPolicy.hasForbiddenAscii(pair.sessionToken) || /[;,]/u.test(pair.sessionToken))
    throw failure()
}
function readBundle(raw: string | undefined, connectionId: string | undefined): Bundle {
  try {
    if (!raw || raw.length > 131072 || !connectionId) throw mismatch()
    const bundle = JsonText.parse(raw, bundleSchema)
    if (bundle.ownerConnectionId !== connectionId) throw mismatch()
    validatePair(bundle)
    const identity = decodeIdentity(bundle.accessToken)
    if (
      identity.account !== bundle.accountBinding.account ||
      identity.user !== bundle.accountBinding.user ||
      (identity.accountUser ?? null) !== bundle.accountBinding.accountUser
    )
      throw mismatch()
    return bundle
  } catch {
    throw mismatch()
  }
}

/** One session owns this state. No values leave the provider; the publisher sees references only. */
export class DotCredentials {
  private pair: Credentials | undefined
  private bundle: Bundle | undefined
  private reference: string | undefined
  private binding: { publish: BotCredentialReferencePublisher; signal: AbortSignal } | undefined
  private linkedAccountId: string | undefined
  private stopped = false
  private failed = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly config: Readonly<Record<string, string>>,
    private readonly connectionId: string | undefined,
    private readonly resolve: (reference: string) => Promise<string | undefined>,
    private readonly store: DotCredentialStore | undefined,
    private readonly signal: AbortSignal,
  ) {}
  assertActive = (): void => {
    if (this.stopped || this.signal.aborted || this.binding?.signal.aborted) throw new BotAdapterError('unavailable', 'Dot connection was canceled.')
    if (this.failed) throw failure()
    try {
      this.binding?.publish.assertActive()
    } catch {
      throw failure()
    }
  }
  /** Serialize bind and complete operations, including refresh persistence, per session. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      this.assertActive()
      return operation()
    })
    this.queue = result.catch(() => undefined)
    return result
  }
  async load(accessRef: string, sessionRef: string): Promise<Credentials> {
    this.assertActive()
    const access = await this.resolve(accessRef)
    this.assertActive()
    if (accessRef === sessionRef) {
      // A historical same-reference scalar remains a scalar. Object-like values are never silently downgraded.
      if (access?.trimStart().startsWith('{')) {
        this.bundle = readBundle(access, this.connectionId)
        this.reference = accessRef
        this.pair = { accessToken: this.bundle.accessToken, sessionToken: this.bundle.sessionToken }
      } else {
        if (!access) throw failure()
        this.pair = { accessToken: access, sessionToken: access }
      }
    } else {
      const session = await this.resolve(sessionRef)
      this.assertActive()
      if (!access || !session) throw failure()
      this.pair = { accessToken: access, sessionToken: session }
    }
    return this.pair
  }
  verifyAccount(linkedAccountId: string): void {
    if (this.bundle && this.bundle.accountBinding.linkedAccountId !== linkedAccountId) throw mismatch()
    this.linkedAccountId = linkedAccountId
  }
  private assertOwnedBundle(bundle: Bundle, reference: string): void {
    const ref = parseSecretReference(reference)
    if (
      bundle.reference !== reference ||
      !ref ||
      ref.environment !== 'prod' ||
      !ref.alias.startsWith('DSH_DOT_') ||
      !z.string().uuid().safeParse(ref.alias.slice('DSH_DOT_'.length).replaceAll('_', '-')).success
    )
      throw mismatch()
  }
  private nextBundle(reference: string): Bundle {
    if (!this.pair || !this.connectionId || !this.linkedAccountId) throw failure()
    validatePair(this.pair)
    const identity = decodeIdentity(this.pair.accessToken)
    return bundleSchema.parse({
      formatVersion: 1,
      ownerConnectionId: this.connectionId,
      reference,
      generationId: randomUUID(),
      ...this.pair,
      accountBinding: { account: identity.account, user: identity.user, accountUser: identity.accountUser ?? null, linkedAccountId: this.linkedAccountId },
    })
  }
  private async ownedUpdate(): Promise<void> {
    if (!this.store || !this.bundle || !this.reference) throw failure()
    this.assertActive()
    this.assertOwnedBundle(this.bundle, this.reference)
    const previous = readBundle(await this.resolve(this.reference), this.connectionId)
    this.assertActive()
    this.assertOwnedBundle(previous, this.reference)
    if (previous.generationId !== this.bundle.generationId || JSON.stringify(previous) !== JSON.stringify(this.bundle)) throw mismatch()
    const next = this.nextBundle(this.reference)
    const ref = parseSecretReference(this.reference)
    if (!ref) throw failure()
    this.assertActive()
    try {
      await this.store.update({ alias: ref.alias, environment: ref.environment, value: JSON.stringify(next) })
      // Acknowledged write is known even if revoked immediately afterwards; no rollback is implied.
      this.bundle = next
    } catch {
      // An exception may mean the write was accepted. One guarded readback can establish the result.
    }
    this.assertActive()
    const observed = readBundle(await this.resolve(this.reference), this.connectionId)
    if (JSON.stringify(observed) === JSON.stringify(next)) this.bundle = next
    this.assertActive()
    if (JSON.stringify(observed) !== JSON.stringify(next)) throw failure()
  }
  async bind(input: { connectionId: string; publish: BotCredentialReferencePublisher; signal: AbortSignal }): Promise<void> {
    if (input.connectionId !== this.connectionId || !this.linkedAccountId || this.binding) throw failure()
    this.binding = input
    try {
      this.assertActive()
      if (!this.store) throw failure()
      if (this.bundle) {
        this.assertOwnedBundle(this.bundle, this.reference ?? '')
        // Same owned bundle on restart. Only commit if discovery rotated its pair in memory.
        if (this.pair?.accessToken !== this.bundle.accessToken || this.pair.sessionToken !== this.bundle.sessionToken) await this.ownedUpdate()
        else {
          this.assertActive()
          const current = readBundle(await this.resolve(this.reference ?? ''), this.connectionId)
          this.assertActive()
          if (JSON.stringify(current) !== JSON.stringify(this.bundle)) throw mismatch()
        }
        return
      }
      const alias = `DSH_DOT_${randomUUID().replaceAll('-', '_')}`
      const reference = formatSecretReference({ alias, environment: 'prod' })
      const next = this.nextBundle(reference)
      this.assertActive()
      await this.store.create({ alias, value: JSON.stringify(next) })
      this.assertActive()
      await input.publish.replace({ previous: this.config, next: { accessTokenRef: reference, sessionTokenRef: reference } })
      // Publication acknowledged; never pretend the previous config was restored on a later cancellation.
      this.bundle = next
      this.reference = reference
      this.assertActive()
    } catch {
      this.failed = true
      throw failure()
    }
  }
  renewed = async (pair: Credentials): Promise<void> => {
    this.assertActive()
    this.pair = { ...pair }
    if (!this.binding) return // Discovery queues the latest pair until Core has verified and persisted identity.
    try {
      await this.ownedUpdate()
    } catch {
      this.failed = true
      throw failure()
    }
  }
  close(): void {
    this.stopped = true
    this.pair = undefined
    this.bundle = undefined
  }
}
