import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  cancelTaskInputSchema,
  createTaskInputSchema,
  GatewayError,
  healthInputSchema,
  healthResultSchema,
  taskResultSchema,
  listResultSchema,
  listTasksInputSchema,
  readTaskInputSchema,
  sendMessageInputSchema,
  type GatewayOperations,
  type GatewayPrincipal,
} from './contracts.js'

/** Per-request protocol facade. It never grants more authority than the authenticated principal. */
export function createGatewayMcpServer(operations: GatewayOperations, principal: GatewayPrincipal): McpServer {
  const server = new McpServer(
    { name: 'dsh-task-gateway', version: '0.1.0' },
    {
      instructions:
        'Delegate authorized work into native DSH tasks. Reuse the exact idempotencyKey and payload after a lost response. Accepted is not completed; poll dsh_read_task for observed results. Unknown admission must not be retried with a new key. Only configured projects and this principal’s gateway-created tasks are accessible. This server does not expose arbitrary DSH tools, account credentials or Codex conversations.',
    },
  )
  type GatewayReply = Awaited<ReturnType<GatewayOperations['health' | 'create' | 'send' | 'read' | 'list' | 'cancel']>>
  const run = async (operation: () => Promise<GatewayReply>): Promise<CallToolResult> => {
    try {
      const result = { result: await operation() }
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      const code = error instanceof GatewayError ? error.code : 'unavailable'
      return { isError: true, content: [{ type: 'text', text: `DSH task operation refused (${code}). No automatic new task or message retry is authorized.` }] }
    }
  }
  server.registerTool(
    'dsh_health',
    {
      title: 'Check DSH task connection',
      description: 'Check the authenticated gateway and list this principal’s allowed project identifiers. No task is created.',
      inputSchema: healthInputSchema,
      outputSchema: healthResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => run(() => operations.health(principal)),
  )
  if (principal.actions.includes('create'))
    server.registerTool(
      'dsh_create_task',
      {
        title: 'Start a DSH task',
        description:
          'Only when the user authorizes work: start one native DSH task in an explicitly allowed project. Requires a stable idempotencyKey. Returns admission and task identity, not proof of successful execution.',
        inputSchema: createTaskInputSchema,
        outputSchema: taskResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      input => run(() => operations.create(principal, input)),
    )
  if (principal.actions.includes('send'))
    server.registerTool(
      'dsh_send_message',
      {
        title: 'Send a DSH task follow-up',
        description:
          'Only when the user authorizes the follow-up: queue one message on this principal’s existing task. Reuse its idempotencyKey after transport uncertainty; this does not silently resend or steer another task.',
        inputSchema: sendMessageInputSchema,
        outputSchema: taskResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      input => run(() => operations.send(principal, input)),
    )
  if (principal.actions.includes('read'))
    server.registerTool(
      'dsh_read_task',
      {
        title: 'Read DSH task status and result',
        description:
          'Read bounded latest visible output and observed execution state for one gateway task owned by this principal. Completion means the native turn ended, not that the user’s objective is verified.',
        inputSchema: readTaskInputSchema,
        outputSchema: taskResultSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      input => run(() => operations.read(principal, input)),
    )
  if (principal.actions.includes('list'))
    server.registerTool(
      'dsh_list_tasks',
      {
        title: 'List DSH tasks',
        description:
          'List only gateway-created tasks belonging to this authenticated principal and currently authorized projects. Does not enumerate unrelated conversations.',
        inputSchema: listTasksInputSchema,
        outputSchema: listResultSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      input => run(() => operations.list(principal, input)),
    )
  if (principal.actions.includes('cancel'))
    server.registerTool(
      'dsh_cancel_task',
      {
        title: 'Cancel DSH task execution',
        description:
          'Only when the user asks to stop: request cancellation of this task’s active native work. An accepted cancellation request is not confirmed termination. Read status afterward; this does not delete the conversation or revoke all future schedules.',
        inputSchema: cancelTaskInputSchema,
        outputSchema: taskResultSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      input => run(() => operations.cancel(principal, input)),
    )
  return server
}
