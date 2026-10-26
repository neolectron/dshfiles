import type { DshPlatformClient } from '@dshfiles/dshx/platform'
import { SessionDigestModel } from '@dshfiles/dshx/platform/session-digest'
import { GatewayError, type GatewayRuntime, type NativeTaskSnapshot, type TaskState } from './contracts.js'

const historyLimit = 50
const visibleTextLimit = 16_000

/** Native Sessions own all execution. This adapter only admits commands and projects bounded observations. */
export function createNativeTaskRuntime(client: DshPlatformClient): GatewayRuntime {
  return {
    async create({ project, sessionId }) {
      let request: Parameters<DshPlatformClient['sessions']['create']>[0] = { sessionId, cwd: project.path }
      if (project.agentPreset !== undefined) request = { ...request, agentPreset: project.agentPreset }
      const created = await client.sessions.create(request)
      return { sessionId: created.sessionId }
    },
    async rename(sessionId, title) {
      await client.sessions.rename(sessionId, title)
    },
    async send({ sessionId, prompt, requestId }) {
      await client.sessions.prompt(sessionId, prompt, 'queue', undefined, { requestId })
    },
    async read(sessionId): Promise<NativeTaskSnapshot> {
      // Read the list last: a queued followup or newly running turn must invalidate an older terminal history cut.
      const history = await client.sessions.history(sessionId, historyLimit)
      const summary = (await client.sessions.list(['inbox'])).find(item => item.sessionId === sessionId)
      if (summary === undefined) throw new GatewayError('not-found')
      const digest = SessionDigestModel.digest({ summary, records: history.records, now: Date.now(), actionLimit: 0 })
      const user = digest.lastUserPrompt
      const assistant = digest.lastAssistantText
      const latestText = assistant !== undefined && (user === undefined || assistant.seq > user.seq) ? assistant.text : user?.text
      const end = digest.lastTurnEnd
      let state: TaskState = 'unknown'
      if (summary.running) state = 'running'
      else if (summary.pendingMessages !== undefined && summary.pendingMessages > 0) state = 'accepted'
      else if (
        summary.pendingMessages === 0 &&
        summary.pendingMessagesAsOfSeq !== undefined &&
        digest.lastSeq !== undefined &&
        summary.pendingMessagesAsOfSeq <= digest.lastSeq
      ) {
        if (end !== undefined && user !== undefined && end.seq > user.seq) {
          // dsh-session/types TurnEndReasonMap: only these three reasons prove these terminal outcomes.
          if (end.kind === 'completed') state = 'completed'
          else if (end.kind === 'error') state = 'failed'
          else if (end.kind === 'aborted') state = 'cancelled'
        } else if (user !== undefined && (end === undefined || user.seq > end.seq)) state = 'accepted'
        else if (summary.blank) state = 'accepted'
      } else if (summary.blank && digest.lastSeq === undefined) state = 'accepted'
      return {
        state,
        sequence: digest.lastSeq ?? null,
        text: latestText?.slice(0, visibleTextLimit) ?? null,
        // Native failures can contain provider diagnostics or secrets; do not publish raw error chains.
        error: state === 'failed' ? 'Native DSH turn failed.' : null,
      }
    },
    async cancel(sessionId) {
      // Acknowledges active-turn cancellation only. Native cancel retains inbox work and may finish later.
      return client.sessions.cancel(sessionId)
    },
  }
}
