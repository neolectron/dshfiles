import { z } from 'zod'

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)
const text = z.string().trim().min(1).max(20_000)
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u)
export const gatewayActionSchema = z.enum(['create', 'send', 'read', 'list', 'cancel'])
export type GatewayAction = z.infer<typeof gatewayActionSchema>
export interface GatewayPrincipal {
  readonly id: string
  readonly projects: readonly string[]
  readonly actions: readonly GatewayAction[]
}
export interface GatewayProject {
  readonly id: string
  readonly path: string
  readonly agentPreset?: string
}
export const createTaskInputSchema = z.object({ project: identifier, title: z.string().trim().min(1).max(200), prompt: text, idempotencyKey }).strict()
export const sendMessageInputSchema = z.object({ taskId: identifier, prompt: text, idempotencyKey }).strict()
export const readTaskInputSchema = z.object({ taskId: identifier }).strict()
export const listTasksInputSchema = z.object({ limit: z.number().int().min(1).max(50).default(20), cursor: identifier.optional() }).strict()
export const cancelTaskInputSchema = z.object({ taskId: identifier, idempotencyKey }).strict()
export const healthInputSchema = z.object({}).strict()
export const taskStateSchema = z.enum(['accepted', 'running', 'completed', 'failed', 'cancellation-requested', 'cancelled', 'input-required', 'unknown'])
export type TaskState = z.infer<typeof taskStateSchema>

/** Adapter-normalized observations from the one actual DSH runtime, never another agent loop. */
export interface NativeTaskSnapshot {
  readonly state: TaskState
  readonly sequence: number | null
  readonly text: string | null
  readonly error: string | null
}
export interface GatewayRuntime {
  create(input: { readonly project: GatewayProject; readonly sessionId: string }): Promise<{ readonly sessionId: string }>
  rename(sessionId: string, title: string): Promise<void>
  send(input: { readonly sessionId: string; readonly prompt: string; readonly requestId: string }): Promise<void>
  read(sessionId: string): Promise<NativeTaskSnapshot>
  cancel(sessionId: string): Promise<{ readonly accepted: true }>
}
export const gatewayTaskSchema = z
  .object({
    taskId: identifier,
    project: identifier,
    title: z.string().min(1).max(200),
    sessionId: identifier.nullable(),
    url: z.string().url().max(4096).nullable(),
    state: taskStateSchema,
    admission: z.enum(['accepted', 'unknown', 'refused']),
    sequence: z.number().int().nonnegative().nullable(),
    text: z.string().max(16_000).nullable(),
    error: z.string().max(512).nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
export type GatewayTask = z.infer<typeof gatewayTaskSchema>
export const healthResultSchema = z
  .object({ result: z.object({ ready: z.literal(true), projects: z.array(identifier).max(64), protocol: z.literal('dsh-task-gateway-v1') }).strict() })
  .strict()
export const taskResultSchema = z.object({ result: gatewayTaskSchema }).strict()
export const listResultSchema = z
  .object({ result: z.object({ tasks: z.array(gatewayTaskSchema).max(50), nextCursor: identifier.nullable() }).strict() })
  .strict()
export interface GatewayOperations {
  health(principal: GatewayPrincipal): Promise<{ readonly ready: true; readonly projects: readonly string[]; readonly protocol: 'dsh-task-gateway-v1' }>
  create(principal: GatewayPrincipal, input: z.infer<typeof createTaskInputSchema>): Promise<GatewayTask>
  send(principal: GatewayPrincipal, input: z.infer<typeof sendMessageInputSchema>): Promise<GatewayTask>
  read(principal: GatewayPrincipal, input: z.infer<typeof readTaskInputSchema>): Promise<GatewayTask>
  list(
    principal: GatewayPrincipal,
    input: z.infer<typeof listTasksInputSchema>,
  ): Promise<{ readonly tasks: readonly GatewayTask[]; readonly nextCursor: string | null }>
  cancel(principal: GatewayPrincipal, input: z.infer<typeof cancelTaskInputSchema>): Promise<GatewayTask>
  close(): Promise<void>
}
export class GatewayError extends Error {
  constructor(readonly code: 'forbidden' | 'not-found' | 'idempotency-conflict' | 'busy' | 'unavailable' | 'invalid-config') {
    super(`DSH task gateway refused the operation (${code}).`)
    this.name = 'GatewayError'
  }
}
