// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { formatSecretReference, secretReferenceSchema } from '@dshfiles/credential-port'
import { accountConfigSchema } from './account-config.js'

export const dotHostConfigSchema = z
  .object({
    mode: z.enum(['references', 'account']).default('references'),
    accountIds: z.array(accountConfigSchema.shape.accountId).max(64).default([]),
    acceptAccountRisks: z.boolean().default(false),
    authorityOrigin: z.string().max(2048).default(''),
    authorityTokenReference: z.union([z.literal(''), secretReferenceSchema.transform(formatSecretReference)]).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'references') {
      if (value.accountIds.length > 0 || value.acceptAccountRisks || value.authorityOrigin !== '' || value.authorityTokenReference !== '')
        context.addIssue({ code: 'custom', message: 'Account authority requires explicit account mode.' })
    } else if (
      value.accountIds.length === 0 ||
      new Set(value.accountIds).size !== value.accountIds.length ||
      !value.acceptAccountRisks ||
      value.authorityOrigin === ''
    )
      context.addIssue({ code: 'custom', message: 'Explicit account admission, risk acceptance and pinned authority origin are required.' })
  })
  .prefault({})
