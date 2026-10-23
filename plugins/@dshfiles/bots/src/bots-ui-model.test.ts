import { describe, expect, it } from 'vitest'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'
import type { BotMessage } from './contract.js'
import { BotsUiModel } from './bots-ui-model.js'

const adapter: BotAdapterInfo = {
  id: 'neutral-provider',
  version: 1,
  name: 'Independent provider',
  description: 'An existing durable bot.',
  risk: 'This grants account access.',
  fields: [
    { key: 'account', label: 'Account reference', kind: 'secret-reference', required: true, help: 'Vault account.' },
    { key: 'session', label: 'Session reference', kind: 'secret-reference', required: true, help: 'Vault session.' },
    { key: 'region', label: 'Region', kind: 'text', required: false, help: 'Optional region.' },
  ],
}
const validForm = () => ({
  label: 'My existing bot',
  accepted: true,
  fields: [
    { key: 'account', value: 'secret:ACCOUNT' },
    { key: 'session', value: 'secret:SESSION@test' },
    { key: 'region', value: '' },
  ],
})
const message = (overrides: Partial<BotMessage> = {}): BotMessage => ({
  id: 'message-1',
  botId: 'bot-1',
  conversationId: 'conversation-1',
  remoteId: 'remote-1',
  requestId: null,
  author: 'bot',
  text: 'Hello',
  notice: null,
  nativeUrl: null,
  createdAt: 10,
  updatedAt: 10,
  delivery: 'received',
  ...overrides,
})

describe('Bots metadata connection form', () => {
  it('starts with unaccepted risks and no credential values', () => {
    const defaults = BotsUiModel.connectDefaults(adapter)
    expect(defaults.accepted).toBe(false)
    expect(defaults.fields.map(field => field.value)).toEqual(['', '', ''])
    expect(BotsUiModel.connectFormSchema(adapter).safeParse(defaults).success).toBe(false)
  })
  it('requires explicit consent even when reference fields are valid', () => {
    expect(BotsUiModel.connectFormSchema(adapter).safeParse({ ...validForm(), accepted: false }).success).toBe(false)
    expect(() => BotsUiModel.connectInput(adapter, { ...validForm(), accepted: false })).toThrow()
  })
  it('uses adapter metadata and the shared reference grammar, never raw tokens', () => {
    expect(BotsUiModel.connectInput(adapter, validForm())).toEqual({
      adapterId: 'neutral-provider',
      label: 'My existing bot',
      acceptRisks: true,
      config: { account: 'secret:ACCOUNT', session: 'secret:SESSION@test', region: '' },
    })
    for (const value of ['raw-access-token', 'Bearer abc', '{"token":"abc"}', 'secret:bad alias']) {
      const form = validForm()
      form.fields[0] = { key: 'account', value }
      expect(BotsUiModel.connectFormSchema(adapter).safeParse(form).success).toBe(false)
    }
  })
  it('refuses missing required fields and changed metadata', () => {
    const form = validForm()
    expect(BotsUiModel.connectFormSchema(adapter).safeParse({ ...form, fields: form.fields.slice(1) }).success).toBe(false)
    expect(BotsUiModel.connectFormSchema(adapter).safeParse({ ...form, fields: [...form.fields, { key: 'extra', value: 'unexpected' }] }).success).toBe(false)
    form.fields[0] = { key: 'account', value: '' }
    expect(BotsUiModel.connectFormSchema(adapter).safeParse(form).success).toBe(false)
  })
  it('accepts a completely different provider without provider-specific fields', () => {
    const other: BotAdapterInfo = {
      ...adapter,
      id: 'other',
      name: 'Another provider',
      fields: [{ key: 'endpointLabel', label: 'Endpoint label', kind: 'text', required: true, help: 'Name the endpoint.' }],
    }
    expect(BotsUiModel.connectInput(other, { label: 'Another bot', accepted: true, fields: [{ key: 'endpointLabel', value: 'test' }] }).config).toEqual({
      endpointLabel: 'test',
    })
  })
})

