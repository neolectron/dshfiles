// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'

export const accountConfigSchema = z.object({ accountId: z.string().trim().min(1).max(64) }).strict()
