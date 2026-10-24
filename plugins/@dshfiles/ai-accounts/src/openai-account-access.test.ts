import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, lstat, realpath, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountDraftSchema } from './api.js'
import type { AccountStoreFile } from './account-store.js'
import { OpenAIAccountAccess, OpenAIAccountAccessError, type OpenAIAccountAccessSource } from './openai-account-access.js'
import { readCodexAccessToken } from './read-codex-token.js'

const now = 1800000000000
const signal = () => new AbortController().signal
const token = (subject = 'SYNTHETIC_SUBJECT', account = 'SYNTHETIC_ACCOUNT', expiry = now / 1000 + 3600) =>
  `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: subject, exp: expiry, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.SYNTHETIC_SIGNATURE`
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  // The real owner path policy contains homes under the OS account, not a spoofable HOME.
  const parent = await realpath(userInfo().homedir)
  const root = await mkdtemp(join(parent, '.dsh-openai-access-test-'))
  const identity = await lstat(root)
  cleanup.push(async () => {
    const current = await lstat(root)
    expect(dirname(root)).toBe(parent)
    expect(basename(root).startsWith('.dsh-openai-access-test-')).toBe(true)
    expect(await realpath(root)).toBe(root)
    expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
    await rm(root, { recursive: true })
  })
  const shared = join(root, 'shared')
  const selectedHome = join(root, 'selected')
  await mkdir(shared, { mode: 0o700 })
  await mkdir(selectedHome, { mode: 0o700 })
  const auth = join(selectedHome, 'auth.json')
  await writeFile(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token(), refresh_token: 'SYNTHETIC_REFRESH_NEVER_LEAVES_OWNER' } }), {
    mode: 0o600,
  })
  const account = accountDraftSchema.parse({
    instanceId: 'selected',
    kind: 'codex',
    displayName: 'Synthetic selected',
    enabled: true,
    homePath: shared,
    shadowHomePath: selectedHome,
    apiKeyEnv: '',
    apiBaseUrl: '',
    badge: '',
    accentColor: '',
    providerIcon: '',
  })
  let metadata: AccountStoreFile = { distribution: 'sticky', cooldownMs: 300000, shadowRoot: join(root, 'implicit'), accounts: [account] }
  const reads: string[] = []
  const source: OpenAIAccountAccessSource = {
    readAccounts: async () => metadata,
    readAccessToken: async (home, cancellation) => {
      reads.push(home)
      return readCodexAccessToken(home, { signal: cancellation })
    },
  }
  const broker = OpenAIAccountAccess.create({ accountId: account.instanceId, purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
  cleanup.push(async () => broker.close())
  return {
    root,
    auth,
    shared,
    selectedHome,
    account,
    source,
    broker,
    reads,
    metadata: () => metadata,
    setMetadata: (value: AccountStoreFile) => {
      metadata = value
    },
  }
}

describe('Host-only selected OpenAI account access', () => {
  it('reads only the exact configured login without materializing or changing it, and does not expose records', async () => {
    const test = await fixture()
    const original = await readFile(test.auth)
    let callbacks = 0
    expect(
      await test.broker.withAccessToken(signal(), async (access, bounded) => {
        callbacks++
        expect(access).toBe(token())
        expect(bounded.aborted).toBe(false)
        return 'safe-status-only'
      }),
    ).toBe('safe-status-only')
    expect(test.reads).toEqual([test.selectedHome])
    expect(callbacks).toBe(1)
    expect(await readFile(test.auth)).toEqual(original)
    expect((await lstat(test.auth)).mode & 0o777).toBe(0o600)
    expect(test.broker.accountId).toBe('selected')
    expect(test.broker.version).toBe(1)
    test.broker.close()
    await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'canceled' })
    expect(test.reads).toHaveLength(1)
  })

  it('refuses missing, disabled, duplicate or non-Codex selection without reading another account', async () => {
    const test = await fixture()
    const other = { ...test.account, instanceId: 'other', shadowHomePath: join(test.root, 'other') }
    for (const accounts of [
      [other],
      [{ ...test.account, enabled: false }, other],
      [{ ...test.account, kind: 'claude' as const }, other],
      [test.account, test.account],
    ]) {
      test.setMetadata({ ...test.metadata(), accounts })
      await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'account-unavailable' })
    }
    expect(test.reads).toEqual([])
    expect(() => OpenAIAccountAccess.create({ accountId: '', purpose: 'openai-dot', acceptRisks: true })).toThrow(OpenAIAccountAccessError)
  })

  it('sees token rotation for the same identity but permanently refuses another identity', async () => {
    const test = await fixture()
    await test.broker.withAccessToken(signal(), async () => undefined)
    const next = token('SYNTHETIC_SUBJECT', 'SYNTHETIC_ACCOUNT', now / 1000 + 7200)
    await writeFile(test.auth, JSON.stringify({ tokens: { access_token: next } }))
    await test.broker.withAccessToken(signal(), async value => {
      expect(value).toBe(next)
    })
    await writeFile(test.auth, JSON.stringify({ tokens: { access_token: token('DIFFERENT_SUBJECT') } }))
    await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(test.reads).toHaveLength(3)
  })

  it('fails expired, malformed, API-key and unsafe credential files with fixed errors and no callback', async () => {
    const test = await fixture()
    let callbacks = 0
    for (const raw of [
      JSON.stringify({ tokens: { access_token: token('SYNTHETIC_SUBJECT', 'SYNTHETIC_ACCOUNT', now / 1000) } }),
      JSON.stringify({ OPENAI_API_KEY: 'SYNTHETIC_PRIVATE_CANARY', tokens: { access_token: token() } }),
      JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: token() } }),
      '{SYNTHETIC_PRIVATE_CANARY',
      JSON.stringify({ tokens: { access_token: 'SYNTHETIC_PRIVATE_CANARY' } }),
      'x'.repeat(256 * 1024 + 1),
    ]) {
      await writeFile(test.auth, raw)
      const error = await test.broker
        .withAccessToken(signal(), async () => {
          callbacks++
          return undefined
        })
        .catch(error => error)
      expect(error).toBeInstanceOf(OpenAIAccountAccessError)
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_CANARY')
      expect(String(error)).not.toContain(test.root)
    }
    await writeFile(test.auth, JSON.stringify({ tokens: { access_token: token() } }))
    await chmod(test.auth, 0o644)
    await expect(
      test.broker.withAccessToken(signal(), async () => {
        callbacks++
      }),
    ).rejects.toMatchObject({ code: 'access-unavailable' })
    expect(callbacks).toBe(0)
  })

  it('refuses symlinked credentials rather than following another login', async () => {
    const test = await fixture()
    const linkedHome = join(test.root, 'linked')
    await mkdir(linkedHome, { mode: 0o700 })
    await symlink(test.auth, join(linkedHome, 'auth.json'))
    test.setMetadata({ ...test.metadata(), accounts: [{ ...test.account, shadowHomePath: linkedHome }] })
    await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'access-unavailable' })
    expect(test.reads).toEqual([linkedHome])
  })

  it('rechecks removal or layout changes while access is being read before using a token', async () => {
    const test = await fixture()
    let release: (value: string) => void = () => undefined
    let started: () => void = () => undefined
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    const source: OpenAIAccountAccessSource = {
      readAccounts: test.source.readAccounts,
      readAccessToken: async () => {
        started()
        return new Promise(resolve => {
          release = resolve
        })
      },
    }
    const broker = OpenAIAccountAccess.create({ accountId: 'selected', purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    cleanup.push(async () => broker.close())
    let called = false
    const request = broker.withAccessToken(signal(), async () => {
      called = true
    })
    await entered
    test.setMetadata({ ...test.metadata(), accounts: [] })
    release(token())
    await expect(request).rejects.toMatchObject({ code: 'account-unavailable' })
    expect(called).toBe(false)
  })

  it('rechecks permission before returning a callback result and redacts callback failures', async () => {
    const test = await fixture()
    const selected = test.metadata()
    await expect(
      test.broker.withAccessToken(signal(), async () => {
        throw new Error('SYNTHETIC_PRIVATE_CANARY')
      }),
    ).rejects.toMatchObject({ code: 'access-unavailable' })
    await expect(
      test.broker.withAccessToken(signal(), async () => {
        test.setMetadata({ ...selected, accounts: [] })
        return 'private-result'
      }),
    ).rejects.toMatchObject({ code: 'account-unavailable' })
  })

  it('bounds an uncooperative source and never dispatches late access after close or deadline', async () => {
    const test = await fixture()
    vi.useFakeTimers()
    let finish: (value: AccountStoreFile) => void = () => undefined
    let reads = 0
    let calls = 0
    const source: OpenAIAccountAccessSource = {
      readAccounts: () =>
        new Promise(resolve => {
          finish = resolve
        }),
      readAccessToken: async () => {
        reads++
        return token()
      },
    }
    const broker = OpenAIAccountAccess.create({ accountId: 'selected', purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    cleanup.push(async () => broker.close())
    const request = broker.withAccessToken(signal(), async () => {
      calls++
    })
    const denied = expect(request).rejects.toMatchObject({ code: 'canceled' })
    await vi.advanceTimersByTimeAsync(10000)
    await denied
    finish(test.metadata())
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(0)
    expect(calls).toBe(0)
    broker.close()
    await expect(
      broker.withAccessToken(signal(), async () => {
        calls++
      }),
    ).rejects.toMatchObject({ code: 'canceled' })
    expect(calls).toBe(0)
  })

  it('pins the selected account against public-property replacement and rechecks layout changes', async () => {
    const test = await fixture()
    expect(() => Object.assign(test.broker, { accountId: 'other' })).toThrow()
    await test.broker.withAccessToken(signal(), async () => undefined)
    expect(test.reads).toEqual([test.selectedHome])
    const source: OpenAIAccountAccessSource = {
      readAccounts: test.source.readAccounts,
      readAccessToken: async (home, cancellation) => {
        const value = await test.source.readAccessToken(home, cancellation)
        test.setMetadata({ ...test.metadata(), accounts: [{ ...test.account, shadowHomePath: join(test.root, 'new-layout') }] })
        return value
      },
    }
    const broker = OpenAIAccountAccess.create({ accountId: 'selected', purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    cleanup.push(async () => broker.close())
    let called = false
    await expect(
      broker.withAccessToken(signal(), async () => {
        called = true
      }),
    ).rejects.toMatchObject({ code: 'account-unavailable' })
    expect(called).toBe(false)
    expect(test.reads).toEqual([test.selectedHome, test.selectedHome])
  })

  it('never seeds a missing implicit shadow from an otherwise signed-in shared home', async () => {
    const test = await fixture()
    await writeFile(join(test.shared, 'auth.json'), JSON.stringify({ tokens: { access_token: token() } }), { mode: 0o600 })
    test.setMetadata({ ...test.metadata(), accounts: [{ ...test.account, shadowHomePath: '' }] })
    await expect(test.broker.withAccessToken(signal(), async () => 'not-called')).rejects.toMatchObject({ code: 'access-unavailable' })
    expect(test.reads).toEqual([join(test.root, 'implicit', 'selected')])
    await expect(lstat(join(test.root, 'implicit'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('caller cancellation prevents a late credential read from dispatching its callback', async () => {
    const test = await fixture()
    let release: (value: string) => void = () => undefined
    let started: () => void = () => undefined
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    const source: OpenAIAccountAccessSource = {
      readAccounts: test.source.readAccounts,
      readAccessToken: async () => {
        started()
        return new Promise(resolve => {
          release = resolve
        })
      },
    }
    const broker = OpenAIAccountAccess.create({ accountId: 'selected', purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    cleanup.push(async () => broker.close())
    const caller = new AbortController()
    let called = false
    const request = broker.withAccessToken(caller.signal, async () => {
      called = true
    })
    await entered
    caller.abort('SYNTHETIC_PRIVATE_ABORT_REASON')
    await expect(request).rejects.toMatchObject({ code: 'canceled' })
    release(token())
    await Promise.resolve()
    await Promise.resolve()
    expect(called).toBe(false)
  })

  it('reconstructs same-class errors without private messages, causes or source state', async () => {
    const test = await fixture()
    const foreign = new OpenAIAccountAccessError('access-unavailable')
    foreign.message = 'SYNTHETIC_PRIVATE_CANARY'
    foreign.cause = new Error('SYNTHETIC_PRIVATE_CAUSE')
    const error = await test.broker
      .withAccessToken(signal(), async () => {
        throw foreign
      })
      .catch(error => error)
    expect(error).toBeInstanceOf(OpenAIAccountAccessError)
    expect(error).not.toBe(foreign)
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE')
    expect(JSON.stringify(test.broker)).not.toContain('SYNTHETIC_SUBJECT')
    const source = { ...test.source, cachedPrivateValue: 'SYNTHETIC_PRIVATE_SOURCE' }
    const broker = OpenAIAccountAccess.create({ accountId: 'selected', purpose: 'openai-dot', acceptRisks: true, source, now: () => now })
    cleanup.push(async () => broker.close())
    await broker.withAccessToken(signal(), async () => undefined)
    expect(JSON.stringify(broker)).not.toContain('SYNTHETIC_PRIVATE_SOURCE')
    expect(JSON.stringify(broker)).not.toContain(test.root)
  })

  it('preserves valid legacy login reads while the delegated path remains private and read-only', async () => {
    const test = await fixture()
    await writeFile(test.auth, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: token(), refresh_token: 'SYNTHETIC_REFRESH_NOT_RETURNED' } }))
    await chmod(test.auth, 0o644)
    expect(await readCodexAccessToken(test.selectedHome)).toBe(token())
    await expect(readCodexAccessToken(test.selectedHome, { signal: signal() })).rejects.toThrow()
    expect(await readFile(test.auth, 'utf8')).toContain('SYNTHETIC_REFRESH_NOT_RETURNED')
  })
})
