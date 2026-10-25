#!/usr/bin/env node
// Read-only feasibility probe: no browser, cookies, refresh, fallback, POST, app server or profile changes.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const selectedArgument = process.argv.slice(2)
if (selectedArgument.length > 1 || (selectedArgument.length === 1 && !selectedArgument[0]?.startsWith('--account=')))
  throw new Error('Use one explicit --account=<id>, or the previously selected default. No pool fallback.')
const accountId = selectedArgument[0]?.slice('--account='.length) ?? 'codex_manuel'
const accountRequire = createRequire(new URL('../plugins/@dshfiles/ai-accounts/package.json', import.meta.url))
const dotRequire = createRequire(new URL('../plugins/@dshfiles/bot-openai-dot/package.json', import.meta.url))
const { OpenAIAccountAccess, OpenAIAccountAccessError } = await import(pathToFileURL(accountRequire.resolve('@dshfiles/ai-accounts/openai-account-access')))
const { createDotAdapter } = await import(pathToFileURL(dotRequire.resolve('@dshfiles/bot-openai-dot/adapter')))
const { BotAdapterError } = await import(pathToFileURL(dotRequire.resolve('@dshfiles/bots/adapter')))
const report = {
  kind: 'read-only-yield-direct-http-poc',
  at: new Date().toISOString(),
  node: process.version,
  selectedAccount: accountId,
  browserStarted: false,
  cookiesImported: false,
  credentialsRefreshed: false,
  accountFallback: false,
  bodyOrTranscriptLogged: false,
  messagePosts: 0,
  control: null,
  localCredentialUsable: false,
  credentialReads: 0,
  ownerFailure: null,
  localLoginBefore: null,
  localLoginAfter: null,
  tokenMaterialUnchanged: null,
  requests: [],
  discovery: 'not-started',
}
const nativeFetch = globalThis.fetch
try {
  const response = await nativeFetch('https://api.openai.com/v1/models', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(7000) })
  report.control = {
    host: 'api.openai.com',
    authenticated: false,
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
    cloudflareChallenge: response.headers.get('cf-mitigated') === 'challenge',
  }
  await response.body?.cancel()
} catch {
  report.control = { host: 'api.openai.com', authenticated: false, outcome: 'network-unavailable' }
}
const owner = OpenAIAccountAccess.create({ accountId, purpose: 'openai-dot', acceptRisks: true })
let initialFingerprint
const localLoginState = async before => {
  try {
    return await owner.withAccessToken(AbortSignal.timeout(7000), async access => {
      const fingerprint = createHash('sha256').update(access).digest('hex')
      if (before) initialFingerprint = fingerprint
      else if (initialFingerprint !== undefined) report.tokenMaterialUnchanged = fingerprint === initialFingerprint
      return { locallyUsable: true, check: 'local-expiry-and-identity-only' }
    })
  } catch (error) {
    return { locallyUsable: false, reason: error instanceof OpenAIAccountAccessError ? error.code : 'private-error-redacted' }
  }
}
report.localLoginBefore = await localLoginState(true)
let session
const lifecycle = AbortSignal.timeout(25000)
const route = path =>
  path === '/backend-api/tbo/primary'
    ? 'dot-primary'
    : path.startsWith('/backend-api/tbo/by-thread/')
      ? 'dot-profile'
      : path.includes('/messages')
        ? 'room-baseline'
        : path.startsWith('/backend-api/messaging/rooms/')
          ? 'room-membership'
          : null
try {
  const adapter = createDotAdapter({
    accountAccess: {
      readAccessToken: async (selected, signal) => {
        if (selected !== accountId) throw new BotAdapterError('auth-required', 'Only the selected account is admitted.')
        try {
          return await owner.withAccessToken(signal, async access => {
            report.localCredentialUsable = true
            report.credentialReads++
            return access
          })
        } catch (error) {
          report.ownerFailure = error instanceof OpenAIAccountAccessError ? error.code : 'private-error-redacted'
          throw error
        }
      },
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const stage = route(url.pathname)
      if (
        url.origin !== 'https://chatgpt.com' ||
        stage === null ||
        init?.method !== 'GET' ||
        init.redirect !== 'error' ||
        new Headers(init.headers).has('cookie') ||
        report.requests.length >= 6
      )
        throw new BotAdapterError('access-denied', 'Probe only admits bounded canonical read-only discovery.')
      const start = performance.now()
      const response = await nativeFetch(input, init)
      report.requests.push({
        stage,
        method: 'GET',
        status: response.status,
        contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
        cloudflareChallenge: response.headers.get('cf-mitigated') === 'challenge',
        elapsedMs: Math.round(performance.now() - start),
      })
      return response
    },
  })
  session = await adapter.open({ config: { accountId }, signal: lifecycle })
  report.discovery =
    session.bots.length === 1 && session.bots[0]?.name.trim().toLowerCase() === 'yield' ? 'verified-existing-yield' : 'different-or-ambiguous-dot-stop'
} catch (error) {
  report.discovery =
    error instanceof BotAdapterError
      ? `refused:${error.code}`
      : error instanceof OpenAIAccountAccessError
        ? `owner-refused:${error.code}`
        : 'private-error-redacted'
} finally {
  try {
    await session?.close()
  } finally {
    report.localLoginAfter = await localLoginState(false)
    owner.close()
  }
}
const root = await mkdtemp(join(tmpdir(), 'yield-direct-http-poc-'))
const receipt = join(root, 'receipt.json')
await writeFile(receipt, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ receipt, ...report }, null, 2)}\n`)
