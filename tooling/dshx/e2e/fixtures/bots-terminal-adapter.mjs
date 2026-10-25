// Scratch-only terminal failure. Uses the actual Host engine, native storage and public adapter/API ports.
import assert from 'node:assert/strict'
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const owner = createRequire(new URL('../../../../plugins/@dshfiles/bots/package.json', import.meta.url))
const load = id => import(pathToFileURL(owner.resolve(id)).href)
const contracts = () =>
  Promise.all([load('@dshfiles/bots/api'), load('@dshfiles/dshx/api')]).then(([{ botsApi }, { JsonText }]) => ({
    botsApi,
    JsonText,
    proofSchema: z
      .object({
        events: z
          .array(
            z
              .object({
                kind: z.enum(['open', 'provider-call', 'poll', 'post', 'reconcile', 'close']),
                requestId: z.string().uuid().optional(),
                text: z.string().startsWith('SYNTH ').optional(),
              })
              .strict(),
          )
          .max(256),
        localDomainOpen: z.boolean(),
        snapshot: botsApi.methods.snapshot.output,
        conversations: z.array(botsApi.methods.messages.output).max(1),
      })
      .strict(),
  }))

export const name = 'bots-terminal-adapter'
export const inject = ['botAdapters', 'storageDomain']
export const terminalText = 'SYNTH terminal failure message — do not resend automatically'
export const terminalError = 'SYNTH access denied. Explicit reconnect is required.'
const proofName = 'bots-terminal-proof.json'
const scratchRoot = async root => {
  assert.ok(root && basename(root).startsWith('dshx-boot-profile-'))
  assert.equal(await realpath(root), root)
  return root
}
export const readTerminalProof = async privateScratchRoot => {
  const { JsonText, proofSchema } = await contracts()
  return JsonText.parse(await readFile(join(await scratchRoot(privateScratchRoot), proofName), 'utf8'), proofSchema)
}

export async function apply(ctx) {
  const privateScratchRoot = await scratchRoot(process.env.DSH_HOME)
  assert.equal(process.env.DSHX_BOOT_PROFILE_ROOT, join(privateScratchRoot, 'profiles', 'dshx-boot'))
  const { BotAdapterError } = await load('@dshfiles/bots/adapter')
  const { botsApi, proofSchema } = await contracts()
  const { createHostApiClient } = await load('@dshfiles/dshx/host')
  const api = createHostApiClient(ctx, botsApi, '@dshfiles/bots')
  const events = []
  let writes = Promise.resolve()
  const publish = () => {
    const next = writes.then(async () => {
      const snapshot = await api.snapshot()
      const conversations = await Promise.all(snapshot.bots.map(bot => api.messages({ botId: bot.id, conversationId: 'SYNTH-main' })))
      const proof = proofSchema.parse({ events, localDomainOpen: ctx.get('storageDomain').get('durable_bots') !== undefined, snapshot, conversations })
      const target = join(privateScratchRoot, proofName)
      await writeFile(`${target}.tmp`, JSON.stringify(proof), { mode: 0o600 })
      await rename(`${target}.tmp`, target)
    })
    writes = next.catch(() => undefined)
    return next
  }
  const note = (kind, extra = {}) => events.push({ kind, ...extra })
  const adapter = {
    info: {
      id: 'SYNTH-terminal-provider',
      version: 1,
      name: 'SYNTH terminal provider',
      description: 'Synthetic terminal refusal only; no network, account or vault.',
      risk: 'SYNTH data only. No external provider or credentials are used.',
      fields: [],
    },
    pollIntervalMs: 1000,
    validateConfig(config) {
      assert.deepEqual(config, {})
    },
    async open({ config, signal }) {
      this.validateConfig(config)
      signal.throwIfAborted()
      note('open')
      let closed = false
      const check = async current => {
        note('provider-call')
        // Persist even a forbidden call into an aborted/closed session before its guard throws.
        await publish()
        signal.throwIfAborted()
        current.throwIfAborted()
        assert.equal(closed, false)
      }
      return {
        accountId: 'SYNTH-account',
        bots: [
          {
            remoteId: 'SYNTH-bot',
            name: 'SYNTH terminal assistant',
            description: 'Synthetic-only terminal failure regression.',
            nativeUrl: null,
            capabilities: { text: true, attachments: false, approvals: false, activity: false },
            conversations: [{ id: 'SYNTH-main', title: 'SYNTH main', historyScope: 'since-link', initialCursor: 'SYNTH-baseline' }],
          },
        ],
        async poll(input) {
          await check(input.signal)
          note('poll')
          await publish()
          return { messages: [], cursor: input.cursor, hasMore: false }
        },
        async send(input) {
          await check(input.signal)
          assert.equal(input.text, terminalText)
          note('post', { requestId: input.requestId, text: input.text })
          await publish()
          throw new BotAdapterError('access-denied', terminalError)
        },
        async reconcile(input) {
          await check(input.signal)
          note('reconcile', { requestId: input.requestId })
          await publish()
          return { kind: 'not-found' }
        },
        async close() {
          closed = true
          note('close')
          await publish()
        },
      }
    },
  }
  ctx.effect(() => ctx.botAdapters.register(adapter), 'bots: synthetic terminal adapter')
  // Native dispatch remains authoritative. This read-only observer uses its public contract, not cloned DTOs/routes.
  ctx.on('connection/request', async (_request, _response, next) => {
    await next()
    await publish()
  })
}
