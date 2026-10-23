// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'

/** Closed, page-only input vocabulary. There is deliberately no URL, target, path or command. */
const coordinate = z.number().int().min(0).max(8191)
const navigationKey = z.enum([
  'Backspace',
  'Delete',
  'Tab',
  'Enter',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
])
export const authTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(text => {
    const hasControl = Array.from(text).some(character => {
      const code = character.codePointAt(0)
      return code === undefined || code <= 0x1f || code === 0x7f
    })
    return !hasControl && new TextEncoder().encode(text).byteLength <= 4096
  })
export const authInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), action: z.enum(['move', 'down', 'up']), x: coordinate, y: coordinate, button: z.enum(['left', 'right']) }).strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: coordinate,
      y: coordinate,
      deltaX: z.number().int().min(-4096).max(4096),
      deltaY: z.number().int().min(-4096).max(4096),
    })
    .strict(),
  // Modifier bits: Alt=1, Control=2, Meta=4, Shift=8. No browser/clipboard chords.
  z
    .object({ kind: z.literal('key'), action: z.enum(['down', 'up']), key: navigationKey, modifiers: z.number().int().min(0).max(15) })
    .strict()
    .refine(input => (input.modifiers === 0 || input.modifiers === 8) && !(input.modifiers === 8 && (input.key === 'Escape' || input.key === 'Delete'))),
  z
    .object({
      kind: z.literal('text'),
      text: authTextSchema,
    })
    .strict(),
])
export type AuthInput = z.infer<typeof authInputSchema>
export const authStartSchema = z.object({ acceptRisks: z.literal(true) }).strict()
export type AuthStartInput = z.infer<typeof authStartSchema>
export const authInputRequestSchema = z
  .object({
    attemptId: z.string().uuid(),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    input: authInputSchema,
  })
  .strict()
export type AuthInputRequest = z.infer<typeof authInputRequestSchema>
export const authEmptyRequestSchema = z.object({}).strict()

export const authAttemptSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    state: z.enum(['starting', 'ready', 'denied', 'closed', 'expired', 'failed']),
    expiresAt: z.number().int().positive(),
    width: z.number().int().min(0).max(8192),
    height: z.number().int().min(0).max(8192),
  })
  .strict()
export type AuthAttemptSnapshot = z.infer<typeof authAttemptSnapshotSchema>
export const authStartResultSchema = z
  .object({
    attempt: authAttemptSnapshotSchema,
    /** Private browser controller capability: never persist, log, or pass through tools. */
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()
export type AuthStartResult = z.infer<typeof authStartResultSchema>
export const dotAuthRoutes = {
  start: '/api/dshfiles/dot-auth/start',
  status: '/api/dshfiles/dot-auth/status',
  frame: '/api/dshfiles/dot-auth/frame',
  input: '/api/dshfiles/dot-auth/input',
  cancel: '/api/dshfiles/dot-auth/cancel',
} as const
export const dotAuthCapabilityHeader = 'X-Dot-Auth-Capability'
/** Shared binary response ceiling; never copied into client state or RPC. */
export const authFrameMaxBytes = 1024 * 1024
