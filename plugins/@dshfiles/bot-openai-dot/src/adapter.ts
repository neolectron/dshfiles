// SPDX-License-Identifier: AGPL-3.0-only
// Protocol port from Beeper chatgpt-dots ee43cb5c; see ../PROVENANCE.md.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError, type AdapterMessage, type BotAdapter, type BotAdapterSession, type BotPollInput, type BotSendInput } from '@dshfiles/bots/adapter'
import { formatSecretReference, secretReferenceSchema } from '@dshfiles/credential-port'
import { DotHttp, segment, type HttpFetch } from './http.js'
import { DotCredentials, type DotCredentialStore } from './credentials.js'
import { baselinePageSchema, messageSchema, pageSchema, primarySchema, profileSchema, roomSchema, verifyRoom, type Message } from './protocol.js'

const configSchema = z.object({ accessTokenRef: secretReferenceSchema, sessionTokenRef: secretReferenceSchema }).strict()
const requestIdSchema = z.string().uuid()
const pollCursorSchema = z
  .object({
    version: z.literal(1),
    after: z.string().min(1).max(300),
    recentAnchor: z.string().min(1).max(300),
    recentPages: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(8)
      .optional()
      .default([]),
    latestAt: z.number().finite().nullable().optional().default(null),
  })
  .strict()
