import { JsonText, PluginApiError, type ApiClientOutput, type ApiHostInput, type ApiMethodDefinition } from '@dshfiles/dshx/api'
import { z } from 'zod'
import { botsApi } from './api.js'
import { validateBotsServerConfiguration } from './server-config.js'

type Methods = typeof botsApi.methods
export type BotsServiceOperations = {
  readonly [Method in keyof Methods]: (input: ApiHostInput<Methods[Method]>) => ApiClientOutput<Methods[Method]> | Promise<ApiClientOutput<Methods[Method]>>
}
export type BotsHttpClient = {
  readonly [Method in keyof Methods]: (input: ApiHostInput<Methods[Method]>) => Promise<ApiClientOutput<Methods[Method]>>
} & { readonly close: () => Promise<void> }
export interface BotsHttpClientOptions {
  readonly origin: string
  readonly resolveBearerToken: () => Promise<string>
  readonly fetch?: typeof globalThis.fetch
}
const rawJsonSchema = z.json()
const refused = (): PluginApiError =>
  new PluginApiError('The Bots service request was refused or interrupted. Delivery may be unknown; retry only the original request ID.', {
    code: 'service-request-failed',
  })
const validateOrigin = (origin: string): string => {
  try {
    const url = new URL(origin)
    if (!/^https?:\/\/[^/?#@\\\s]+\/?$/u.test(origin) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw refused()
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/u.test(origin))) throw refused()
    return url.origin
  } catch {
    throw new PluginApiError('Configure a root HTTPS origin or literal loopback HTTP origin.', { code: 'invalid-service-origin' })
  }
}
const readResponse = async (response: Response, signal: AbortSignal): Promise<z.infer<typeof rawJsonSchema>> => {
  const limit = 8 * 1024 * 1024
  if (response.body === null) throw refused()
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (!response.ok || response.redirected || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      throw refused()
    const length = Number(response.headers.get('content-length') ?? 0)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) throw refused()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw refused()
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    return JsonText.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), rawJsonSchema)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
  }
}

/** No cache, worker, durable state or retry: one authorized call maps to one HTTP request. */
export const createBotsHttpClient = (options: BotsHttpClientOptions): BotsHttpClient => {
  const origin = validateOrigin(options.origin)
  const fetch = options.fetch ?? globalThis.fetch
  const lifetime = new AbortController()
  const call = async <ClientInput, HostInput, HostOutput, ClientOutput>(
    definition: ApiMethodDefinition<ClientInput, HostInput, HostOutput, ClientOutput>,
    path: string,
    raw: HostInput,
  ): Promise<ClientOutput> => {
    if (lifetime.signal.aborted) throw refused()
    const controller = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    const abort = (): void => controller.abort()
    const deadline = setTimeout(abort, 15000)
    deadline.unref()
    const cancelled = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(refused()), { once: true }))
    const running = async (): Promise<ClientOutput> => {
      if (definition.input === undefined || definition.output === undefined) throw refused()
      const input = await definition.input['~standard'].validate(raw)
      if (input.issues !== undefined) throw refused()
      const body = input.value === undefined ? undefined : JSON.stringify(input.value)
      if (body !== undefined && Buffer.byteLength(body, 'utf8') > 65536) throw refused()
      signal.throwIfAborted()
      const bearerToken = await options.resolveBearerToken()
      signal.throwIfAborted()
      validateBotsServerConfiguration({ bearerToken })
      const request: RequestInit = {
        method: path === '/v1/snapshot' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal,
      }
      if (body !== undefined) request.body = body
      const response = await fetch(`${origin}${path}`, request)
      const output = await definition.output['~standard'].validate(await readResponse(response, signal))
      if (output.issues !== undefined) throw refused()
      signal.throwIfAborted()
      return output.value
    }
    try {
      return await Promise.race([running(), cancelled])
    } catch {
      throw refused()
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
  }
  return {
    snapshot: () => call(botsApi.methods.snapshot, '/v1/snapshot', undefined),
    connect: input => call(botsApi.methods.connect, '/v1/connect', input),
    reconnect: input => call(botsApi.methods.reconnect, '/v1/reconnect', input),
    disconnect: input => call(botsApi.methods.disconnect, '/v1/disconnect', input),
    remove: input => call(botsApi.methods.remove, '/v1/remove', input),
    messages: input => call(botsApi.methods.messages, '/v1/messages', input),
    send: input => call(botsApi.methods.send, '/v1/send', input),
    markRead: input => call(botsApi.methods.markRead, '/v1/markRead', input),
    setCredentialManagement: input => call(botsApi.methods.setCredentialManagement, '/v1/setCredentialManagement', input),
    close: async () => lifetime.abort(),
  }
}
