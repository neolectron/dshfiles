import { z } from 'zod'
import { formatSecretReference, secretReferenceSchema } from '@dshfiles/credential-port'

/** Placement is profile-owned deployment configuration, not a live switch between two data owners. */
export const botsHostConfigSchema = z
  .object({
    mode: z.enum(['local', 'service']).default('local'),
    serviceOrigin: z.string().max(2048).default(''),
    serviceTokenReference: z.union([z.literal(''), secretReferenceSchema.transform(formatSecretReference)]).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'local' && (value.serviceOrigin !== '' || value.serviceTokenReference !== '')) {
      context.addIssue({ code: 'custom', message: 'Service placement fields require explicit service mode.' })
    }
    if (value.mode === 'service' && value.serviceOrigin.trim() === '') {
      context.addIssue({ code: 'custom', message: 'Service mode requires an explicit service origin.' })
    }
  })
  .prefault({})
