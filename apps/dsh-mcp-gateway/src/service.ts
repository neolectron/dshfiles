import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  GatewayError,
  cancelTaskInputSchema,
  createTaskInputSchema,
  listTasksInputSchema,
  readTaskInputSchema,
  sendMessageInputSchema,
  taskStateSchema,
} from './contracts.js'
import type { GatewayAction, GatewayOperations, GatewayPrincipal, GatewayProject, GatewayRuntime, GatewayTask } from './contracts.js'
import { openLedger } from './ledger.js'

const uncertain = 'The native DSH operation has an unknown outcome; it was not retried.'
const readFailed = 'The native DSH task could not be read.'
const nativeError = 'The native DSH task reported an error.'
const snapshotSchema = z.object({
  state: taskStateSchema,
  sequence: z.number().int().nonnegative().nullable(),
  text: z.string().nullable(),
  error: z.string().nullable(),
})

export async function createTaskGateway(options: {
  readonly runtime: GatewayRuntime
  readonly projects: readonly GatewayProject[]
  readonly ledgerPath: string
  readonly guiOrigin: string
}): Promise<GatewayOperations> {
  const { runtime } = options
  const projects = new Map<string, GatewayProject>()
  let origin: string
  try {
    const url = new URL(options.guiOrigin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('origin')
    origin = url.origin
    for (const project of options.projects) {
      createTaskInputSchema.shape.project.parse(project.id)
      if (projects.has(project.id) || !project.path.startsWith('/')) throw new Error('project')
      projects.set(project.id, Object.freeze({ ...project }))
    }
    if (projects.size === 0 || projects.size > 1000) throw new Error('projects')
  } catch {
    throw new GatewayError('invalid-config')
  }
  const ledger = openLedger(options.ledgerPath)
  type Row = NonNullable<ReturnType<typeof ledger.task>>
  type Operation = NonNullable<ReturnType<typeof ledger.operation>>
  let closing = false
  let closed: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()
  function run<T>(work: () => Promise<T> | T): Promise<T> {
    if (closing) return Promise.reject(new GatewayError('unavailable'))
    const promise = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        throw error instanceof GatewayError ? error : new GatewayError('unavailable')
      })
    active.add(promise)
    void promise
      .finally(() => {
        active.delete(promise)
      })
      .catch(() => {})
    return promise
  }
  function validate<T>(schema: z.ZodType<T>, input: T): T {
    const result = schema.safeParse(input)
    if (!result.success) throw new GatewayError('forbidden')
    return result.data
  }
  function authorize(principal: GatewayPrincipal, action?: GatewayAction) {
    validate(createTaskInputSchema.shape.project, principal.id)
    if (action && !principal.actions.includes(action)) throw new GatewayError('forbidden')
  }
  function allowProject(principal: GatewayPrincipal, project: string) {
    if (!projects.has(project) || !principal.projects.includes(project)) throw new GatewayError('forbidden')
  }
  function owned(principal: GatewayPrincipal, id: string) {
    const row = ledger.task(id)
    if (!row || row.principal !== principal.id) throw new GatewayError('not-found')
    allowProject(principal, row.project)
    return row
  }
  function task(row: Row, overrides: Partial<GatewayTask> = {}): GatewayTask {
    return {
      taskId: row.id,
      project: row.project,
      title: row.title,
      sessionId: row.session_id,
      url: `${origin}/?thread=${encodeURIComponent(row.session_id)}`,
      state: row.cancel_requested ? 'cancellation-requested' : row.admission === 'accepted' ? 'accepted' : 'unknown',
      admission: row.admission,
      sequence: null,
      text: null,
      error: row.diagnostic ?? (row.admission === 'unknown' ? uncertain : null),
      createdAt: row.created_at,
      ...overrides,
    }
  }
  function freshRow(id: string) {
    const row = ledger.task(id)
    if (!row) throw new GatewayError('unavailable')
    return row
  }
  function replay(op: Operation): GatewayTask {
    // A persisted pending intent may belong to another live process OR a dead
    // process. Neither a timer nor startup may steal its claim and redispatch.
    if (op.status === 'pending') throw new GatewayError('busy')
    const row = freshRow(op.task_id)
    return task(
      row,
      op.status === 'unknown' || op.status === 'refused'
        ? { state: 'unknown', admission: op.status === 'refused' ? 'refused' : 'unknown', error: op.diagnostic ?? uncertain }
        : {},
    )
  }
  function operation(principal: GatewayPrincipal, action: Operation['action'], key: string, payload: readonly string[], taskId: string): Operation {
    return {
      principal: principal.id,
      key,
      action,
      hash: createHash('sha256')
        .update(JSON.stringify([action, payload]))
        .digest('hex'),
      task_id: taskId,
      request_id: randomUUID(),
      phase: `${action}-intent`,
      status: 'pending',
      diagnostic: null,
    }
  }
  function unknown(op: Operation, create = false) {
    ledger.finish(op, 'unknown', uncertain)
    if (create) ledger.admission(op.task_id, 'unknown', uncertain)
    return task(freshRow(op.task_id), { state: 'unknown', admission: 'unknown', error: uncertain })
  }
  async function observe(row: Row): Promise<GatewayTask> {
    // A requested ID from a lost create ACK is only a recovery hint, not proof
    // of native Session ownership. Do not expose a transcript or infer completion.
    if (!row.session_known) return task(row, { state: 'unknown', error: uncertain })
    try {
      const snapshot = snapshotSchema.parse(await runtime.read(row.session_id))
      // Stopping a turn is only a request. A completed/idle observation is not
      // evidence that native goals, schedules, or all future work were cancelled.
      const state = row.cancel_requested && snapshot.state !== 'cancelled' ? 'cancellation-requested' : snapshot.state
      return task(row, { ...snapshot, state, error: snapshot.error === null ? null : nativeError })
    } catch {
      return task(row, { state: 'unknown', error: readFailed })
    }
  }
  return {
    health(principal) {
      return run(() => {
        authorize(principal)
        return { ready: true as const, projects: [...projects.keys()].filter(id => principal.projects.includes(id)), protocol: 'dsh-task-gateway-v1' as const }
      })
    },
    create(principal, supplied) {
      return run(async () => {
        authorize(principal, 'create')
        const input = validate(createTaskInputSchema, supplied)
        allowProject(principal, input.project)
        const project = projects.get(input.project)
        if (!project) throw new GatewayError('forbidden')
        const id = `task-${randomUUID()}`
        const row: Row = {
          id,
          principal: principal.id,
          project: input.project,
          title: input.title,
          session_id: `session-${randomUUID()}`,
          session_known: 0,
          admission: 'unknown',
          diagnostic: null,
          created_at: Date.now(),
          cancel_requested: 0,
        }
        const claim = ledger.claim(operation(principal, 'create', input.idempotencyKey, [input.project, input.title, input.prompt], id), row)
        if (!claim.fresh) return replay(claim.operation)
        const op = claim.operation
        try {
          const created = await runtime.create({ project, sessionId: row.session_id })
          validate(readTaskInputSchema, { taskId: created.sessionId })
          ledger.session(id, created.sessionId)
          ledger.phase(op, 'create-ack')
        } catch {
          return unknown(op, true)
        }
        const sessionId = freshRow(id).session_id
        ledger.phase(op, 'rename-intent')
        try {
          await runtime.rename(sessionId, input.title)
          ledger.phase(op, 'rename-ack')
        } catch {
          // Rename is cosmetic. The actual created Session must not be orphaned
          // or recreated because its title could not be changed.
          ledger.phase(op, 'rename-unknown')
        }
        if (freshRow(id).cancel_requested) {
          ledger.admission(id, 'refused', 'The initial prompt was not submitted because cancellation was requested.')
          ledger.finish(op, 'refused', 'The initial prompt was not submitted because cancellation was requested.')
          return task(freshRow(id))
        }
        ledger.phase(op, 'prompt-intent')
        try {
          await runtime.send({ sessionId, prompt: input.prompt, requestId: op.request_id })
          ledger.phase(op, 'prompt-ack')
          ledger.admission(id, 'accepted', null)
          ledger.finish(op, 'ack')
          return task(freshRow(id))
        } catch {
          return unknown(op, true)
        }
      })
    },
    send(principal, supplied) {
      return run(async () => {
        authorize(principal, 'send')
        const input = validate(sendMessageInputSchema, supplied)
        const row = owned(principal, input.taskId)
        if (row.cancel_requested) throw new GatewayError('forbidden')
        const claim = ledger.claim(operation(principal, 'send', input.idempotencyKey, [input.taskId, input.prompt], row.id))
        if (!claim.fresh) return replay(claim.operation)
        const op = claim.operation
        // A possible create ID is not sufficient admission for another prompt.
        if (!row.session_known) {
          ledger.finish(op, 'refused', uncertain)
          return replay({ ...op, status: 'refused', diagnostic: uncertain })
        }
        try {
          const snapshot = snapshotSchema.parse(await runtime.read(row.session_id))
          if (snapshot.state === 'cancelled' || snapshot.state === 'cancellation-requested' || freshRow(row.id).cancel_requested) {
            ledger.cancellation(row.id)
            ledger.finish(op, 'refused', 'A cancelled task cannot accept another gateway prompt.')
            return task(freshRow(row.id), { admission: 'refused', error: 'A cancelled task cannot accept another gateway prompt.' })
          }
        } catch {
          ledger.finish(op, 'refused', readFailed)
          return task(freshRow(row.id), { state: 'unknown', admission: 'refused', error: readFailed })
        }
        try {
          await runtime.send({ sessionId: row.session_id, prompt: input.prompt, requestId: op.request_id })
          ledger.finish(op, 'ack')
          return task(freshRow(row.id), { state: 'accepted', admission: 'accepted', error: null })
        } catch {
          return unknown(op)
        }
      })
    },
    read(principal, supplied) {
      return run(async () => {
        authorize(principal, 'read')
        const input = validate(readTaskInputSchema, supplied)
        return observe(owned(principal, input.taskId))
      })
    },
    list(principal, supplied) {
      return run(() => {
        authorize(principal, 'list')
        const input = validate(listTasksInputSchema, supplied)
        if (input.cursor) owned(principal, input.cursor)
        const allowed = [...projects.keys()].filter(id => principal.projects.includes(id))
        const rows = ledger.list(principal.id, allowed, input.limit + 1, input.cursor)
        const more = rows.length > input.limit
        const page = rows.slice(0, input.limit)
        return { tasks: page.map(row => task(row, { text: null, error: null })), nextCursor: more ? (page.at(-1)?.id ?? null) : null }
      })
    },
    cancel(principal, supplied) {
      return run(async () => {
        authorize(principal, 'cancel')
        const input = validate(cancelTaskInputSchema, supplied)
        const row = owned(principal, input.taskId)
        const claim = ledger.claim(operation(principal, 'cancel', input.idempotencyKey, [input.taskId], row.id))
        if (!claim.fresh) return replay(claim.operation)
        const op = claim.operation
        // Gate later prompts before the effect: even a lost cancellation ACK
        // must not allow a fresh gateway message to revive the task.
        ledger.cancellation(row.id)
        if (!row.session_known) {
          ledger.finish(op, 'refused', uncertain)
          return replay({ ...op, status: 'refused', diagnostic: uncertain })
        }
        try {
          await runtime.cancel(row.session_id)
          ledger.finish(op, 'ack')
          return task(freshRow(row.id))
        } catch {
          return unknown(op)
        }
      })
    },
    close() {
      if (!closed) {
        closing = true
        closed = (async () => {
          await Promise.allSettled([...active])
          ledger.close()
        })()
      }
      return closed
    },
  }
}
