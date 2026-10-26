import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { gatewayConfigSchema, readGatewayConfig } from '../src/config.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'dsh-mcp-config-'))) throw new Error('Unexpected fixture root')
    await rm(root, { recursive: true, force: true })
  }
})
const config = (project = '/tmp') => ({
  guiOrigin: 'http://localhost:3198',
  ledgerPath: '/tmp/private-dsh-mcp/admission.sqlite',
  projects: [{ id: 'demo', path: project }],
  principals: [{ id: 'yield', tokenEnv: 'DSH_MCP_YIELD_TOKEN', projects: ['demo'], actions: ['read'] }],
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-config-'))
  roots.push(root)
  const project = join(root, 'project')
  await mkdir(project)
  const file = join(root, 'config.json')
  await writeFile(file, JSON.stringify(config(project)), { mode: 0o600 })
  return { root, project, file }
}

it('accepts only reference-based explicit grants and defaults to a loopback listener', async () => {
  const test = await fixture()
  const parsed = await readGatewayConfig(test.file)
  expect(parsed.listen).toEqual({ host: '127.0.0.1', port: 8790 })
  expect(parsed.projects).toEqual([{ id: 'demo', path: test.project }])
  expect(parsed.principals[0]?.tokenEnv).toBe('DSH_MCP_YIELD_TOKEN')
})

it('rejects public listeners, raw credential fields, unknown projects and duplicate authorities', () => {
  const base = config()
  for (const value of [
    { ...base, listen: { host: '0.0.0.0', port: 8790 } },
    { ...base, token: 'PRIVATE_LITERAL_MUST_NOT_BE_CONFIG' },
    { ...base, guiOrigin: 'https://user:password@host.example' },
    { ...base, projects: [base.projects[0], base.projects[0]] },
    { ...base, principals: [{ ...base.principals[0], projects: ['not-allowed'] }] },
    { ...base, principals: [{ ...base.principals[0], tokenEnv: 'invalid-env-name' }] },
    { ...base, principals: [base.principals[0], { ...base.principals[0], id: 'other' }] },
    { ...base, principals: [{ ...base.principals[0], actions: ['read', 'read'] }] },
  ])
    expect(gatewayConfigSchema.safeParse(value).success).toBe(false)
})

it('rejects unowned mutable indirection, hardlinks, oversized input and unsafe project paths', async () => {
  const test = await fixture()
  const alias = join(test.root, 'symlink.json')
  await symlink(test.file, alias)
  await expect(readGatewayConfig(alias)).rejects.toMatchObject({ code: 'invalid-config' })
  const hardlink = join(test.root, 'hardlink.json')
  await link(test.file, hardlink)
  await expect(readGatewayConfig(hardlink)).rejects.toMatchObject({ code: 'invalid-config' })
  const huge = join(test.root, 'huge.json')
  await writeFile(huge, 'x'.repeat(129 * 1024), { mode: 0o600 })
  await expect(readGatewayConfig(huge)).rejects.toMatchObject({ code: 'invalid-config' })
  const mutable = join(test.root, 'mutable.json')
  await writeFile(mutable, JSON.stringify(config(test.project)), { mode: 0o600 })
  await chmod(mutable, 0o666)
  await expect(readGatewayConfig(mutable)).rejects.toMatchObject({ code: 'invalid-config' })
  const missing = join(test.root, 'missing-project.json')
  await writeFile(missing, JSON.stringify(config(join(test.root, 'absent'))), { mode: 0o600 })
  await expect(readGatewayConfig(missing)).rejects.toMatchObject({ code: 'invalid-config' })
})
