import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { JsonText } from '@dshfiles/dshx/api'
import { z } from 'zod'

const codexAccessFileSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.union([z.literal(''), z.null()]).optional(),
  tokens: z.object({ access_token: z.string().min(1) }),
})

/** Strict read for new delegated uses; legacy model routing retains its original file policy. */
const readPrivateCodexAuth = async (home: string, signal: AbortSignal): Promise<string> => {
  signal.throwIfAborted()
  if ((await realpath(home)) !== resolve(home)) throw new Error('Private login layout is unavailable')
  const file = await open(join(home, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    signal.throwIfAborted()
    const before = await file.stat({ bigint: true })
    const uid = process.getuid?.()
    const limit = 256 * 1024
    if (
      uid === undefined ||
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error('Private login is unavailable')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) {
      signal.throwIfAborted()
      const chunk = await file.read(buffer, size, buffer.length - size, null)
      if (chunk.bytesRead === 0) break
      size += chunk.bytesRead
    }
    if (size > limit) throw new Error('Private login exceeds its bound')
    const after = await file.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Private login changed during reading')
    signal.throwIfAborted()
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
  } finally {
    await file.close()
  }
}

/**
 * Read one ChatGPT access token from a Codex home.
 *
 * Codex owns login and refresh; this plugin never persists, refreshes or logs a
 * credential. A later request sees whatever Codex last wrote, so an expired
 * login fails loudly here instead of silently falling back to an API key.
 */
export const readCodexAccessToken = async (codexHome: string, delegatedRead?: { readonly signal: AbortSignal }): Promise<string> => {
  const path = join(codexHome, 'auth.json')
  let raw: string
  try {
    raw = delegatedRead === undefined ? await readFile(path, 'utf8') : await readPrivateCodexAuth(codexHome, delegatedRead.signal)
  } catch {
    throw new LlmError(`No readable Codex login at ${path}. Sign in with \`CODEX_HOME="${codexHome}" codex login\`.`, 'MISSING_CREDENTIAL')
  }
  try {
    return JsonText.parse(raw, codexAccessFileSchema).tokens.access_token
  } catch {
    throw new LlmError(`Codex login at ${path} is not a valid ChatGPT access login. Sign in with ChatGPT, not an API key.`, 'INVALID_CREDENTIAL')
  }
}
