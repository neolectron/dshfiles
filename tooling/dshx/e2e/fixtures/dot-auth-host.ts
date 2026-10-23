// Scratch-only native route owner. No provider, browser launcher, credential resolver or vault.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { defineHost } from '@dshfiles/dshx/host'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AuthAttemptManager } from '../../../../plugins/@dshfiles/bot-openai-dot/src/auth-attempt.js'
import { registerDotAuthRoutes } from '../../../../plugins/@dshfiles/bot-openai-dot/src/auth-transport.js'

export default defineHost({
  name: 'dot-auth-synthetic-fixture',
  inject: ['connection', 'webServer'],
  async setup(ctx) {
    const home = process.env.DSH_HOME
    if (!home || !home.includes('dshx-boot-profile-')) throw new Error('Synthetic fixture requires an isolated E2E home.')
    const canary = randomBytes(32).toString('hex')
    const initial = new Uint8Array(await readFile(join(home, 'initial.jpg')))
    const typed = new Uint8Array(await readFile(join(home, 'typed.jpg')))
    const state = {
      opens: 0,
      closes: 0,
      frames: 0,
      pointers: 0,
      x: -1,
      y: -1,
      textEvents: 0,
      textUnits: 0,
      keys: 0,
      statusFailures: 0,
      statusCalls: 0,
      statusEntries: 0,
      statusPathMatch: false,
      statusMethodPost: false,
      statusSearchEmpty: false,
    }
    let saving = Promise.resolve()
    const save = () => {
      const snapshot = JSON.stringify(state)
      saving = saving.then(() => writeFile(join(home, 'dot-auth-synthetic-state.json'), snapshot, { mode: 0o600 }))
      return saving
    }
    let refuseStatus = false
    class SyntheticManager extends AuthAttemptManager {
      override status(capability: string) {
        state.statusCalls++
        void save()
        if (refuseStatus) {
          state.statusFailures++
          void save()
          throw new Error(canary)
        }
        return super.status(capability)
      }
    }
    const manager = new SyntheticManager({
      async open() {
        state.opens++
        await save()
        let changed = false
        return {
          async frame() {
            state.frames++
            await save()
            return { bytes: changed ? typed : initial, width: 640, height: 320 }
          },
          async input(input) {
            if (input.kind === 'pointer') {
              state.pointers++
              state.x = input.x
              state.y = input.y
            }
            if (input.kind === 'text') {
              state.textEvents++
              state.textUnits += input.text.length
              changed = true
            }
            if (input.kind === 'key') state.keys++
            await save()
          },
          async close() {
            state.closes++
            await save()
          },
        }
      },
    })
    const dispose = registerDotAuthRoutes(
      {
        browserPeer: ctx.connection.browserPeer,
        admit: request => ctx.connection.admit(request),
        fetch: {
          register: route =>
            ctx.connection.fetch.register({
              ...route,
              async fetch(request) {
                if (route.path.endsWith('/status')) {
                  const url = new URL(request.url)
                  state.statusEntries++
                  state.statusPathMatch = url.pathname === route.path
                  state.statusMethodPost = request.method === 'POST'
                  state.statusSearchEmpty = !url.search && !url.hash
                  await save()
                }
                return route.fetch(request)
              },
            }),
        },
      },
      manager,
      { browserOrigin: ctx.webServer.getOrigin() },
    )
    // Keep the canary Node-only; a fixture-only browser action arms a sanitized native status failure.
    const remove = ctx.connection.fetch.register({
      path: '/api/dot-auth-fixture/refusal',
      methods: ['POST'],
      requestBody: 'streaming',
      async fetch(request) {
        const admitted = ctx.connection.admit(request)
        if ('rejection' in admitted || admitted.peer !== ctx.connection.browserPeer || request.headers.get('origin') !== ctx.webServer.getOrigin())
          return new Response(null, { status: 403 })
        refuseStatus = true
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      },
    })
    await save()
    return async () => {
      await dispose()
      await remove()
    }
  },
})