const checkpointHash = (cursor: string): string => createHash('sha256').update(cursor).digest('hex')
const cursorPrefix = 'dot:v1:'
function readPollCursor(cursor: string | null): z.infer<typeof pollCursorSchema> {
  if (!cursor || cursor.length > 2000) throw protocolFailure()
  if (!cursor.startsWith(cursorPrefix)) {
    if (cursor.length > 300) throw protocolFailure()
    return { version: 1, after: cursor, recentAnchor: cursor, recentPages: [], latestAt: null }
  }
  try {
    return JsonText.parse(Buffer.from(cursor.slice(cursorPrefix.length), 'base64url').toString('utf8'), pollCursorSchema)
  } catch {
    throw protocolFailure()
  }
}
const writePollCursor = (cursor: z.infer<typeof pollCursorSchema>): string => {
  const encoded = `${cursorPrefix}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
  if (encoded.length > 2000) throw protocolFailure()
  return encoded
}
const protocolFailure = (): BotAdapterError =>
  new BotAdapterError('protocol-error', 'Dot returned an unsafe message page; checkpoint retained. Use native ChatGPT.')
const unknownDelivery = (): BotAdapterError =>
  new BotAdapterError('delivery-unknown', 'Dot delivery is unknown. Reconcile this original request before retrying.')
export interface DotDependencies {
  /** Host-only seam. Receives canonical reference text, never browser input or a raw credential configuration. */
  readonly resolveSecret: (reference: string) => Promise<string | undefined>
  readonly store?: DotCredentialStore
  readonly fetch?: HttpFetch
  readonly now?: () => number
}

export function createDotAdapter(dependencies: DotDependencies): BotAdapter {
  const now = dependencies.now ?? Date.now
  return {
    info: {
      id: 'openai-dot',
      version: 1,
      name: 'OpenAI Dot (unofficial)',
      description: 'Message your existing primary Dot. Text only; incoming messages are polled while DSH runs.',
      risk: 'This unsupported private ChatGPT protocol may stop working or be denied. These credentials grant broad ChatGPT account access, not a Dot-only scope. DSH resolves vault references on the Host only. No browser extraction or challenge bypass. Renewal stays in memory unless you explicitly grant managed credential storage after identity verification. Only messages since linking are synchronized. Approvals and media require native ChatGPT. All admitted DSH browsers share the owner account authority.',
      credentialManagement: {
        label: 'Keep Dot credentials renewed in the vault',
        description:
          'Optional: create one new global provider-owned session bundle and switch both references together. Renewals replace that whole bundle. Original aliases are never changed or deleted. Revoking stops new work, not accepted writes. Provider/local crash windows may require reauthorization. No cross-host sharing or backend compare-and-swap.',
      },
      fields: [
        {
          key: 'accessTokenRef',
          label: 'ChatGPT access token reference',
          kind: 'secret-reference',
          required: true,
          help: 'An existing secret:ALIAS or secret:ALIAS@env reference. Never paste a token.',
        },
        {
          key: 'sessionTokenRef',
          label: 'ChatGPT session token reference',
          kind: 'secret-reference',
          required: true,
          help: 'An existing renewable session secret reference. No automatic credential acquisition.',
        },
      ],
    },
    pollIntervalMs: 3000,
    validateConfig(config) {
      if (!configSchema.safeParse(config).success)
        throw new BotAdapterError('auth-required', 'Dot requires exactly two valid secret reference fields, not raw credentials.')
    },
    async open(input): Promise<BotAdapterSession> {
      const config = configSchema.safeParse(input.config)
      if (!config.success) throw new BotAdapterError('auth-required', 'Dot requires accessTokenRef and sessionTokenRef secret references.')
      if (input.signal.aborted) throw new BotAdapterError('unavailable', 'Dot connection was canceled.')
      const credentials = new DotCredentials(input.config, input.connectionId, dependencies.resolveSecret, dependencies.store, input.signal)
      let pair
      try {
        pair = await credentials.load(formatSecretReference(config.data.accessTokenRef), formatSecretReference(config.data.sessionTokenRef))
      } catch (error) {
        if (error instanceof BotAdapterError && error.code === 'identity-mismatch') throw error
        throw new BotAdapterError('auth-required', 'Dot could not resolve the configured secret references on the Host.')
      }
      const http = new DotHttp(pair, dependencies.fetch ?? globalThis.fetch, now, { assertActive: credentials.assertActive, renewed: credentials.renewed })
      try {
        input.signal.throwIfAborted()
        const primary = await http.api('/tbo/primary', primarySchema, input.signal)
        const selected = primary.selection
        if (!selected?.available) throw new BotAdapterError('unavailable', 'No available primary Dot. Select an existing Dot in native ChatGPT.')
        const profile = await http.api(`/tbo/by-thread/${segment(selected.thread_id)}`, profileSchema, input.signal)
        if (
          profile.status !== 'active' ||
          profile.id !== selected.aeon_id ||
          profile.messaging_room_id !== selected.messaging_room_id ||
          (profile.active_root_thread_id && profile.active_root_thread_id !== selected.thread_id)
        )
          throw new BotAdapterError('identity-mismatch', 'Dot profile does not match the selected primary Dot.')
        const roomPath = `/messaging/rooms/${segment(profile.messaging_room_id)}`
        const room = await http.api(roomPath, roomSchema, input.signal)
        const members = verifyRoom(room, profile, http.identity)
        let latest = room.latest_messages
        if (!latest.length) latest = (await http.api(`${roomPath}/messages?limit=1`, baselinePageSchema, input.signal)).items
        const baseline = latest.toSorted((a, b) => b.created_at - a.created_at)[0]
        // Importing an unbounded old transcript when there is no stable boundary is not safe.
        if (!baseline)
          throw new BotAdapterError('protocol-error', 'Dot room lacks a stable latest-message baseline; link it after a native ChatGPT message exists.')
        const nativeUrl = 'https://chatgpt.com/dots'
        const ensureBound = (request: BotPollInput | BotSendInput): void => {
          if (request.remoteBotId !== profile.id || request.conversationId !== profile.messaging_room_id)
            throw new BotAdapterError('identity-mismatch', 'Refusing an unverified Dot or conversation.')
        }
        const verify = async (signal: AbortSignal): Promise<void> => {
          const current = verifyRoom(await http.api(roomPath, roomSchema, signal), profile, http.identity)
          if (current.dot !== members.dot || current.human !== members.human)
            throw new BotAdapterError('identity-mismatch', 'Dot room membership changed; reconnect the original identity.')
        }
        const normalize = (message: Message): AdapterMessage => {
          if (message.account_user_id !== members.dot && message.account_user_id !== members.human)
            throw new BotAdapterError('identity-mismatch', 'Dot message author is not a verified room member.')
          const unsupported = message.content.attachments.length > 0 || message.content.elicitation != null
          const deleted = message.deleted_at != null
          return {
            id: message.id,
            requestId: message.request_id || null,
            author: message.account_user_id === members.dot ? 'bot' : 'user',
            text: deleted ? '' : message.content.text,
            notice: deleted
              ? 'This message was deleted in ChatGPT.'
              : unsupported
                ? 'Unsupported attachment or approval. Open native ChatGPT to view or act; nothing was approved here.'
                : null,
            nativeUrl: unsupported ? nativeUrl : null,
            createdAt: message.created_at,
            updatedAt: Math.max(message.updated_at ?? message.created_at, message.deleted_at ?? message.created_at),
          }
        }
        const page = async (cursor: string | null, signal: AbortSignal) => {
          if (!cursor || cursor.length > 300) throw protocolFailure()
          const result = await http.api(`${roomPath}/messages?limit=32&after=${encodeURIComponent(cursor)}`, pageSchema, signal)
          const ordered = result.items.toSorted((a, b) => a.created_at - b.created_at)
          const messages = ordered.map(normalize)
          if (new Set(messages.map(message => message.id)).size !== messages.length) throw protocolFailure()
          const hasMore = ordered.length === 32 || Boolean(result.next_cursor)
          const last = ordered.at(-1)
          const next = result.next_cursor || last?.id || cursor
          if ((hasMore && !last) || (last && next === cursor)) throw protocolFailure()
          // A provider returning the starting checkpoint as its only message did not advance.
          if (last && ordered.every(message => message.id === cursor)) throw protocolFailure()
          return { messages: messages.filter(message => message.id !== cursor), cursor: next, hasMore }
        }
        const accountId = createHash('sha256')
          .update(JSON.stringify([http.identity.account, http.identity.user, http.identity.accountUser ?? null, members.human, members.dot]))
          .digest('hex')
        credentials.verifyAccount(accountId)
        const session: BotAdapterSession = {
          accountId,
          bindCredentialReferences: bind => credentials.run(() => credentials.bind(bind)),
          bots: [
            {
              remoteId: profile.id,
              name: profile.display_name?.trim() || 'Your Dot',
              description: 'Your existing primary ChatGPT Dot.',
              nativeUrl,
              capabilities: { text: true, attachments: false, approvals: false, activity: false },
              conversations: [{ id: profile.messaging_room_id, title: 'Messages', historyScope: 'since-link', initialCursor: baseline.id }],
            },
          ],
          async poll(request) {
            ensureBound(request)
            const cursor = readPollCursor(request.cursor)
            await verify(request.signal)
            const fresh = await page(cursor.after, request.signal)
            const latestAt = fresh.messages.at(-1)?.createdAt ?? cursor.latestAt
            if (cursor.latestAt !== null && latestAt !== null && latestAt < cursor.latestAt) throw protocolFailure()
            if (fresh.cursor !== cursor.after && cursor.recentPages.includes(checkpointHash(fresh.cursor))) throw protocolFailure()
            const recentPages = fresh.hasMore ? [...cursor.recentPages, checkpointHash(cursor.after)].slice(-8) : []
            // Re-read one recent page for edits/deletions, never scan the entire old transcript.
            const overlap = cursor.recentAnchor === cursor.after ? null : await page(cursor.recentAnchor, request.signal)
            const byId = new Map<string, AdapterMessage>()
            for (const message of [...(overlap?.messages ?? []), ...fresh.messages]) {
              const previous = byId.get(message.id)
              if (previous && previous.author !== message.author)
                throw new BotAdapterError('identity-mismatch', 'Dot message authorship changed during synchronization.')
              if (!previous || message.updatedAt >= previous.updatedAt) byId.set(message.id, message)
            }
            const messages = [...byId.values()].toSorted((a, b) => a.createdAt - b.createdAt)
            const recentAnchor = messages.at(-32)?.id ?? cursor.recentAnchor
            return { messages, cursor: writePollCursor({ version: 1, after: fresh.cursor, recentAnchor, recentPages, latestAt }), hasMore: fresh.hasMore }
          },
          async send(request) {
            ensureBound(request)
            if (!requestIdSchema.safeParse(request.requestId).success || !request.text.trim() || request.text.length > 32000) throw protocolFailure()
            await verify(request.signal)
            const message = await http.api(`${roomPath}/messages`, messageSchema, request.signal, {
              content: { text: request.text },
              request_id: request.requestId,
              idempotency_token: request.requestId,
            })
            if (
              message.request_id !== request.requestId ||
              message.account_user_id !== members.human ||
              message.content.text !== request.text ||
              message.deleted_at != null
            )
              throw unknownDelivery()
            return normalize(message)
          },
          async reconcile(request) {
            ensureBound(request)
            if (!requestIdSchema.safeParse(request.requestId).success || !request.initialCursor) return { kind: 'unknown' }
            await verify(request.signal)
            let cursor: string | null = request.initialCursor
            const seen = new Set<string>()
            // A bound reached without exhaustion is unknown, never proof of absence.
            for (let count = 0; count < 16; count++) {
              if (!cursor || seen.has(cursor)) return { kind: 'unknown' }
              seen.add(cursor)
              let result
              try {
                result = await page(cursor, request.signal)
              } catch (error) {
                if (error instanceof BotAdapterError && error.code === 'protocol-error') return { kind: 'unknown' }
                throw error
              }
              const found = result.messages.find(message => message.requestId === request.requestId && message.author === 'user')
              if (found) {
                if (found.text !== request.text)
                  throw new BotAdapterError('identity-mismatch', 'Dot request ID is associated with different message text; refusing reconciliation.')
                return { kind: 'found', message: found }
              }
              if (!result.hasMore) return { kind: 'not-found' }
              cursor = result.cursor
            }
            return { kind: 'unknown' }
          },
          async close() {
            credentials.close()
            http.close()
          },
        }
        return {
          ...session,
          poll: request => credentials.run(() => session.poll(request)),
          send: request => credentials.run(() => session.send(request)),
          reconcile: request => credentials.run(() => session.reconcile(request)),
        }
      } catch (error) {
        credentials.close()
        http.close()
        if (error instanceof BotAdapterError) throw error
        throw new BotAdapterError('unavailable', 'Dot connection was canceled or unavailable.')
      }
    },
  }
}
