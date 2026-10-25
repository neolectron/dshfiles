// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in SYNTHETIC loopback-only runtime test. Never contacts an account/provider.
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { mkdtemp, readdir, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDotBrowserLocalFixtureFactoryForTest, createDotBrowserSessionForTest } from '../src/browser-session.js'
import type { DotBrowserSession } from '../src/browser-session.js'

const executable = process.env.DSH_DOT_BROWSER_LOCAL_CHROME
const owned: Array<{ parent: string; session: DotBrowserSession }> = []
const servers: ReturnType<typeof createServer>[] = []
const signal = () => new AbortController().signal
const headers = {
  Authorization: 'Bearer synthetic.token.value',
  'Content-Type': 'application/json',
  'ChatGPT-Account-Id': 'synthetic-account',
  'X-OpenAI-Expected-Account-Id': 'synthetic-account',
  'User-Agent': 'DSHDotAdapter/0.1',
}
afterEach(async () => {
  for (const item of owned) {
    await item.session.close()
    if (
      (await realpath(item.parent)) !== item.parent ||
      dirname(item.parent) !== (await realpath(tmpdir())) ||
      !basename(item.parent).startsWith('dsh-dot-local-test-')
    )
      throw new Error('Unexpected local test directory')
    expect(await readdir(item.parent)).toEqual([])
    await rmdir(item.parent)
  }
  owned.length = 0
  for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  servers.length = 0
})
async function localServer(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  // oxlint-disable-next-line antislop/no-runtime-typeof -- Node's public server.address union discriminates pipe strings from a bound TCP AddressInfo.
  if (!address || typeof address === 'string') throw new Error('No local server address')
  return `http://127.0.0.1:${address.port}`
}
async function open(entry: string, observers: { sandbox?: (report: string) => void; revoked?: () => void } = {}) {
  if (!executable) throw new Error('No explicit synthetic Chrome executable')
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'dsh-dot-local-test-'))
  const factory = createDotBrowserLocalFixtureFactoryForTest(entry, observers.sandbox)
  const session = createDotBrowserSessionForTest({ chromiumExecutable: executable, privateProfileParentPath: parent }, input =>
    factory({
      ...input,
      revoke() {
        observers.revoked?.()
        input.revoke()
      },
    }),
  )
  owned.push({ parent, session })
  return session
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(!executable)('sandboxed real Chromium, synthetic loopback only', () => {
  it('reads actual Chrome namespace/PID/Seccomp sandbox status before the synthetic fixture in the same owned process', async () => {
    const origin = await localServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><title>Synthetic</title>')
    })
    let report = ''
    const session = await open(`${origin}/`, {
      sandbox: value => {
        report = value
      },
    })
    await session.viewer(signal())
    expect(report).toMatch(/Layer 1 Sandbox\s+Namespace/u)
    expect(report).toMatch(/PID namespaces\s+Yes/u)
    expect(report).toMatch(/Seccomp-BPF sandbox\s+Yes/u)
    // Chrome's internal namespace status is not a claim of Host/kernel egress confinement.
    expect(report).toContain('You are adequately sandboxed.')
  }, 30_000)

  it('denies a popup document before the unexpected loopback origin receives a request', async () => {
    const revoked = deferred<void>()
    let forbiddenRequests = 0
    const forbidden = await localServer((_request, response) => {
      forbiddenRequests++
      response.end('Unexpected popup')
    })
    const origin = await localServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(
        `<!doctype html><title>Synthetic</title><button style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="window.open('${forbidden}/popup')">Synthetic popup</button>`,
      )
    })
    const session = await open(`${origin}/`, { revoked: () => revoked.resolve() })
    const viewer = await session.viewer(signal())
    await viewer.input({ kind: 'pointer', action: 'down', x: 60, y: 50, button: 'left' }, signal())
    const released = viewer.input({ kind: 'pointer', action: 'up', x: 60, y: 50, button: 'left' }, signal()).catch(() => undefined)
    await revoked.promise
    await released
    await session.close()
    expect(forbiddenRequests).toBe(0)
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'forbidden' })
  }, 30_000)

  it('revokes a download without exposing any filesystem save capability', async () => {
    const revoked = deferred<void>()
    const origin = await localServer((request, response) => {
      if (request.url === '/synthetic-download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=synthetic.txt' })
        response.end('Synthetic download')
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(
          '<!doctype html><title>Synthetic</title><a download href="/synthetic-download" style="position:absolute;left:20px;top:20px;width:200px;height:60px">Synthetic download</a>',
        )
      }
    })
    const session = await open(`${origin}/`, { revoked: () => revoked.resolve() })
    const viewer = await session.viewer(signal())
    await viewer.input({ kind: 'pointer', action: 'down', x: 60, y: 40, button: 'left' }, signal())
    const released = viewer.input({ kind: 'pointer', action: 'up', x: 60, y: 40, button: 'left' }, signal()).catch(() => undefined)
    await revoked.promise
    await released
    await session.close()
    await expect(viewer.frame(signal())).rejects.toMatchObject({ code: 'forbidden' })
  }, 30_000)

  it('denies sensitive browser permissions to first-party content', async () => {
    const permission = deferred<string>()
    const origin = await localServer((request, response) => {
      if (request.url?.startsWith('/permission-result?state=')) {
        permission.resolve(request.url.slice('/permission-result?state='.length))
        response.end('Synthetic permission received')
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(
          '<!doctype html><title>Synthetic</title><script>navigator.permissions.query({name:"geolocation"}).then(value => fetch("/permission-result?state="+value.state))</script>',
        )
      }
    })
    const session = await open(`${origin}/`)
    await session.viewer(signal())
    expect(await permission.promise).toBe('denied')
  }, 30_000)

  it('overlaps a real screenshot with human typing, then uses its own cookies/native UA and closes its private profile', async () => {
    let received: { cookie: string | undefined; userAgent: string | undefined; authorization: string | undefined; body: string } | undefined
    const origin = await localServer((request, response) => {
      if (request.url === '/backend-api/messaging/rooms/synthetic/messages') {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          received = { cookie: request.headers.cookie, userAgent: request.headers['user-agent'], authorization: request.headers.authorization, body }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'hidden_response_cookie=synthetic; HttpOnly' })
          response.end('{"synthetic":true}')
        })
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'own_browser_cookie=synthetic; HttpOnly; SameSite=Strict' })
        response.end(
          '<!doctype html><title>Synthetic first party</title><input autofocus style="position:absolute;left:20px;top:20px"><script>document.cookie="js_ran=synthetic; SameSite=Strict"; document.querySelector("input").focus(); document.querySelector("input").addEventListener("input", event => { document.cookie="typed="+encodeURIComponent(event.target.value)+"; SameSite=Strict" })</script>',
        )
      }
    })
    const session = await open(`${origin}/`)
    const enrollment = new AbortController()
    const viewer = await session.viewer(enrollment.signal)
    const [frame] = await Promise.all([viewer.frame(signal()), viewer.input({ kind: 'text', text: 'Synthetic human only' }, signal())])
    expect(frame.width).toBe(1280)
    expect(frame.height).toBe(900)
    expect(frame.bytes[0]).toBe(0xff)
    await viewer.input({ kind: 'key', key: 'Tab', action: 'down', modifiers: 0 }, signal())
    await viewer.input({ kind: 'key', key: 'Tab', action: 'up', modifiers: 0 }, signal())
    await session.complete(signal())
    enrollment.abort()
    await viewer.close()
    const response = await session.fetch('https://chatgpt.com/backend-api/messaging/rooms/synthetic/messages', {
      method: 'POST',
      headers,
      redirect: 'error',
      credentials: 'omit',
      body: '{"synthetic":"bounded"}',
    })
    expect(await response.json()).toEqual({ synthetic: true })
    expect(received?.cookie).toContain('own_browser_cookie=synthetic')
    expect(received?.cookie).toContain('js_ran=synthetic')
    expect(received?.cookie).toContain('typed=Synthetic%20human%20only')
    expect(received?.userAgent).toContain('Chrome/')
    expect(received?.userAgent).not.toContain('DSHDotAdapter')
    expect(received?.authorization).toBe('Bearer synthetic.token.value')
    expect(received?.body).toBe('{"synthetic":"bounded"}')
    expect(response.headers.get('set-cookie')).toBeNull()
    await session.close()
  }, 30_000)

  it('allows a real same-origin browser send while a long API poll is pending', async () => {
    const pollEntered = deferred<void>()
    let pollResponse: ServerResponse | undefined
    let sends = 0
    const origin = await localServer((request, response) => {
      if (request.url === '/backend-api/tbo/primary') {
        pollResponse = response
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.flushHeaders()
        pollEntered.resolve()
      } else if (request.url === '/backend-api/messaging/rooms/synthetic/messages') {
        sends++
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"sent":true}')
        pollResponse?.end('{"polled":true}')
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Synthetic</title>')
      }
    })
    const session = await open(`${origin}/`)
    await session.viewer(signal())
    await session.complete(signal())
    const polling = session.fetch('https://chatgpt.com/backend-api/tbo/primary', { method: 'GET', headers })
    await pollEntered.promise
    try {
      const sent = await session.fetch('https://chatgpt.com/backend-api/messaging/rooms/synthetic/messages', { method: 'POST', headers, body: '{}' })
      expect(await sent.json()).toEqual({ sent: true })
      expect(await (await polling).json()).toEqual({ polled: true })
      expect(sends).toBe(1)
    } finally {
      if (pollResponse && !pollResponse.writableEnded) pollResponse.end('{"polled":true}')
      await polling.catch(() => undefined)
    }
  }, 30_000)

  it.each([200, 403])(
    'refuses ongoing synthetic challenge admission without solving or retries: HTTP %i',
    async status => {
      const origin = await localServer((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' })
        response.end('<!doctype html><title>Just a moment...</title><div id="challenge-running">Synthetic security check</div>')
      })
      const session = await open(`${origin}/`)
      const viewer = await session.viewer(signal())
      await expect(session.complete(signal())).rejects.toMatchObject({ code: 'not-admitted' })
      expect((await viewer.frame(signal())).bytes.length).toBeGreaterThan(5)
    },
    30_000,
  )

  it('blocks every top-frame redirect hop before an unexpected loopback origin receives it', async () => {
    let forbiddenRequests = 0
    const forbidden = await localServer((_request, response) => {
      forbiddenRequests++
      response.end('Unexpected origin')
    })
    const origin = await localServer((_request, response) => {
      response.writeHead(302, { Location: `${forbidden}/unexpected` })
      response.end()
    })
    const session = await open(`${origin}/`)
    await expect(session.viewer(signal())).rejects.toThrow('Dot browser session operation refused.')
    expect(forbiddenRequests).toBe(0)
  }, 30_000)

  it.each(['streamed', 'advertised'])(
    'bounds native-browser response bytes: %s',
    async mode => {
      const origin = await localServer((request, response) => {
        if (request.url === '/backend-api/tbo/primary') {
          if (mode === 'advertised') response.setHeader('Content-Length', String(4 * 1024 * 1024 + 1))
          response.writeHead(200, { 'Content-Type': 'application/json' })
          if (mode === 'streamed') for (let index = 0; index < 65; index++) response.write(Buffer.alloc(64 * 1024, 32))
          response.end('Synthetic bounded response')
        } else {
          response.writeHead(200, { 'Content-Type': 'text/html' })
          response.end('<!doctype html><title>Synthetic</title>')
        }
      })
      const session = await open(`${origin}/`)
      await session.viewer(signal())
      await session.complete(signal())
      await expect(session.fetch('https://chatgpt.com/backend-api/tbo/primary', { method: 'GET', headers })).rejects.toThrow(
        'Dot browser session operation refused.',
      )
    },
    30_000,
  )

  it('does not follow native-browser API redirects', async () => {
    let forbiddenRequests = 0
    const forbidden = await localServer((_request, response) => {
      forbiddenRequests++
      response.end('Unexpected API redirect')
    })
    const origin = await localServer((request, response) => {
      if (request.url === '/backend-api/tbo/primary') {
        response.writeHead(302, { Location: `${forbidden}/unexpected` })
        response.end()
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Synthetic</title>')
      }
    })
    const session = await open(`${origin}/`)
    await session.viewer(signal())
    await session.complete(signal())
    await expect(session.fetch('https://chatgpt.com/backend-api/tbo/primary', { method: 'GET', headers })).rejects.toThrow(
      'Dot browser session operation refused.',
    )
    expect(forbiddenRequests).toBe(0)
  }, 30_000)
})
