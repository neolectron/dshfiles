import { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { runSecretCli } from './secret-cli-runner.js'

interface Harness {
  readonly runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  readonly spec: () => SubprocessSpawnSpec | undefined
  readonly handle: SubprocessHandle
  readonly stdin: () => string
}

const harness = (options: { readonly exitCode?: number | null; readonly lossy?: boolean; readonly output?: string } = {}): Harness => {
  let spec: SubprocessSpawnSpec | undefined
  let input = ''
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      input += Buffer.from(chunk).toString('utf8')
      done()
    },
  })
  const handle: SubprocessHandle = {
    stdin,
    stdout: Readable.from([options.output ?? 'synthetic mutation output']),
    stderr: Readable.from(['synthetic diagnostic output']),
    control: undefined,
    collected: {
      stdout: {
        readFrom: vi.fn(() => ({ text: options.output ?? '', nextOffset: (options.output ?? '').length, lossy: options.lossy ?? false })),
      },
    },
    done: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
  const runtime: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
    resolveExecutable: vi.fn(async () => '/nix/store/secret-cli/bin/secret'),
    spawn: vi.fn(next => {
      spec = next
      return handle
    }),
  }
  return { runtime, spec: () => spec, handle, stdin: () => input }
}

describe('managed secret CLI runner', () => {
  it('uses argv, bounds output, pipes manual values on stdin, and forwards only the CLI session inputs', async () => {
    const test = harness({ output: 'synthetic-output\n' })
    const environment: NodeJS.ProcessEnv = {
      BW_SESSION: 'synthetic-session-token',
      SECRET_SESSION_FILE: '/private/tmp/synthetic-secret-session',
      AWS_SECRET_ACCESS_KEY: 'must-not-be-forwarded',
    }
    const result = await runSecretCli(
      test.runtime,
      {
        args: ['set', 'SYNTHETIC_TOKEN', '--env', 'dev'],
        cwd: '/private/tmp/project',
        captureStdout: true,
        stdin: 'synthetic-secret-value',
      },
      environment,
    )

    expect(result).toBe('synthetic-output\n')
    expect(test.spec()?.argv).toEqual(['/nix/store/secret-cli/bin/secret', 'set', 'SYNTHETIC_TOKEN', '--env', 'dev'])
    expect(test.spec()?.cwd).toBe('/private/tmp/project')
    expect(test.spec()?.env).toEqual({ BW_SESSION: 'synthetic-session-token', SECRET_SESSION_FILE: '/private/tmp/synthetic-secret-session' })
    expect(test.spec()?.stdio).toEqual({ stdin: 'pipe', stdout: { maxBytes: 1_000_000 }, stderr: 'pipe' })
    expect(test.handle.stderr?.readableFlowing).toBe(true)
    expect(test.stdin()).toBe('synthetic-secret-value')
    expect(test.handle.waitForExit).toHaveBeenCalledOnce()
  })

  it('does not expose CLI stdout for copy and mutation commands', async () => {
    const test = harness({ output: 'must-not-reach-the-caller' })
    const result = await runSecretCli(
      test.runtime,
      {
        args: ['get', 'SYNTHETIC_TOKEN', '--copy'],
        cwd: '/private/tmp/project',
        captureStdout: false,
      },
      {},
    )

    expect(result).toBe('')
    expect(test.spec()?.stdio.stdout).toBe('pipe')
    expect(test.spec()?.stdio.stderr).toBe('pipe')
    expect(test.handle.stdout?.readableFlowing).toBe(true)
    expect(test.handle.stderr?.readableFlowing).toBe(true)
    expect(test.spec()?.env).toEqual({})
  })

  it('rejects a diagnostic stream failure that arrives while waiting for the process range', async () => {
    const test = harness()
    vi.mocked(test.handle.waitForExit).mockImplementationOnce(async () => {
      test.handle.stderr?.emit('error', new Error('synthetic-private-diagnostic'))
      return true
    })
    await expect(runSecretCli(test.runtime, { args: ['set', 'SYNTHETIC_TOKEN'], cwd: null, captureStdout: false }, {})).rejects.toThrow(
      'Secret CLI command failed.',
    )
    expect(test.handle.terminate).toHaveBeenCalledOnce()
  })

  it('bounds stdin write errors through cancellation without exposing input diagnostics', async () => {
    const test = harness()
    let handled = false
    vi.mocked(test.handle.waitForExit).mockImplementationOnce(async () => {
      handled = test.handle.stdin?.emit('error', new Error('synthetic-private-stdin-detail')) ?? false
      return true
    })
    await expect(
      runSecretCli(test.runtime, { args: ['set', 'SYNTHETIC_TOKEN'], cwd: null, captureStdout: false, stdin: 'synthetic-value' }, {}),
    ).rejects.toThrow('Secret CLI command failed.')
    expect(handled && test.spec()?.signal?.aborted).toBe(true)
  })

  it('never exposes provider diagnostics when process termination itself fails', async () => {
    const test = harness({ exitCode: 2 })
    vi.mocked(test.handle.terminate).mockImplementation(() => {
      throw new Error('synthetic-private-termination-detail')
    })
    await expect(runSecretCli(test.runtime, { args: ['set', 'SYNTHETIC_TOKEN'], cwd: null, captureStdout: false }, {})).rejects.toThrow(
      new Error('Secret CLI command failed. Process cleanup could not be confirmed.'),
    )
  })

  it('terminates the managed process range and returns only a generic error for failed or oversized output', async () => {
    const failed = harness({ exitCode: 2 })
    await expect(runSecretCli(failed.runtime, { args: ['print', '--json'], cwd: null, captureStdout: true }, {})).rejects.toThrow('Secret CLI command failed.')
    expect(failed.handle.terminate).toHaveBeenCalledOnce()

    const oversized = harness({ lossy: true })
    await expect(runSecretCli(oversized.runtime, { args: ['get', 'SYNTHETIC_TOKEN'], cwd: null, captureStdout: true }, {})).rejects.toThrow(
      'Secret CLI command failed.',
    )
    expect(oversized.handle.terminate).toHaveBeenCalledOnce()
  })
})
