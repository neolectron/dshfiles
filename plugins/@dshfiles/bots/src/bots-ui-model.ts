import { parseSecretReference } from '@dshfiles/credential-port'
import { z } from 'zod'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'
import type { BotConnectInput, BotConnection, BotMessage } from './contract.js'

/** Browser-owned input only. Transcripts and credentials never enter this store. */
export interface BotDraft {
  readonly text: string
  readonly intent: { readonly requestId: string; readonly text: string; readonly phase: 'sending' | 'failed' | 'uncertain' } | null
}
const emptyDraft: BotDraft = { text: '', intent: null }

/** Provider-neutral presentation rules and the bundle's transient draft owner. */
export class BotsUiModel {
  static draftKey(botId: string, conversationId: string): string {
    return JSON.stringify([botId, conversationId])
  }

  /** A single bundle-lifetime owner preserves drafts when panes or conversations unmount. */
  static createBotDrafts() {
    const drafts = new Map<string, BotDraft>()
    const listeners = new Set<() => void>()
    const update = (key: string, draft: BotDraft): void => {
      drafts.set(key, draft)
      for (const listener of listeners) listener()
    }
    return {
      get: (key: string): BotDraft => drafts.get(key) ?? emptyDraft,
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      edit(key: string, text: string): void {
        update(key, { ...(drafts.get(key) ?? emptyDraft), text })
      },
      begin(key: string, requestId: string, text: string): void {
        const draft = drafts.get(key) ?? emptyDraft
        update(key, { text: draft.text === text ? '' : draft.text, intent: { requestId, text, phase: 'sending' } })
      },
      settle(key: string, requestId: string, phase: 'sent' | 'failed' | 'uncertain'): void {
        const draft = drafts.get(key)
        if (draft?.intent?.requestId !== requestId) return
        update(key, { ...draft, intent: phase === 'sent' ? null : { ...draft.intent, phase } })
      },
      forget(botId: string): void {
        for (const key of drafts.keys()) if (key.startsWith(`[${JSON.stringify(botId)},`)) drafts.delete(key)
        for (const listener of listeners) listener()
      },
    }
  }

  static nativeBotUrl(value: string | null): string | null {
    if (value === null) return null
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null
    } catch {
      return null
    }
  }

  static connectionLabel(status: BotConnection['status']): string {
    return {
      connected: 'Connected',
      connecting: 'Connecting',
      disconnected: 'Disconnected',
      'auth-required': 'Authentication required',
      error: 'Connection error',
      'adapter-missing': 'Adapter unavailable',
    }[status]
  }

  static connectDefaults(adapter: BotAdapterInfo) {
    return { label: adapter.name, fields: adapter.fields.map(field => ({ value: '', key: field.key })), accepted: false }
  }

  /** Metadata decides the form; a provider cannot turn a reference field into a raw-token input. */
  static connectFormSchema(adapter: BotAdapterInfo) {
    return z
      .object({
        label: z.string().trim().min(1, 'Name this connection.').max(100),
        fields: z.array(z.object({ value: z.string().max(4096), key: z.string() })),
        accepted: z.boolean().refine(value => value, 'Accept the displayed risks before connecting.'),
      })
      .superRefine((value, context) => {
        for (const [index, field] of adapter.fields.entries()) {
          const input = value.fields[index]
          if (input?.key !== field.key) {
            context.addIssue({ code: 'custom', path: ['fields', index, 'value'], message: 'Adapter configuration changed. Reopen Connect bot.' })
            continue
          }
          const text = input.value.trim()
          if (field.required && text === '') context.addIssue({ code: 'custom', path: ['fields', index, 'value'], message: 'This field is required.' })
          else if (field.kind === 'secret-reference' && text !== '' && parseSecretReference(text) === null)
            context.addIssue({ code: 'custom', path: ['fields', index, 'value'], message: 'Use secret:ALIAS or secret:ALIAS@ENV, never a token.' })
        }
        if (value.fields.length !== adapter.fields.length)
          context.addIssue({ code: 'custom', path: ['fields'], message: 'Adapter configuration changed. Reopen Connect bot.' })
      })
  }

  static connectInput(adapter: BotAdapterInfo, value: BotConnectForm): BotConnectInput {
    const parsed = BotsUiModel.connectFormSchema(adapter).parse(value)
    return {
      adapterId: adapter.id,
      label: parsed.label,
      config: Object.fromEntries(parsed.fields.map(field => [field.key, field.value.trim()])),
      acceptRisks: true,
    }
  }

  static chronologicalMessages(messages: readonly BotMessage[]): BotMessage[] {
    return [...messages].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** A successful refreshed receipt wins over an earlier transport error; reconnect never calls send. */
  static visibleIntent(draft: BotDraft, messages: readonly BotMessage[]): BotDraft['intent'] {
    if (draft.intent === null) return null
    return messages.some(message => message.requestId === draft.intent?.requestId && message.delivery === 'sent') ? null : draft.intent
  }
}

export type BotConnectForm = ReturnType<typeof BotsUiModel.connectDefaults>
export const botDrafts = BotsUiModel.createBotDrafts()
