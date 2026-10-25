// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import { formatSecretReference, secretReferenceSchema } from '@dshfiles/credential-port'
import { accountConfigSchema } from './account-config.js'
import { parseAccountAuthorityOrigin } from './account-authority-origin.js'
const browserOrigin = z
  .string()
  .max(2048)
  .refine(value => {
    try {
      const url = new URL(value)
      return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    } catch {
      return false
    }
  }, 'Human browser access requires HTTPS or local loopback HTTP.')

export const dotHostConfigSchema = z
  .object({
    mode: z.enum(['references', 'account']).default('references'),
    accountIds: z.array(accountConfigSchema.shape.accountId).max(64).default([]),
    acceptAccountRisks: z.boolean().default(false),
    authorityOrigin: z.string().max(2048).default(''),
    authorityTransport: z.enum(['native', 'loopback']).default('native'),
    enrollmentServiceOrigin: z.string().max(2048).default(''),
    enrollmentTokenReference: z.union([z.literal(''), secretReferenceSchema.transform(formatSecretReference)]).default(''),
    browserOrigin: z.union([z.literal(''), browserOrigin]).default(''),
    additionalBrowserOrigins: z.array(browserOrigin).max(8).default([]),
    authorityTokenReference: z.union([z.literal(''), secretReferenceSchema.transform(formatSecretReference)]).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'references') {
      if (
        value.accountIds.length > 0 ||
        value.acceptAccountRisks ||
        value.authorityOrigin !== '' ||
        value.authorityTokenReference !== '' ||
        value.authorityTransport !== 'native' ||
        value.enrollmentServiceOrigin !== '' ||
        value.enrollmentTokenReference !== '' ||
        value.browserOrigin !== '' ||
        value.additionalBrowserOrigins.length > 0
      )
        context.addIssue({ code: 'custom', message: 'Account authority requires explicit account mode.' })
    } else if (
      value.accountIds.length === 0 ||
      new Set(value.accountIds).size !== value.accountIds.length ||
      !value.acceptAccountRisks ||
      value.authorityOrigin === ''
    )
      context.addIssue({ code: 'custom', message: 'Explicit account admission, risk acceptance and pinned authority origin are required.' })
    if (value.authorityTransport === 'loopback') {
      try {
        const origin = parseAccountAuthorityOrigin(value.authorityOrigin)
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '' || origin.port === '0') throw new Error()
      } catch {
        context.addIssue({ code: 'custom', message: 'Owned authority transport requires a pinned nonzero IPv4 loopback HTTP port.' })
      }
    }
    if (value.enrollmentServiceOrigin === '') {
      if (value.enrollmentTokenReference !== '' || value.browserOrigin !== '' || value.additionalBrowserOrigins.length > 0)
        context.addIssue({ code: 'custom', message: 'Enrollment requires an explicit private service origin.' })
    } else {
      try {
        parseAccountAuthorityOrigin(value.enrollmentServiceOrigin)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid private enrollment service origin.' })
      }
      if (value.mode !== 'account' || value.browserOrigin === '')
        context.addIssue({ code: 'custom', message: 'Enrollment requires account mode and an explicit secure browser origin.' })
      if (new Set([value.browserOrigin, ...value.additionalBrowserOrigins]).size !== value.additionalBrowserOrigins.length + 1)
        context.addIssue({ code: 'custom', message: 'Duplicate browser origin.' })
    }
  })
  .prefault({})
