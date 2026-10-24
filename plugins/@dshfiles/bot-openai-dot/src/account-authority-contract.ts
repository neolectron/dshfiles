// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { accountConfigSchema } from './account-config.js'

/** Private backend channel. Never register this value response as a dshx API, Client or tool. */
export const DotAccountAuthorityProtocol = Object.freeze({
  version: 1,
  path: '/dshfiles/bot-openai-dot/account-authority/v1/access',
  input: accountConfigSchema,
  output: z
    .object({
      version: z.literal(1),
      accountId: accountConfigSchema.shape.accountId,
      accessToken: z
        .string()
        .min(1)
        .max(32768)
        .regex(/^[\x21-\x7E]+$/u),
    })
    .strict(),
  bearer: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[\x21-\x7E]+$/u),
})
