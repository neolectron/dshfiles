// Scratch-only adapter: exercises the real Bots Host/store/API/UI without an external account.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const name = 'bots-fixture-adapter'
export const inject = ['botAdapters']
export function apply(ctx) {
  const home = process.env.DSH_HOME
  if (!home || !home.includes('dshx-')) throw new Error('The Bots fixture may run only in a scratch DSH home.')
  const path = join(home, 'bots-fixture-remote.json')
  let writes = Promise.resolve()
  const load = async () => {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { messages: [], sequence: 0, proactiveAt: null, proactiveSent: false }
    }
  }
  const save = state => writeFile(path, JSON.stringify(state), { mode: 0o600 })
  const serial = fn => {
    const next = writes.then(fn)
    writes = next.catch(() => undefined)
    return next
  }
  const message = (state, author, text, conversationId, requestId = null) => {
    const at = Date.now()
    const result = {
      id: `fixture-${String(++state.sequence)}`,
      requestId,
      author,
      text,
      notice: null,
      nativeUrl: null,
      createdAt: at,
      updatedAt: at,
      conversationId,
    }
    state.messages.push(result)
    return result
  }
  const normalized = row => ({
    id: row.id,
    requestId: row.requestId,
    author: row.author,
    text: row.text,
    notice: row.notice,
    nativeUrl: row.nativeUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  const adapter = {
    info: {
      id: 'fixture-durable-bot',
      version: 1,
      name: 'Fixture provider',
      description: 'Scratch-only provider proving adapter substitution without OpenAI.',
      risk: 'Synthetic local test data only. No external account or credentials are used.',
      credentialManagement: {
        label: 'Allow synthetic credential saves',
        description: 'Exercise only the synthetic permission lifecycle; no vault is accessed.',
      },
      fields: [{ key: 'endpointLabel', label: 'Endpoint label', kind: 'text', required: true, help: 'Enter test for the isolated synthetic provider.' }],
    },
    pollIntervalMs: 1000,
    validateConfig(config) {
      if (config.endpointLabel !== 'test') throw new Error('Use the test fixture endpoint label.')
    },
    async open({ config, signal }) {
      this.validateConfig(config)
      signal.throwIfAborted()
      let closed = false
      const check = current => {
        signal.throwIfAborted()
        current.throwIfAborted()
        if (closed) throw new Error('Fixture is disconnected.')
      }
      return {
        accountId: 'fixture-account',
        bots: [
          {
            remoteId: 'fixture-bot',
            name: 'Fixture assistant',
            description: 'A synthetic durable agent.',
            nativeUrl: null,
            capabilities: { text: true, attachments: false, approvals: false, activity: false },
            conversations: [
              { id: 'conversation-1', title: 'Main', historyScope: 'since-link', initialCursor: 'baseline' },
              { id: 'conversation-2', title: 'Project', historyScope: 'since-link', initialCursor: 'baseline' },
            ],
          },
        ],
        async bindCredentialReferences({ publish, signal: managementSignal }) {
          check(managementSignal)
          publish.assertActive()
          // This is a consent/dispatch fixture, not a pretend vault implementation.
        },
        poll(input) {
          return serial(async () => {
            check(input.signal)
            const state = await load()
            if (state.proactiveAt !== null && !state.proactiveSent && Date.now() >= state.proactiveAt) {
              message(state, 'bot', 'A proactive update from Fixture assistant.', 'conversation-1')
              state.proactiveSent = true
              await save(state)
            }
            const items = state.messages.filter(row => row.conversationId === input.conversationId)
            const position = input.cursor === null || input.cursor === 'baseline' ? -1 : items.findIndex(row => row.id === input.cursor)
            if (input.cursor !== null && input.cursor !== 'baseline' && position < 0) throw new Error('Unknown fixture cursor.')
            const rows = items.slice(position + 1, position + 33)
            check(input.signal)
            return { messages: rows.map(normalized), cursor: rows.at(-1)?.id ?? input.cursor, hasMore: position + 1 + rows.length < items.length }
          })
        },
        send(input) {
          return serial(async () => {
            check(input.signal)
            const state = await load()
            const existing = state.messages.find(row => row.requestId === input.requestId)
            if (existing) return normalized(existing)
            const sent = message(state, 'user', input.text, input.conversationId, input.requestId)
            message(state, 'bot', `Echo: ${input.text}`, input.conversationId)
            if (state.proactiveAt === null) state.proactiveAt = Date.now() + 1500
            await save(state)
            check(input.signal)
            return normalized(sent)
          })
        },
        reconcile(input) {
          return serial(async () => {
            check(input.signal)
            const state = await load()
            const found = state.messages.find(row => row.requestId === input.requestId)
            return found ? { kind: 'found', message: normalized(found) } : { kind: 'not-found' }
          })
        },
        async close() {
          closed = true
          await writes
        },
      }
    },
  }
  ctx.effect(() => ctx.botAdapters.register(adapter), 'bots: synthetic fixture adapter')
}
