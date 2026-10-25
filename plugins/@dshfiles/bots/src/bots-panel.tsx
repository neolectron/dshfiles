import { isApiOwnerMissing } from '@dshfiles/dshx/api'
import { useApi } from '@dshfiles/dshx/client'
import { Button } from '@dshfiles/plugin-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dshfiles/plugin-ui/components/ui/dialog'
import { Textarea } from '@dshfiles/plugin-ui/components/ui/textarea'
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckCheckIcon,
  CircleDotIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  UnplugIcon,
} from '@dshfiles/plugin-ui/icons'
import { cn } from '@dshfiles/plugin-ui/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@dshfiles/plugin-ui/query'
import { useId, useState, useSyncExternalStore } from 'react'
import { botsApi } from './api.js'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'
import { BotsCredentialManagement } from './bots-credential-management.js'
import { BotsConnectDialog } from './bots-connect-dialog.js'
import { BotsConversationViewport } from './bots-conversation-viewport.js'
import { botDrafts, BotsUiModel } from './bots-ui-model.js'
import { botsKeys, messagesQuery, snapshotQuery, type BotsClient } from './bots-queries.js'
import type { BotConnectInput, BotConnection, BotMessage, BotsSnapshot, BotView } from './contract.js'

const timestamp = (value: number): string => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const NativeLink = (props: { readonly url: string | null; readonly label?: string }): JSX.Element | null => {
  const url = BotsUiModel.nativeBotUrl(props.url)
  return url === null ? null : (
    <a
      className="dshx:inline-flex dshx:items-center dshx:gap-1 dshx:text-sm dshx:font-medium dshx:text-primary dshx:underline-offset-4 dshx:hover:underline"
      href={url}
      rel="noopener noreferrer"
      target="_blank"
    >
      {props.label ?? 'Open original app'}
      <ArrowUpRightIcon aria-hidden className="dshx:size-3.5" />
    </a>
  )
}

const Health = (props: { readonly connection: BotConnection | undefined }): JSX.Element => (
  <span className="dshx:inline-flex dshx:min-w-0 dshx:items-center dshx:gap-1.5 dshx:text-xs dshx:text-muted-foreground">
    <CircleDotIcon aria-hidden className={cn('dshx:size-3 dshx:shrink-0', props.connection?.status === 'connected' && 'dshx:text-success')} />
    <span className="dshx:truncate">{props.connection === undefined ? 'Connection unavailable' : BotsUiModel.connectionLabel(props.connection.status)}</span>
  </span>
)

type ConnectionAction = { readonly kind: 'reconnect' | 'disconnect' | 'remove'; readonly connectionId: string }

const ConnectionButtons = (props: {
  readonly connection: BotConnection
  readonly busy: boolean
  readonly onAction: (action: ConnectionAction) => void
}): JSX.Element => (
  <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-1.5">
    {props.connection.status === 'connected' || props.connection.status === 'connecting' ? (
      <Button disabled={props.busy} onClick={() => props.onAction({ kind: 'disconnect', connectionId: props.connection.id })} size="sm" variant="outline">
        <UnplugIcon aria-hidden />
        Disconnect
      </Button>
    ) : (
      <Button
        disabled={props.busy || props.connection.status === 'adapter-missing'}
        onClick={() => props.onAction({ kind: 'reconnect', connectionId: props.connection.id })}
        size="sm"
        variant="outline"
      >
        <RefreshCwIcon aria-hidden />
        Reconnect
      </Button>
    )}
    <Button disabled={props.busy} onClick={() => props.onAction({ kind: 'remove', connectionId: props.connection.id })} size="sm" variant="ghost">
      Remove local data
    </Button>
  </div>
)

