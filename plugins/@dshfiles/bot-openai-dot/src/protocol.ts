// SPDX-License-Identifier: AGPL-3.0-only
// TypeScript protocol port: Beeper chatgpt-dots ee43cb5c; see ../PROVENANCE.md.
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { BotAdapterError } from '@dshfiles/bots/adapter'

/** Provider identifiers, header values and path segments reject ASCII C0, space and DEL.
 * Non-ASCII characters retain the protocol's previous behavior and are URL-encoded at transport. */
export class DotCharacterPolicy {
  static hasForbiddenAscii(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 0x20 || code === 0x7f) return true
    }
    return false
  }
}
export const identifier = z
  .string()
  .min(1)
  .max(300)
  .refine(value => !DotCharacterPolicy.hasForbiddenAscii(value))
const timestamp = z
  .string()
  .max(80)
  .datetime({ offset: true })
  .transform(value => Date.parse(value))
export const claimsSchema = z.object({
  exp: z.number().int().positive(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: identifier, chatgpt_user_id: identifier, chatgpt_account_user_id: identifier.optional() }),
})
export interface Identity {
  readonly account: string
  readonly user: string
  readonly accountUser: string | undefined
  readonly expires: number
}
/** An unverified JWT payload is only a binding hint. Successful provider discovery authorizes the room. */
export function decodeIdentity(token: string): Identity {
  try {
    if (token.length > 32768 || /[\r\n]/u.test(token)) throw new Error()
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) throw new Error()
    const claims = JsonText.parse(Buffer.from(parts[1], 'base64url').toString('utf8'), claimsSchema)
    const auth = claims['https://api.openai.com/auth']
    return { account: auth.chatgpt_account_id, user: auth.chatgpt_user_id, accountUser: auth.chatgpt_account_user_id, expires: claims.exp * 1000 }
  } catch {
    throw new BotAdapterError('auth-required', 'Dot needs supported ChatGPT credentials; reconnect using secret references.')
  }
}
export const primarySchema = z.object({
  selection: z.object({ thread_id: identifier, aeon_id: identifier, messaging_room_id: identifier, available: z.boolean() }).nullable(),
})
export const profileSchema = z.object({
  status: z.string().max(80),
  id: identifier,
  display_name: z.string().max(200).optional(),
  messaging_room_id: identifier,
  active_root_thread_id: identifier.optional(),
})
export type Profile = z.infer<typeof profileSchema>
const baselineSchema = z.object({ id: identifier, created_at: timestamp })
export const baselinePageSchema = z.object({ items: z.array(baselineSchema).max(1) })
export const roomSchema = z.object({
  id: identifier,
  type: z.string().max(80),
  app_source: z.string().max(80),
  aeon_id: identifier,
  members: z.array(z.object({ account_user_id: identifier, aeon_id: z.string().max(300).optional() })).max(16),
  latest_messages: z
    .array(baselineSchema)
    .max(32)
    .nullish()
    .transform(items => items ?? []),
})
export type Room = z.infer<typeof roomSchema>
export const messageSchema = z.object({
  id: identifier,
  created_at: timestamp,
  updated_at: timestamp.optional(),
  account_user_id: identifier,
  request_id: z.string().max(300).nullable().optional(),
  deleted_at: timestamp.nullable().optional(),
  content: z.object({
    text: z
      .string()
      .max(32000)
      .nullish()
      .transform(text => text ?? ''),
    attachments: z.array(z.unknown()).max(128).optional().default([]),
    elicitation: z.unknown().optional(),
  }),
})
export type Message = z.infer<typeof messageSchema>
export const pageSchema = z.object({ items: z.array(messageSchema).max(32), next_cursor: z.string().max(300).nullable().optional() })
export const renewalSchema = z.object({ accessToken: z.string().min(1).max(32768), sessionToken: z.string().min(1).max(32768) })
export interface VerifiedRoomMembers {
  readonly dot: string
  readonly human: string
}
export function verifyRoom(room: Room, profile: Profile, identity: Identity): VerifiedRoomMembers {
  const dot = room.members.filter(member => member.aeon_id === profile.id)
  const human = room.members.filter(member => !member.aeon_id)
  if (
    room.type !== 'DM' ||
    room.app_source !== 'chatgpt:messaging' ||
    room.id !== profile.messaging_room_id ||
    room.aeon_id !== profile.id ||
    room.members.length !== 2 ||
    dot.length !== 1 ||
    human.length !== 1 ||
    !dot[0] ||
    !human[0] ||
    dot[0].account_user_id === human[0].account_user_id ||
    ![identity.user, identity.accountUser].includes(human[0].account_user_id)
  ) {
    throw new BotAdapterError('identity-mismatch', 'Dot room does not match the discovered bot and account identity.')
  }
  return { dot: dot[0].account_user_id, human: human[0].account_user_id }
}
