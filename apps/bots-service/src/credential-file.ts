// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { formatSecretReference, secretReferenceSchema, type SecretCatalogValues, type SecretReferenceResolution } from '@dshfiles/credential-port'

const unavailable = (): Error => new Error('Service provider credentials are unavailable. Check the explicit private reference file.')
const referenceKeySchema = z
  .string()
  .max(4096)
  .refine(text => {
    const reference = secretReferenceSchema.safeParse(text)
    return reference.success && formatSecretReference(reference.data) === text
  })
const referencesSchema = z
  .record(referenceKeySchema, z.string().min(1).max(131072))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64)

/** Explicit service-owned, read-only process snapshot. Never reads the DSH catalog or scans a HOME/profile. */
export async function readCredentialFile(path: string): Promise<SecretCatalogValues> {
  const limit = 256 * 1024
  try {
    if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) throw unavailable()
    const uid = process.getuid?.()
    if (uid === undefined) throw unavailable()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let text: string
    try {
      const before = await file.stat({ bigint: true })
      if (
        !before.isFile() ||
        before.uid !== BigInt(uid) ||
        before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n ||
        before.size < 1n ||
        before.size > BigInt(limit)
      )
        throw unavailable()
      const buffer = Buffer.alloc(limit + 1)
      let size = 0
      while (size <= limit) {
        const chunk = await file.read(buffer, size, buffer.length - size, null)
        if (chunk.bytesRead === 0) break
        size += chunk.bytesRead
      }
      if (size > limit) throw unavailable()
      const after = await file.stat({ bigint: true })
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.uid !== after.uid ||
        before.nlink !== after.nlink ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw unavailable()
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
    } finally {
      await file.close()
    }
    const values = new Map(Object.entries(JsonText.parse(text, referencesSchema)))
    return Object.freeze({
      resolve: async (input: SecretReferenceResolution) => {
        if (input.cwd !== null) throw unavailable()
        const value = values.get(formatSecretReference(input.reference))
        if (value === undefined) throw unavailable()
        return value
      },
    })
  } catch {
    throw unavailable()
  }
}