const Message = (props: {
  readonly message: BotMessage
  readonly bot: BotView
  readonly retrying: boolean
  readonly canSend: boolean
  readonly onRetry: (message: BotMessage) => void
}): JSX.Element => {
  const message = props.message
  const failed = message.author === 'user' && (message.delivery === 'failed' || message.delivery === 'uncertain')
  return (
    <li className={cn('dshx:flex dshx:min-w-0 dshx:flex-col dshx:gap-2', message.author === 'user' ? 'dshx:items-end' : 'dshx:items-start')}>
      <div className="dshx:flex dshx:max-w-full dshx:min-w-0 dshx:items-center dshx:gap-2 dshx:text-xs dshx:text-muted-foreground">
        <span className="dshx:truncate dshx:font-medium">{message.author === 'user' ? 'You' : props.bot.identity.name}</span>
        <time className="dshx:shrink-0" dateTime={new Date(message.createdAt).toISOString()}>
          {timestamp(message.createdAt)}
        </time>
      </div>
      <div
        className={cn(
          'dshx:max-w-[90%] dshx:min-w-0 dshx:space-y-3 dshx:rounded-2xl dshx:border dshx:p-4 dshx:text-sm dshx:leading-relaxed dshx:@max-pane-narrow:max-w-full',
          message.author === 'user' ? 'dshx:rounded-tr-sm dshx:border-primary/15 dshx:bg-primary/5' : 'dshx:rounded-tl-sm dshx:bg-card',
        )}
      >
        {message.text !== '' && <p className="dshx:whitespace-pre-wrap dshx:break-words dshx:[overflow-wrap:anywhere]">{message.text}</p>}
        {message.notice !== null && (
          <div className="dshx:space-y-2 dshx:rounded-lg dshx:bg-muted dshx:p-3">
            <p className="dshx:whitespace-pre-wrap dshx:break-words dshx:text-muted-foreground">{message.notice}</p>
            <NativeLink url={message.nativeUrl} />
            {!failed && BotsUiModel.nativeBotUrl(message.nativeUrl) === null && (
              <p className="dshx:text-xs dshx:text-muted-foreground">View unsupported content in the original app; no safe link was supplied.</p>
            )}
          </div>
        )}
      </div>
      {message.author === 'user' && (
        <span className="dshx:text-xs dshx:text-muted-foreground">
          {
            { sending: 'Sending…', sent: 'Sent', failed: 'Not delivered', uncertain: 'Delivery unconfirmed — may have arrived', received: 'Received' }[
              message.delivery
            ]
          }
        </span>
      )}
      {failed && message.requestId !== null && (
        <Button disabled={props.retrying || !props.canSend} onClick={() => props.onRetry(message)} size="sm" variant="outline">
          Retry original send
        </Button>
      )}
    </li>
  )
}

