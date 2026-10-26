import { describe, expect, it, vi } from 'vitest'
import { createDshPlatformClientFromTransport, type DshPlatformTransport, type JsonValue, type SessionSummary } from '@dshfiles/dshx/platform'
import { createNativeTaskRuntime } from '../src/native-runtime.js'

const requestId = '8f745f7d-03ba-4594-bf9a-bd9714c7a502'
const event = (seq: number, type: string, data: JsonValue): JsonValue => ({ type: 'event', event: { seq, time: seq, type, data } })
const user = (seq = 1, text = 'Visible prompt'): JsonValue => event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (seq = 2, text = 'Visible reply'): JsonValue => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
const ended = (kind: string, seq = 3): JsonValue => event(seq, 'turn/end', { turn: 1, reason: { kind, error: { message: 'private-provider-diagnostic' } } })

function fixture(
  input: {
    readonly records?: readonly JsonValue[]
    readonly running?: boolean
    readonly pending?: number
    readonly watermark?: number
    readonly inboxAbsent?: boolean
    readonly cached?: boolean
    readonly blank?: boolean
    readonly missing?: boolean
  } = {},
) {
  const records = input.records ?? [user(), assistant(), ended('completed')]
  const rpc = vi.fn<DshPlatformTransport['rpc']>(async (namespace, method) => {
    expect(namespace).toBe('session')
    if (method === 'create') return { sessionId: 'actual-session' }
    if (method === 'rename') return { title: 'Native canonical title', seq: 0 }
    if (method === 'prompt' || method === 'cancel') return { accepted: true }
    if (method === 'page') return { records, hasMore: true }
    if (method === 'list') {
      let summary: SessionSummary = {
        sessionId: 'actual-session',
        updatedAt: 0,
        running: input.running ?? false,
        blank: input.blank ?? false,
        agentAvailable: true,
      }
      if (!input.inboxAbsent)
        summary = {
          ...summary,
          projections: {
            kind: input.cached ? 'cached' : 'sequenced',
            asOfSeq: input.watermark ?? 3,
            values: { inbox: { 'next-turn': Array.from({ length: input.pending ?? 0 }, () => null), 'next-step': [] } },
          },
        }
      return { items: input.missing ? [] : [summary] }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const sessionCursor = vi.fn(async () => 100)
  const client = createDshPlatformClientFromTransport({ rpc, sessionCursor })
  return { rpc, sessionCursor, runtime: createNativeTaskRuntime(client) }
}

describe('native task runtime through the real public SDK', () => {
  it('passes only operator project settings and returns the actual native identity', async () => {
    const { runtime, rpc } = fixture()
    await expect(
      runtime.create({ sessionId: 'requested-session', project: { id: 'allowed', path: '/operator/path', agentPreset: 'operator-preset' } }),
    ).resolves.toEqual({ sessionId: 'actual-session' })
    expect(rpc).toHaveBeenLastCalledWith('session', 'create', {
      request: { sessionId: 'requested-session', cwd: '/operator/path', agentPreset: 'operator-preset' },
    })
    await runtime.rename('actual-session', 'Requested title')
    expect(rpc).toHaveBeenLastCalledWith('session', 'rename', { request: { sessionId: 'actual-session', title: 'Requested title' } })
    await runtime.send({ sessionId: 'actual-session', prompt: 'Do this once', requestId })
    expect(rpc).toHaveBeenLastCalledWith(
      'session',
      'prompt',
      { request: { requestId, sessionId: 'actual-session', mode: 'queue', content: [{ type: 'text', text: 'Do this once' }] } },
      undefined,
    )
  })

  it.each([
    ['completed', 'completed'],
    ['error', 'failed'],
    ['aborted', 'cancelled'],
    ['blocked', 'unknown'],
    ['interrupted', 'unknown'],
    ['max-tokens', 'unknown'],
    ['forked', 'unknown'],
  ])('maps only proven native turn reason %s to %s', async (kind, state) => {
    const { runtime } = fixture({ records: [user(), assistant(), ended(kind)] })
    const snapshot = await runtime.read('actual-session')
    expect(snapshot).toEqual({ state, sequence: 3, text: 'Visible reply', error: state === 'failed' ? 'Native DSH turn failed.' : null })
    expect(JSON.stringify(snapshot)).not.toContain('private-provider-diagnostic')
  })

  it('bounds history, requests only inbox projection, and observes live state after the history cut', async () => {
    const { runtime, rpc, sessionCursor } = fixture({ running: true })
    expect((await runtime.read('actual-session')).state).toBe('running')
    expect(sessionCursor).toHaveBeenCalledWith('actual-session')
    expect(rpc.mock.calls.map(call => call[1])).toEqual(['page', 'list'])
    expect(rpc.mock.calls[0]).toEqual([
      'session',
      'page',
      { request: { address: { kind: 'session', sessionId: 'actual-session' }, throughSeq: 100, maxMessages: 50 } },
    ])
    expect(rpc.mock.calls[1]).toEqual(['session', 'list', { _request: { projections: ['inbox'] } }])
  })

  it('does not equate old completion or cancellation with new queued work being done', async () => {
    for (const kind of ['completed', 'aborted']) {
      const pending = fixture({ pending: 1, records: [user(), assistant(), ended(kind)] })
      expect((await pending.runtime.read('actual-session')).state).toBe('accepted')
    }
    const newerUser = fixture({ records: [user(), assistant(), ended('completed'), user(4, 'New prompt')], watermark: 4 })
    expect(await newerUser.runtime.read('actual-session')).toMatchObject({ state: 'accepted', sequence: 4, text: 'New prompt' })
    const newTurn = fixture({ records: [user(), assistant(), ended('completed'), event(4, 'turn/start', { turn: 2 })], watermark: 4 })
    expect((await newTurn.runtime.read('actual-session')).state).toBe('accepted')
  })

  it('requires current native inbox and user/turn evidence before reporting terminal state', async () => {
    for (const options of [
      { inboxAbsent: true },
      { cached: true },
      { watermark: 4 },
      { records: [assistant(), ended('completed')] },
      { records: [assistant()] },
      { records: [] },
    ]) {
      expect((await fixture(options).runtime.read('actual-session')).state).toBe('unknown')
    }
    expect((await fixture({ records: [], blank: true, inboxAbsent: true }).runtime.read('actual-session')).state).toBe('accepted')
  })

  it('publishes only the latest visible user or assistant text, never reasoning, tool args, or injected context', async () => {
    const { runtime } = fixture({
      records: [
        user(),
        event(2, 'assistant/message', {
          message: {
            content: [
              { type: 'reasoning', text: '**hidden-reasoning**' },
              { type: 'tool-call', arguments: 'secret-tool-args' },
              { type: 'text', text: 'Visible only' },
            ],
          },
        }),
        event(3, 'tool/call', { name: 'bash', callId: 'private-call', arguments: '{"command":"secret-command"}' }),
        event(4, 'user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'private-injected-context' }] }),
      ],
      watermark: 4,
    })
    const snapshot = await runtime.read('actual-session')
    expect(snapshot.text).toBe('Visible only')
    expect(Object.keys(snapshot).sort()).toEqual(['error', 'sequence', 'state', 'text'])
    expect(JSON.stringify(snapshot)).not.toMatch(/hidden-reasoning|secret-tool|secret-command|private-injected/)
    const bounded = fixture({ records: [user(), assistant(2, 'x'.repeat(20_000)), ended('completed')] })
    expect((await bounded.runtime.read('actual-session')).text).toHaveLength(16_000)
  })

  it('keeps cancel acknowledgement separate from observed native completion', async () => {
    const { runtime, rpc } = fixture({ running: true })
    await expect(runtime.cancel('actual-session')).resolves.toEqual({ accepted: true })
    expect(rpc).toHaveBeenLastCalledWith('session', 'cancel', { request: { sessionId: 'actual-session' } })
    expect((await runtime.read('actual-session')).state).toBe('running')
    expect((await fixture({ pending: 1, records: [user(), ended('aborted')] }).runtime.read('actual-session')).state).toBe('accepted')
  })

  it('fails closed on a missing Session and propagates native admission rejection', async () => {
    await expect(fixture({ missing: true }).runtime.read('actual-session')).rejects.toMatchObject({ code: 'not-found' })
    const { runtime, rpc } = fixture()
    rpc.mockRejectedValueOnce(new Error('Native refused'))
    await expect(runtime.send({ sessionId: 'actual-session', prompt: 'Rejected', requestId })).rejects.toThrow('Native refused')
    await expect(runtime.send({ sessionId: 'actual-session', prompt: 'Invalid', requestId: 'not-a-uuid' })).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
