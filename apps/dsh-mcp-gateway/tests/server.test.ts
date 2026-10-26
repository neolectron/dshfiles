import { request as nodeRequest } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { JsonText } from '@dshfiles/dshx/api'
import {
  JSONRPCResponseSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  type JSONRPCRequest,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { GatewayError, type GatewayOperations, type GatewayPrincipal, type GatewayTask } from '../src/contracts.js'
import { startGatewayServer } from '../src/server.js'

const token = 'SYNTH_gateway_principal_token_1234567890'
const readerToken = 'SYNTH_gateway_reader_token_1234567890123'
const principal: GatewayPrincipal = { id: 'yield', projects: ['demo'], actions: ['create', 'read', 'list', 'send', 'cancel'] }
const task: GatewayTask = {
  taskId: 'task-proof',
  project: 'demo',
  title: 'Synthetic proof',
  sessionId: 'session-proof',
  url: 'http://localhost:3198/?thread=session-proof',
  state: 'accepted',
  admission: 'accepted',
  sequence: null,
  text: null,
  error: null,
  createdAt: 1,
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const fixture = async () => {
  const calls: Array<{ operation: string; principal: string }> = []
  const state = { token, closed: false }
  const operations: GatewayOperations = {
    health: async caller => {
      calls.push({ operation: 'health', principal: caller.id })
      return { ready: true, projects: caller.projects, protocol: 'dsh-task-gateway-v1' }
    },
    create: async caller => {
      calls.push({ operation: 'create', principal: caller.id })
      return task
    },
    send: async caller => {
      calls.push({ operation: 'send', principal: caller.id })
      return task
    },
    read: async caller => {
      calls.push({ operation: 'read', principal: caller.id })
      throw new GatewayError('not-found')
    },
    list: async caller => {
      calls.push({ operation: 'list', principal: caller.id })
      return { tasks: [], nextCursor: null }
    },
    cancel: async caller => {
      calls.push({ operation: 'cancel', principal: caller.id })
      return { ...task, state: 'cancellation-requested' }
    },
    close: async () => {
      state.closed = true
    },
  }
  const server = await startGatewayServer({
    host: '127.0.0.1',
    port: 0,
    operations,
    credentials: [
      { principal, resolveToken: () => state.token },
      { principal: { id: 'reader', projects: ['demo'], actions: ['read', 'list'] }, resolveToken: () => readerToken },
    ],
  })
  cleanups.push(server.close)
  const connect = async (bearer = token) => {
    let requestId = 0
    const exchange = async (method: string, params: NonNullable<JSONRPCRequest['params']>) => {
      const response = await fetch(`${server.origin}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Synthetic MCP HTTP status ${response.status}`)
      }
      const envelope = JsonText.parse(await response.text(), JSONRPCResponseSchema)
      if ('error' in envelope) throw new Error('Synthetic MCP protocol refusal')
      return envelope.result
    }
    InitializeResultSchema.parse(
      await exchange('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-external-client', version: '1.0.0' } }),
    )
    return {
      listTools: async () => ListToolsResultSchema.parse(await exchange('tools/list', {})),
      callTool: async (input: CallToolRequest['params']) => CallToolResultSchema.parse(await exchange('tools/call', input)),
    }
  }
  return { server, calls, state, connect }
}

it('implements MCP initialization and exposes exactly the scoped HTTP task tools', async () => {
  const test = await fixture()
  const client = await test.connect()
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
    'dsh_cancel_task',
    'dsh_create_task',
    'dsh_health',
    'dsh_list_tasks',
    'dsh_read_task',
    'dsh_send_message',
  ])
  const health = await client.callTool({ name: 'dsh_health', arguments: {} })
  expect(health.isError).not.toBe(true)
  expect(health.structuredContent).toEqual({ result: { ready: true, projects: ['demo'], protocol: 'dsh-task-gateway-v1' } })
  const created = await client.callTool({
    name: 'dsh_create_task',
    arguments: { project: 'demo', title: 'Proof', prompt: 'Synthetic only', idempotencyKey: 'proof-key-0001' },
  })
  expect(created.structuredContent).toEqual({ result: task })
  expect(test.calls).toEqual([
    { operation: 'health', principal: 'yield' },
    { operation: 'create', principal: 'yield' },
  ])
})