describe('Bots in-memory drafts and explicit send intent', () => {
  it('keeps separate drafts across bot and conversation navigation', () => {
    const drafts = BotsUiModel.createBotDrafts()
    const first = BotsUiModel.draftKey('bot-a', 'main')
    const second = BotsUiModel.draftKey('bot-b', 'main')
    const project = BotsUiModel.draftKey('bot-a', 'project')
    drafts.edit(first, 'First draft')
    drafts.edit(second, 'Second draft')
    drafts.edit(project, 'Project draft')
    expect(drafts.get(first).text).toBe('First draft')
    expect(drafts.get(second).text).toBe('Second draft')
    expect(drafts.get(project).text).toBe('Project draft')
    expect(BotsUiModel.draftKey('a,b', 'c')).not.toBe(BotsUiModel.draftKey('a', 'b,c'))
  })
  it('preserves the original UUID and body for an explicit retry', () => {
    const drafts = BotsUiModel.createBotDrafts()
    const key = BotsUiModel.draftKey('bot-a', 'main')
    const requestId = '8c455dd5-5138-442d-94da-84c2614d3d78'
    drafts.edit(key, 'Send exactly this')
    drafts.begin(key, requestId, 'Send exactly this')
    drafts.settle(key, requestId, 'uncertain')
    expect(drafts.get(key)).toEqual({ text: '', intent: { requestId, text: 'Send exactly this', phase: 'uncertain' } })
    const intent = drafts.get(key).intent
    if (intent === null) throw new Error('The explicit send intent must survive.')
    drafts.begin(key, intent.requestId, intent.text)
    expect(drafts.get(key).intent).toEqual({ requestId, text: 'Send exactly this', phase: 'sending' })
  })
  it('does not overwrite a newer draft or intent with a stale completion', () => {
    const drafts = BotsUiModel.createBotDrafts()
    drafts.edit('one', 'First')
    drafts.begin('one', 'request-1', 'First')
    drafts.edit('one', 'Next draft')
    drafts.begin('one', 'request-2', 'Retry body')
    drafts.settle('one', 'request-1', 'sent')
    expect(drafts.get('one').text).toBe('Next draft')
    expect(drafts.get('one').intent?.requestId).toBe('request-2')
    drafts.settle('one', 'request-2', 'sent')
    expect(drafts.get('one')).toEqual({ text: 'Next draft', intent: null })
  })
  it('drops only the removed bot drafts and notifies subscribed panes', () => {
    const drafts = BotsUiModel.createBotDrafts()
    let notifications = 0
    const unsubscribe = drafts.subscribe(() => {
      notifications++
    })
    drafts.edit(BotsUiModel.draftKey('one', 'main'), 'one')
    drafts.edit(BotsUiModel.draftKey('two', 'main'), 'two')
    drafts.forget('one')
    expect(drafts.get(BotsUiModel.draftKey('one', 'main')).text).toBe('')
    expect(drafts.get(BotsUiModel.draftKey('two', 'main')).text).toBe('two')
    expect(notifications).toBe(3)
    unsubscribe()
    drafts.edit('unused', '')
    expect(notifications).toBe(3)
  })
  it('lets a sent receipt override an earlier transport failure without resending', () => {
    const draft = { text: 'New draft', intent: { text: 'Old message', requestId: 'original', phase: 'uncertain' as const } }
    expect(BotsUiModel.visibleIntent(draft, [message({ requestId: 'other', delivery: 'sent' })])).toEqual(draft.intent)
    expect(BotsUiModel.visibleIntent(draft, [message({ requestId: 'original', delivery: 'sent' })])).toBeNull()
    expect(BotsUiModel.visibleIntent(draft, [message({ requestId: 'original', delivery: 'uncertain' })])).toEqual(draft.intent)
  })
})

describe('Bots safe rendering helpers', () => {
  it('permits only credential-free HTTPS native handoff links', () => {
    expect(BotsUiModel.nativeBotUrl('https://example.com/conversation/1')).toBe('https://example.com/conversation/1')
    for (const url of [
      null,
      '',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'file:///tmp/data',
      'http://example.com',
      'https://user:password@example.com',
      '//example.com',
    ])
      expect(BotsUiModel.nativeBotUrl(url)).toBeNull()
  })
  it('orders a copy of cached messages chronologically', () => {
    const input = [message({ id: 'b', createdAt: 20 }), message({ id: 'a', createdAt: 10 })]
    expect(BotsUiModel.chronologicalMessages(input).map(item => item.id)).toEqual(['a', 'b'])
    expect(input.map(item => item.id)).toEqual(['b', 'a'])
    const tied = [message({ id: 'z-user', author: 'user', createdAt: 10 }), message({ id: 'a-echo', createdAt: 10 })]
    expect(BotsUiModel.chronologicalMessages(tied).map(item => item.id)).toEqual(['z-user', 'a-echo'])
  })
  it('names connection health independently of remote activity', () => {
    expect(BotsUiModel.connectionLabel('connected')).toBe('Connected')
    expect(BotsUiModel.connectionLabel('adapter-missing')).toBe('Adapter unavailable')
    expect(BotsUiModel.connectionLabel('auth-required')).toBe('Authentication required')
    expect(BotsUiModel.connectionLabel('disconnected')).not.toMatch(/stop|deleted|idle/i)
  })
})
