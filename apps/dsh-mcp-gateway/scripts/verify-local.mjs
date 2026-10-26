#!/usr/bin/env node
// Operator-only probe. Reads a local credential reference; never prints its value.
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as waitForWork } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', default: false },
    url: { type: 'string', default: 'http://127.0.0.1:8790/mcp' },
    'credential-file': { type: 'string', default: join(homedir(), '.local/share/dsh-mcp-gateway/private/gateway.env') },
    project: { type: 'string', default: 'dshfiles' },
    'confirm-create': { type: 'boolean', default: false },
    'read-probe-task': { type: 'string' },
  },
})
if (values.help) {
  console.log(
    'Usage: node scripts/verify-local.mjs [--url http://127.0.0.1:8790/mcp] [--credential-file /private/gateway.env] [--project alias] [--confirm-create | --read-probe-task task-id]',
  )
  console.log(
    'Default: authenticated health only. --confirm-create authorizes one real native DSH model request with no tools or file edits, and an idempotency check. Credentials are never printed.',
  )
} else {
  let client
  let admitted
  let finished = false
  const deadline = AbortSignal.timeout(values['confirm-create'] ? 180_000 : 30_000)
  try {
    assert.ok(!(values['confirm-create'] && values['read-probe-task']), 'Choose either creation or a read-only probe receipt check')
    const url = new URL(values.url)
    assert.ok(
      url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname === '/mcp' &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password,
      'Only an explicit local MCP endpoint is supported',
    )
    const file = await open(values['credential-file'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let source
    try {
      const meta = await file.stat()
      assert.ok(
        meta.isFile() && meta.uid === process.getuid() && meta.nlink === 1 && (meta.mode & 0o777) === 0o600 && meta.size > 0 && meta.size <= 4096,
        'Private regular credential file required',
      )
      const buffer = Buffer.alloc(4097)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      assert.ok(bytesRead <= 4096)
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } finally {
      await file.close()
    }
    const token = parseEnv(source).DSH_MCP_YIELD_TOKEN
    assert.ok(token, 'Gateway credential reference is missing')
    const { healthResultSchema, taskResultSchema } = await import('@dshfiles/dsh-mcp-gateway/protocol')
    client = new Client({ name: 'dsh-local-operator-verification', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` }, signal: deadline } }), {
      signal: deadline,
      timeout: 15_000,
    })
    const health = healthResultSchema.parse(
      (await client.callTool({ name: 'dsh_health', arguments: {} }, undefined, { signal: deadline, timeout: 20_000 })).structuredContent,
    ).result
    assert.ok(health.ready && health.projects.includes(values.project), 'Project is not authorized')
    console.log(JSON.stringify({ phase: 'health', ready: true, projects: health.projects, nativeTaskCreated: false }))
    if (values['read-probe-task']) {
      const observed = taskResultSchema.parse(
        (await client.callTool({ name: 'dsh_read_task', arguments: { taskId: values['read-probe-task'] } }, undefined, { signal: deadline, timeout: 20_000 }))
          .structuredContent,
      ).result
      console.log(
        JSON.stringify({
          phase: 'existing-probe',
          state: observed.state,
          sequence: observed.sequence,
          expectedReplyObserved: observed.text?.trim() === 'DSH_MCP_LIVE_READY',
          taskId: observed.taskId,
          url: observed.url,
          nativeTaskCreated: false,
        }),
      )
      assert.equal(observed.state, 'completed')
      assert.equal(observed.text?.trim(), 'DSH_MCP_LIVE_READY')
    }
    if (values['confirm-create']) {
      const call = async (name, args) =>
        taskResultSchema.parse((await client.callTool({ name, arguments: args }, undefined, { signal: deadline, timeout: 20_000 })).structuredContent).result
      const input = {
        project: values.project,
        title: 'DSH MCP live connection verification',
        prompt:
          'Connection verification only. Do not call tools, edit files, run commands, create subtasks or schedule anything. Reply with exactly: DSH_MCP_LIVE_READY',
        idempotencyKey: `operator-probe-${randomUUID()}`,
      }
      admitted = await call('dsh_create_task', input)
      assert.equal(admitted.admission, 'accepted', 'Native task admission is not confirmed; do not retry with a new key')
      const repeated = await call('dsh_create_task', input)
      assert.equal(repeated.taskId, admitted.taskId)
      assert.equal(repeated.sessionId, admitted.sessionId)
      console.log(JSON.stringify({ phase: 'admission', taskId: admitted.taskId, sessionId: admitted.sessionId, url: admitted.url, duplicatePrevented: true }))
      while (!deadline.aborted) {
        const observed = await call('dsh_read_task', { taskId: admitted.taskId })
        if (observed.state === 'input-required') throw new Error('Native work unexpectedly requires input')
        if (['completed', 'failed', 'cancelled'].includes(observed.state)) {
          finished = true
          console.log(
            JSON.stringify({
              phase: 'native-result',
              state: observed.state,
              sequence: observed.sequence,
              expectedReplyObserved: observed.text?.trim() === 'DSH_MCP_LIVE_READY',
              taskId: observed.taskId,
              url: observed.url,
            }),
          )
          assert.equal(observed.state, 'completed')
          assert.equal(observed.text?.trim(), 'DSH_MCP_LIVE_READY')
          break
        }
        // Bounded monitoring of actual admitted work, not a readiness/discovery busy-loop.
        await waitForWork(3000, undefined, { signal: deadline })
      }
      assert.ok(finished, 'Native work was not confirmed complete')
    }
  } catch {
    let cancellationRequested = false
    if (client && admitted && !finished) {
      try {
        const result = await client.callTool(
          { name: 'dsh_cancel_task', arguments: { taskId: admitted.taskId, idempotencyKey: `operator-stop-${admitted.taskId}` } },
          undefined,
          { timeout: 15_000 },
        )
        cancellationRequested = result.isError !== true
      } catch {
        /* Transport uncertainty is reported, never hidden by a new task. */
      }
    }
    console.error(
      JSON.stringify({
        phase: 'verification-failed',
        taskId: admitted?.taskId ?? null,
        url: admitted?.url ?? null,
        cancellationRequested,
        terminationConfirmed: finished,
        credentialValuesDisplayed: false,
        retryWithNewKeyAuthorized: false,
      }),
    )
    process.exitCode = 1
  } finally {
    await client?.close()
  }
}