it('reports absent OAuth metadata as 404 without weakening MCP bearer authentication', async () => {
  const test = await fixture()
  for (const path of ['/', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await fetch(`${test.server.origin}${path}`)
    expect(response.status).toBe(404)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(await response.text()).not.toContain('dsh_create_task')
  }
  expect(test.calls).toEqual([])
  const unauthenticated = await fetch(`${test.server.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' })
  expect(unauthenticated.status).toBe(401)
  await unauthenticated.body?.cancel()
  expect(test.calls).toEqual([])
})

it('rejects missing/wrong bearer before parsing or revealing any tool metadata', async () => {
  const test = await fixture()
  for (const authorization of ['', 'Bearer wrong']) {
    const response = await fetch(`${test.server.origin}/mcp`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: '{invalid',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('dsh_create_task')
  }
  expect(test.calls).toEqual([])
})

it('rejects browser Origin and forged Host instead of trusting forwarded authority', async () => {
  const test = await fixture()
  for (const forged of [{ origin: 'https://evil.example' }, { host: 'evil.example', 'x-forwarded-host': new URL(test.server.origin).host }]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = nodeRequest(
        `${test.server.origin}/mcp`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...forged } },
        response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end('{}')
    })
    expect(status).toBe(403)
  }
  expect(test.calls).toEqual([])
})

it('filters discovery and refuses a write tool for a read-only principal', async () => {
  const test = await fixture()
  const client = await test.connect(readerToken)
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['dsh_health', 'dsh_list_tasks', 'dsh_read_task'])
  expect(
    (
      await client.callTool({
        name: 'dsh_create_task',
        arguments: { project: 'demo', title: 'Proof', prompt: 'No authority', idempotencyKey: 'proof-key-0002' },
      })
    ).isError,
  ).toBe(true)
  expect(test.calls).toEqual([])
})

it('requires new HTTP authorization after token rotation, even on an existing MCP client', async () => {
  const test = await fixture()
  const client = await test.connect()
  test.state.token = 'SYNTH_gateway_rotated_token_123456789012'
  await expect(client.listTools()).rejects.toThrow()
  expect(test.calls).toEqual([])
})

it('keeps schema-invalid fields and arbitrary shell/account options out of the operation handler', async () => {
  const test = await fixture()
  const client = await test.connect()
  const response = await client.callTool({
    name: 'dsh_create_task',
    arguments: {
      project: 'demo',
      title: 'Proof',
      prompt: 'No extras',
      idempotencyKey: 'proof-key-0003',
      cwd: '/etc',
      provider: 'other-account',
      command: 'sh',
    },
  })
  expect(response.isError).toBe(true)
  expect(test.calls).toEqual([])
})

it('returns only a fixed operation error instead of leaking upstream details', async () => {
  const test = await fixture()
  const client = await test.connect()
  const response = await client.callTool({ name: 'dsh_read_task', arguments: { taskId: 'not-owned' } })
  expect(response.isError).toBe(true)
  expect(JSON.stringify(response)).toContain('not-found')
  expect(JSON.stringify(response)).not.toContain(token)
})

it('bounds HTTP input and rejects non-JSON methods without side effects', async () => {
  const test = await fixture()
  const common = { authorization: `Bearer ${token}` }
  const get = await fetch(`${test.server.origin}/mcp`, { headers: common })
  expect(get.status).toBe(405)
  await get.body?.cancel()
  const wrongType = await fetch(`${test.server.origin}/mcp`, { method: 'POST', headers: common, body: '{}' })
  expect(wrongType.status).toBe(415)
  await wrongType.body?.cancel()
  const large = await fetch(`${test.server.origin}/mcp`, {
    method: 'POST',
    headers: { ...common, 'content-type': 'application/json' },
    body: 'x'.repeat(129 * 1024),
  })
  expect(large.status).toBe(413)
  await large.body?.cancel()
  expect(test.calls).toEqual([])
})
