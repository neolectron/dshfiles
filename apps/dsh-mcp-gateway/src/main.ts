#!/usr/bin/env node
import { connectDshPlatformClient } from '@dshfiles/dshx/platform'
import { readGatewayConfig } from './config.js'
import { GatewayError } from './contracts.js'
import { createNativeTaskRuntime } from './native-runtime.js'
import { createTaskGateway } from './service.js'
import { startGatewayServer } from './server.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: dsh-mcp-gateway --config /absolute/operator-config.json\nLoopback-only authenticated MCP at /mcp. Existing DSH is the sole task runtime. Credentials are environment references, never command arguments.\n',
    )
    return
  }
  if (args.length !== 2 || args[0] !== '--config' || args[1] === undefined) throw new GatewayError('invalid-config')
  const config = await readGatewayConfig(args[1])
  for (const principal of config.principals) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/u.test(process.env[principal.tokenEnv] ?? '')) throw new GatewayError('invalid-config')
  }
  if (new Set(config.principals.map(principal => process.env[principal.tokenEnv])).size !== config.principals.length) throw new GatewayError('invalid-config')
  const resolveLaunchUrl = config.upstreamLaunchUrlEnv === undefined ? undefined : process.env[config.upstreamLaunchUrlEnv]
  if (config.upstreamLaunchUrlEnv !== undefined && resolveLaunchUrl === undefined) throw new GatewayError('invalid-config')
  const boundedFetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal == null ? AbortSignal.timeout(15_000) : AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]),
    })
  const client = await connectDshPlatformClient(resolveLaunchUrl === undefined ? { fetch: boundedFetch } : { url: resolveLaunchUrl, fetch: boundedFetch })
  const operations = await createTaskGateway({
    runtime: createNativeTaskRuntime(client),
    projects: config.projects.map(project =>
      project.agentPreset === undefined ? { id: project.id, path: project.path } : { id: project.id, path: project.path, agentPreset: project.agentPreset },
    ),
    ledgerPath: config.ledgerPath,
    guiOrigin: config.guiOrigin,
  })
  let server: Awaited<ReturnType<typeof startGatewayServer>>
  try {
    server = await startGatewayServer({
      ...config.listen,
      operations,
      credentials: config.principals.map(principal => ({ principal, resolveToken: () => process.env[principal.tokenEnv] })),
    })
  } catch {
    await operations.close()
    throw new GatewayError('unavailable')
  }
  process.stdout.write(`${JSON.stringify({ state: 'listening', origin: server.origin, endpoint: '/mcp', publicListener: false })}\n`)
  let shutdown: Promise<void> | undefined
  const stop = (): void => {
    shutdown ??= (async () => {
      const deadline = setTimeout(() => {
        process.stderr.write('Gateway shutdown was not confirmed; outstanding admission may be unknown.\n')
        process.exit(1)
      }, 20_000)
      try {
        await server.close()
        process.stdout.write('Gateway closed. Existing DSH tasks remain owned by DSH.\n')
      } catch {
        process.stderr.write('Gateway shutdown was not confirmed.\n')
        process.exitCode = 1
      } finally {
        clearTimeout(deadline)
      }
    })()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
main().catch(error => {
  process.stderr.write(
    `DSH MCP gateway refused startup (${error instanceof GatewayError ? error.code : 'unavailable'}). No credential values or upstream diagnostics were retained.\n`,
  )
  process.exitCode = 1
})