const Conversation = (props: {
  readonly api: BotsClient
  readonly bot: BotView
  readonly connection: BotConnection | undefined
  readonly conversationId: string
}): JSX.Element => {
  const queryClient = useQueryClient()
  const [before, setBefore] = useState<string | undefined>()
  const query = useQuery(messagesQuery(props.api, props.bot.id, props.conversationId, before))
  const messages = BotsUiModel.chronologicalMessages(query.data?.messages ?? [])
  const key = BotsUiModel.draftKey(props.bot.id, props.conversationId)
  const draft = useSyncExternalStore(
    botDrafts.subscribe,
    () => botDrafts.get(key),
    () => botDrafts.get(key),
  )
  const intent = BotsUiModel.visibleIntent(draft, messages)
  const inputId = useId()
  const canSend = props.connection?.status === 'connected' && props.bot.identity.capabilities.text && !query.isError && query.data !== undefined
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: botsKeys.all })
  }
  const send = useMutation({
    mutationFn: (request: { readonly text: string; readonly requestId: string }) =>
      props.api.send({ botId: props.bot.id, conversationId: props.conversationId, ...request }),
    retry: false,
    onSuccess: (message, request) => {
      botDrafts.settle(key, request.requestId, message.delivery === 'failed' || message.delivery === 'uncertain' ? message.delivery : 'sent')
      refresh()
    },
    onError: (_error, request) => {
      botDrafts.settle(key, request.requestId, 'uncertain')
      refresh()
    },
  })
  const markRead = useMutation({
    mutationFn: (throughMessageId: string) => props.api.markRead({ botId: props.bot.id, conversationId: props.conversationId, throughMessageId }),
    retry: false,
    onSuccess: refresh,
  })
  const submit = (text: string, requestId: string): void => {
    if (!canSend || send.isPending) return
    const currentIntent = BotsUiModel.visibleIntent(botDrafts.get(key), messages)
    if (currentIntent !== null && (currentIntent.phase === 'sending' || currentIntent.requestId !== requestId)) return
    botDrafts.begin(key, requestId, text)
    send.mutate({ text, requestId })
  }
  const retry = (message: BotMessage): void => {
    if (message.requestId !== null) submit(message.text, message.requestId)
  }
  const lastMessage = messages.at(-1)
  const oldestMessage = messages[0]
  const localIntent = intent !== null && !messages.some(message => message.requestId === intent.requestId)
  const viewportVersion = JSON.stringify([
    messages.map(message => [message.id, message.updatedAt, message.delivery]),
    localIntent ? intent?.requestId : null,
    localIntent ? intent?.phase : null,
    query.status,
  ])
  return (
    <div className="dshx:flex dshx:min-h-0 dshx:flex-1 dshx:flex-col">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:justify-between dshx:gap-2 dshx:border-b dshx:px-5 dshx:py-2 dshx:text-xs dshx:text-muted-foreground">
        <span>{before === undefined ? 'Latest cached messages' : 'Earlier cached messages'}</span>
        <div className="dshx:flex dshx:flex-wrap dshx:gap-1">
          {before !== undefined && (
            <Button onClick={() => setBefore(undefined)} size="sm" variant="ghost">
              Latest messages
            </Button>
          )}
          {query.data?.hasMore === true && oldestMessage !== undefined && (
            <Button onClick={() => setBefore(oldestMessage.id)} size="sm" variant="ghost">
              Older messages
            </Button>
          )}
          <Button
            disabled={markRead.isPending || lastMessage === undefined || query.isError}
            onClick={() => {
              if (lastMessage !== undefined) markRead.mutate(lastMessage.id)
            }}
            size="sm"
            variant="ghost"
          >
            <CheckCheckIcon aria-hidden />
            Mark read
          </Button>
        </div>
      </div>
      <BotsConversationViewport contentVersion={viewportVersion} followLatest={before === undefined} key={before ?? 'latest'}>
        {query.isPending && (
          <p className="dshx:text-sm dshx:text-muted-foreground" role="status">
            Loading cached conversation…
          </p>
        )}
        {query.isError && (
          <div className="dshx:space-y-2" role="alert">
            <p className="dshx:text-sm">
              {isApiOwnerMissing(query.error)
                ? 'Bots is unavailable on this Host.'
                : 'Conversation could not be refreshed. Cached messages may be out of date.'}
            </p>
            <Button
              onClick={() => {
                void query.refetch()
              }}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        )}
        {!query.isPending && !query.isError && messages.length === 0 && (
          <div className="dshx:flex dshx:min-h-48 dshx:flex-col dshx:items-center dshx:justify-center dshx:gap-3 dshx:text-center">
            <MessageSquareIcon aria-hidden className="dshx:size-7 dshx:text-muted-foreground" />
            <p className="dshx:text-sm dshx:font-medium">A conversation, already yours</p>
            <p className="dshx:max-w-sm dshx:text-sm dshx:text-muted-foreground">No messages are cached here yet. Send a message or wait for the next sync.</p>
          </div>
        )}
        <ol aria-label="Messages" className="dshx:mx-auto dshx:flex dshx:w-full dshx:max-w-3xl dshx:flex-col dshx:gap-6">
          {messages.map(message => (
            <Message
              bot={props.bot}
              canSend={canSend && intent?.phase !== 'sending'}
              key={message.id}
              message={message}
              onRetry={retry}
              retrying={send.isPending}
            />
          ))}
        </ol>
        {localIntent && intent !== null && (
          <div className="dshx:mx-auto dshx:mt-5 dshx:max-w-3xl dshx:space-y-2 dshx:rounded-lg dshx:border dshx:p-4" role="status">
            <p className="dshx:whitespace-pre-wrap dshx:break-words dshx:text-sm">{intent.text}</p>
            <p className="dshx:text-xs dshx:text-muted-foreground">
              {intent.phase === 'sending'
                ? 'Sending…'
                : 'Delivery unconfirmed. This message may already have arrived. Retry checks the original request, not a new send.'}
            </p>
            {intent.phase !== 'sending' && (
              <Button disabled={!canSend || send.isPending} onClick={() => submit(intent.text, intent.requestId)} size="sm" variant="outline">
                Retry original send
              </Button>
            )}
          </div>
        )}
      </BotsConversationViewport>
      {markRead.isError && (
        <p className="dshx:px-5 dshx:py-2 dshx:text-sm dshx:text-destructive" role="alert">
          Could not mark messages read. Try again.
        </p>
      )}
      <form
        className="dshx:space-y-3 dshx:border-t dshx:bg-background dshx:p-4"
        onSubmit={event => {
          event.preventDefault()
          if (draft.text.trim() !== '' && intent === null) submit(draft.text, crypto.randomUUID())
        }}
      >
        {!canSend && (
          <p className="dshx:text-xs dshx:text-muted-foreground" role="status">
            {!props.bot.identity.capabilities.text
              ? 'Read-only conversation. Use the original app for interactions.'
              : 'Read-only while the connection or conversation is unavailable. Your draft stays here.'}
          </p>
        )}
        <label className="dshx:sr-only" htmlFor={inputId}>
          Message to {props.bot.identity.name}
        </label>
        <Textarea
          aria-describedby={`${inputId}-hint`}
          className="dshx:max-h-44 dshx:min-h-20 dshx:resize-y"
          id={inputId}
          maxLength={16000}
          onChange={event => botDrafts.edit(key, event.currentTarget.value)}
          onKeyDown={event => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              canSend &&
              intent === null &&
              !send.isPending &&
              draft.text.trim() !== ''
            ) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={`Message ${props.bot.identity.name}…`}
          rows={3}
          value={draft.text}
        />
        <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3">
          <p className="dshx:min-w-0 dshx:text-xs dshx:text-muted-foreground" id={`${inputId}-hint`}>
            Enter sends · Shift+Enter adds a line. Only your message is sent, never thread context.
          </p>
          <Button disabled={!canSend || draft.text.trim() === '' || intent !== null || send.isPending} type="submit">
            <SendIcon aria-hidden />
            Send
          </Button>
        </div>
      </form>
    </div>
  )
}

