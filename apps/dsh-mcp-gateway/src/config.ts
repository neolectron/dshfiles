import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { JsonText } from '@dshfiles/dshx/api'
import { gatewayActionSchema, GatewayError } from './contracts.js'

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/u)
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => isAbsolute(value) && resolve(value) === value)
const guiOrigin = z
  .string()
  .url()
  .refine(value => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  })
export const gatewayConfigSchema = z
  .object({
    listen: z
      .object({ host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8790) })
      .strict()
      .default({ host: '127.0.0.1', port: 8790 }),
    guiOrigin,
    ledgerPath: absolutePath,
    upstreamLaunchUrlEnv: environmentName.optional(),
    projects: z
      .array(z.object({ id: identifier, path: absolutePath, agentPreset: identifier.optional() }).strict())
      .min(1)
      .max(64),
    principals: z
      .array(
        z
          .object({
            id: identifier,
            tokenEnv: environmentName,
            projects: z.array(identifier).min(1).max(64),
            actions: z.array(gatewayActionSchema).min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.projects.map(project => project.id)).size !== config.projects.length)
      ctx.addIssue({ code: 'custom', message: 'Project identifiers must be unique.' })
    if (new Set(config.principals.map(principal => principal.id)).size !== config.principals.length)
      ctx.addIssue({ code: 'custom', message: 'Principal identifiers must be unique.' })
    if (new Set(config.principals.map(principal => principal.tokenEnv)).size !== config.principals.length)
      ctx.addIssue({ code: 'custom', message: 'Token references must be distinct.' })
    const projects = new Set(config.projects.map(project => project.id))
    for (const principal of config.principals) {
      if (
        principal.projects.some(project => !projects.has(project)) ||
        new Set(principal.projects).size !== principal.projects.length ||
        new Set(principal.actions).size !== principal.actions.length
      )
        ctx.addIssue({ code: 'custom', message: 'Principal grants must be explicit and unique.' })
    }
  })
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>

/** Config contains operator references, never literal access tokens. Does not write a profile or data root. */
export async function readGatewayConfig(path: string): Promise<GatewayConfig> {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) throw new GatewayError('invalid-config')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let source: string
    try {
      const before = await file.stat({ bigint: true })
      const uid = process.getuid?.()
      if (
        uid === undefined ||
        !before.isFile() ||
        before.uid !== BigInt(uid) ||
        before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n ||
        before.size < 1n ||
        before.size > 128n * 1024n
      )
        throw new GatewayError('invalid-config')
      const buffer = Buffer.alloc(128 * 1024 + 1)
      let size = 0
      while (size < buffer.byteLength) {
        const next = await file.read(buffer, size, buffer.byteLength - size, null)
        if (next.bytesRead === 0) break
        size += next.bytesRead
      }
      const after = await file.stat({ bigint: true })
      if (
        size > 128 * 1024 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mode !== after.mode ||
        before.uid !== after.uid ||
        before.nlink !== after.nlink ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new GatewayError('invalid-config')
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
    } finally {
      await file.close()
    }
    const config = JsonText.parse(source, gatewayConfigSchema)
    for (const project of config.projects) {
      if ((await realpath(project.path)) !== project.path || !(await stat(project.path)).isDirectory()) throw new GatewayError('invalid-config')
    }
    return config
  } catch {
    throw new GatewayError('invalid-config')
  }
}