const BotDetail = (props: {
  readonly adapter: BotAdapterInfo | undefined
  readonly api: BotsClient
  readonly bot: BotView
  readonly connection: BotConnection | undefined
  readonly busy: boolean
  readonly onBack: () => void
  readonly onAction: (action: ConnectionAction) => void
}): JSX.Element => {
  const [conversationId, setConversationId] = useState(props.bot.identity.conversations[0]?.id ?? '')
  const conversation = props.bot.identity.conversations.find(item => item.id === conversationId) ?? props.bot.identity.conversations[0]
  const id = useId()
  return (
    <section aria-label={`${props.bot.identity.name} details`} className="dshx:flex dshx:h-full dshx:min-h-0 dshx:min-w-0 dshx:flex-col">
      <header
        aria-label="Bot connection details"
        className="dshx:max-h-[40%] dshx:shrink-0 dshx:space-y-4 dshx:overflow-y-auto dshx:overscroll-contain dshx:border-b dshx:p-5 dshx:@max-pane-narrow:p-3"
        role="region"
        tabIndex={0}
      >
        <Button className="dshx:hidden dshx:@max-pane-compact:inline-flex" onClick={props.onBack} size="sm" variant="ghost">
          <ArrowLeftIcon aria-hidden />
          Back to bots
        </Button>
        <div className="dshx:flex dshx:min-w-0 dshx:items-start dshx:justify-between dshx:gap-4">
          <div className="dshx:min-w-0">
            <p className="dshx:mb-1 dshx:text-xs dshx:font-medium dshx:uppercase dshx:tracking-wider dshx:text-muted-foreground">{props.bot.provider}</p>
            <h2 className="dshx:truncate dshx:text-xl dshx:font-semibold dshx:tracking-tight">{props.bot.identity.name}</h2>
            <p className="dshx:mt-1 dshx:break-words dshx:text-sm dshx:text-muted-foreground">{props.bot.identity.description}</p>
          </div>
          <span className="dshx:shrink-0 dshx:rounded-full dshx:bg-muted dshx:px-2.5 dshx:py-1 dshx:text-xs dshx:text-muted-foreground dshx:@max-pane-narrow:hidden">
            {props.bot.activity === 'unknown' ? 'Activity unknown' : props.bot.activity === 'working' ? 'Working' : 'Idle'}
          </span>
        </div>
        <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-x-4 dshx:gap-y-2">
          <Health connection={props.connection} />
          <span className="dshx:text-xs dshx:text-muted-foreground">
            {props.connection?.lastSyncAt == null ? 'Not synced yet' : `Last sync ${timestamp(props.connection.lastSyncAt)}`}
          </span>
          <NativeLink url={props.bot.identity.nativeUrl} />
        </div>
        <p className="dshx:text-xs dshx:text-muted-foreground dshx:@min-pane-narrow:hidden">
          {props.bot.activity === 'unknown' ? 'Activity unknown; connection health does not imply the bot is idle.' : `Remote activity: ${props.bot.activity}.`}
        </p>
        {props.connection?.error != null && (
          <p className="dshx:break-words dshx:text-sm dshx:text-destructive" role="alert">
            {props.connection.error}
          </p>
        )}
        {props.connection !== undefined && (
          <>
            <ConnectionButtons busy={props.busy} connection={props.connection} onAction={props.onAction} />
            <BotsCredentialManagement api={props.api} connection={props.connection} adapter={props.adapter} busy={props.busy} />
          </>
        )}
        <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
          <label className="dshx:text-xs dshx:font-medium dshx:text-muted-foreground" htmlFor={id}>
            Conversation
          </label>
          <select
            className="dshx:h-8 dshx:min-w-0 dshx:max-w-full dshx:flex-1 dshx:rounded-md dshx:border dshx:border-input dshx:bg-background dshx:px-2 dshx:text-sm"
            id={id}
            onChange={event => setConversationId(event.currentTarget.value)}
            value={conversation?.id ?? ''}
          >
            {props.bot.identity.conversations.map(item => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <p className="dshx:text-xs dshx:leading-relaxed dshx:text-muted-foreground">
          {conversation?.historyScope === 'since-link'
            ? 'Local cache since linking, not a full history import.'
            : 'Locally cached provider history; the original app remains canonical.'}{' '}
          Disconnecting stops local sync only, not the remote bot.
        </p>
      </header>
      {conversation === undefined ? (
        <p role="status">This conversation is unavailable.</p>
      ) : (
        <Conversation
          api={props.api}
          bot={props.bot}
          connection={props.connection}
          conversationId={conversation.id}
          key={BotsUiModel.draftKey(props.bot.id, conversation.id)}
        />
      )}
    </section>
  )
}

export const BotsPanel = (): JSX.Element => {
  const api = useApi(botsApi)
  const queryClient = useQueryClient()
  const query = useQuery(snapshotQuery(api))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [removing, setRemoving] = useState<BotConnection | null>(null)
  const snapshot = query.data
  const selected = snapshot?.bots.find(bot => bot.id === selectedId)
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: botsKeys.all })
  }
  const connect = useMutation({
    mutationFn: (input: BotConnectInput) => api.connect(input),
    retry: false,
    onSuccess: () => {
      setConnecting(false)
      refresh()
    },
  })
  const action = useMutation({
    mutationFn: (input: ConnectionAction): Promise<BotsSnapshot> => {
      if (input.kind === 'remove') return api.remove({ connectionId: input.connectionId, confirm: true })
      if (input.kind === 'reconnect') return api.reconnect({ connectionId: input.connectionId })
      return api.disconnect({ connectionId: input.connectionId })
    },
    retry: false,
    onSuccess: (_data, input) => {
      if (input.kind === 'remove') {
        for (const bot of snapshot?.bots ?? []) if (bot.connectionId === input.connectionId) botDrafts.forget(bot.id)
        setRemoving(null)
      }
      refresh()
    },
  })
  const onAction = (input: ConnectionAction): void => {
    action.reset()
    if (input.kind === 'remove') setRemoving(snapshot?.connections.find(connection => connection.id === input.connectionId) ?? null)
    else action.mutate(input)
  }
  const openConnect = (): void => {
    connect.reset()
    setConnecting(true)
  }
  const unavailable = isApiOwnerMissing(query.error)
  const busy = action.isPending || connect.isPending || query.isError
  return (
    <main
      aria-label="Bots workspace"
      className="dshx-root dshx:@container dshx:flex dshx:h-full dshx:min-h-0 dshx:w-full dshx:min-w-0 dshx:flex-col dshx:bg-background dshx:text-foreground"
    >
      <header className="dshx:flex dshx:shrink-0 dshx:items-center dshx:justify-between dshx:gap-4 dshx:border-b dshx:px-6 dshx:py-5 dshx:@max-pane-narrow:px-3">
        <div className="dshx:min-w-0">
          <h1 className="dshx:text-2xl dshx:font-semibold dshx:tracking-tight">Bots</h1>
          <p className="dshx:mt-1 dshx:text-sm dshx:text-muted-foreground dshx:@max-pane-narrow:hidden">
            Your durable agents. Their own identities. One workspace.
          </p>
        </div>
        <Button disabled={query.isPending || query.isError} onClick={openConnect}>
          <PlusIcon aria-hidden />
          Connect bot
        </Button>
      </header>
      {query.isPending ? (
        <p className="dshx:p-6 dshx:text-sm dshx:text-muted-foreground" role="status">
          Loading bots…
        </p>
      ) : query.isError ? (
        <div className="dshx:space-y-3 dshx:p-6" role="alert">
          <h2 className="dshx:font-medium">{unavailable ? 'Bots is unavailable on this Host' : 'Bots could not be refreshed'}</h2>
          <p className="dshx:text-sm dshx:text-muted-foreground">
            {unavailable
              ? 'The Bots service is not loaded. No local or remote actions were taken.'
              : 'Check the Host connection. No message will be resent automatically.'}
          </p>
          <Button
            onClick={() => {
              void query.refetch()
            }}
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="dshx:flex dshx:min-h-0 dshx:flex-1 dshx:overflow-hidden">
          <aside
            aria-label="Bot roster"
            className={cn(
              'dshx:flex dshx:w-72 dshx:min-w-0 dshx:shrink-0 dshx:flex-col dshx:overflow-y-auto dshx:border-r dshx:bg-muted/15 dshx:@max-pane-compact:w-full',
              selected !== undefined && 'dshx:@max-pane-compact:hidden',
            )}
          >
            <div className="dshx:flex dshx:items-center dshx:justify-between dshx:px-5 dshx:py-4 dshx:text-xs dshx:font-medium dshx:uppercase dshx:tracking-wider dshx:text-muted-foreground">
              <span>Connected identities</span>
              <span>{snapshot?.bots.length ?? 0}</span>
            </div>
            {(snapshot?.bots.length ?? 0) === 0 && (
              <div className="dshx:space-y-3 dshx:px-5 dshx:pb-6">
                <p className="dshx:text-sm dshx:font-medium">No bots connected</p>
                <p className="dshx:text-sm dshx:leading-relaxed dshx:text-muted-foreground">
                  Connect a bot you already use. Its identity and conversations stay with its provider.
                </p>
                {snapshot?.adapters.length === 0 && <p className="dshx:text-xs dshx:text-muted-foreground">No bot adapters are available yet.</p>}
              </div>
            )}
            <nav aria-label="Bots" className="dshx:space-y-1 dshx:px-2 dshx:pb-4">
              {snapshot?.bots.map(bot => (
                <button
                  aria-current={bot.id === selectedId ? 'true' : undefined}
                  className={cn(
                    'dshx:flex dshx:w-full dshx:min-w-0 dshx:items-start dshx:gap-3 dshx:rounded-lg dshx:p-3 dshx:text-left dshx:transition-colors dshx:hover:bg-accent dshx:focus-visible:outline-2 dshx:focus-visible:outline-ring',
                    bot.id === selectedId && 'dshx:bg-accent',
                  )}
                  key={bot.id}
                  onClick={() => setSelectedId(bot.id)}
                  type="button"
                >
                  <span
                    aria-hidden
                    className="dshx:flex dshx:size-9 dshx:shrink-0 dshx:items-center dshx:justify-center dshx:rounded-lg dshx:border dshx:bg-background"
                  >
                    <BotIcon className="dshx:size-4" />
                  </span>
                  <span className="dshx:min-w-0 dshx:flex-1 dshx:space-y-1">
                    <span className="dshx:block dshx:truncate dshx:text-sm dshx:font-medium">{bot.identity.name}</span>
                    <span className="dshx:block dshx:truncate dshx:text-xs dshx:text-muted-foreground">
                      {bot.provider} · {bot.activity === 'unknown' ? 'Activity unknown' : bot.activity === 'working' ? 'Working' : 'Idle'}
                    </span>
                    <Health connection={snapshot.connections.find(connection => connection.id === bot.connectionId)} />
                  </span>
                  {bot.unread > 0 && (
                    <span
                      aria-label={`${bot.unread} unread`}
                      className="dshx:shrink-0 dshx:rounded-full dshx:bg-primary dshx:px-2 dshx:py-0.5 dshx:text-xs dshx:font-semibold dshx:text-primary-foreground"
                    >
                      {bot.unread > 99 ? '99+' : bot.unread}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            {snapshot?.connections
              .filter(connection => !snapshot.bots.some(bot => bot.connectionId === connection.id))
              .map(connection => (
                <section
                  aria-label={`Connection ${connection.label}`}
                  className="dshx:mx-3 dshx:mb-3 dshx:space-y-3 dshx:rounded-lg dshx:border dshx:p-3"
                  key={connection.id}
                >
                  <p className="dshx:break-words dshx:text-sm dshx:font-medium">{connection.label}</p>
                  <Health connection={connection} />
                  {connection.error !== null && (
                    <p className="dshx:break-words dshx:text-xs dshx:text-destructive" role="alert">
                      {connection.error}
                    </p>
                  )}
                  <p className="dshx:text-xs dshx:text-muted-foreground">No bot identity is available for this connection.</p>
                  <ConnectionButtons busy={busy} connection={connection} onAction={onAction} />
                  <BotsCredentialManagement
                    api={api}
                    connection={connection}
                    adapter={snapshot.adapters.find(adapter => adapter.id === connection.adapterId)}
                    busy={busy}
                  />
                </section>
              ))}
          </aside>
          <div className={cn('dshx:min-h-0 dshx:min-w-0 dshx:flex-1', selected === undefined && 'dshx:@max-pane-compact:hidden')}>
            {selected === undefined ? (
              <div className="dshx:flex dshx:h-full dshx:flex-col dshx:items-center dshx:justify-center dshx:gap-4 dshx:p-8 dshx:text-center">
                <span className="dshx:flex dshx:size-16 dshx:items-center dshx:justify-center dshx:rounded-2xl dshx:border dshx:bg-muted/30">
                  <BotIcon aria-hidden className="dshx:size-7 dshx:text-muted-foreground" />
                </span>
                <h2 className="dshx:text-lg dshx:font-semibold dshx:tracking-tight">A place for your ongoing conversations</h2>
                <p className="dshx:max-w-sm dshx:text-sm dshx:leading-relaxed dshx:text-muted-foreground">
                  Select a bot to pick up where you left off. These are existing remote agents, not native DSH threads or model presets.
                </p>
              </div>
            ) : (
              <BotDetail
                adapter={snapshot?.adapters.find(adapter => adapter.id === selected.provider)}
                api={api}
                bot={selected}
                busy={busy}
                connection={snapshot?.connections.find(connection => connection.id === selected.connectionId)}
                key={selected.id}
                onAction={onAction}
                onBack={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      )}
      {action.isError && removing === null && (
        <p className="dshx:border-t dshx:p-3 dshx:text-sm dshx:text-destructive" role="alert">
          The connection action could not be completed. Check its current status before trying again.
        </p>
      )}
      {connecting && (
        <BotsConnectDialog
          adapters={snapshot?.adapters ?? []}
          failed={connect.isError}
          onClose={() => setConnecting(false)}
          onConnect={input => connect.mutate(input)}
          pending={connect.isPending}
        />
      )}
      {removing !== null && (
        <Dialog
          onOpenChange={open => {
            if (!open && !action.isPending) setRemoving(null)
          }}
          open
        >
          <DialogContent className="dshx-root">
            <DialogHeader>
              <DialogTitle>Remove local bot data?</DialogTitle>
              <DialogDescription>
                Remove “{removing.label}”, its cached conversations and unsent drafts from DSH. This does not stop or delete the remote bot, and does not delete
                vault credentials. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {action.isError && <p role="alert">Local data could not be removed. Check the connection and try again.</p>}
            <DialogFooter>
              <Button disabled={action.isPending} onClick={() => setRemoving(null)} variant="outline">
                Cancel
              </Button>
              <Button disabled={action.isPending} onClick={() => action.mutate({ kind: 'remove', connectionId: removing.id })} variant="destructive">
                {action.isPending ? 'Removing…' : 'Remove local data'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </main>
  )
}
