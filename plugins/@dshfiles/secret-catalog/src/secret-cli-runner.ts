import { waitForManagedExit, terminateManagedProcess } from '@dshfiles/dshx/host'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { SecretCliRequest } from './secret-operations.js'

const MAX_STDOUT_BYTES = 1_000_000
const COMMAND_TIMEOUT_MS = 15_000
const RANGE_WAIT_MS = 5_000

type SecretSubprocess = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
type SecretSessionEnvironment = Partial<Pick<NodeJS.ProcessEnv, 'BW_SESSION' | 'SECRET_SESSION_FILE'>>

const sessionEnvironment = (source: SecretSessionEnvironment) => {
  const result: Partial<Record<'BW_SESSION' | 'SECRET_SESSION_FILE', string>> = {}
  if (source.BW_SESSION !== undefined && source.BW_SESSION.length > 0) result.BW_SESSION = source.BW_SESSION
  if (source.SECRET_SESSION_FILE !== undefined && source.SECRET_SESSION_FILE.length > 0) result.SECRET_SESSION_FILE = source.SECRET_SESSION_FILE
  return result
}

/** Run the fixed secret CLI through DSH's managed process boundary. */
export const runSecretCli = async (
  runtime: SecretSubprocess,
  request: SecretCliRequest,
  environment: SecretSessionEnvironment = process.env,
): Promise<string> => {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, COMMAND_TIMEOUT_MS)
  let handle: SubprocessHandle | undefined
  try {
    const env = sessionEnvironment(environment)
    const executable = await runtime.resolveExecutable('secret', env, controller.signal)
    if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('Secret CLI executable could not be resolved.')
    handle = runtime.spawn({
      argv: [executable, ...request.args],
      cwd: request.cwd ?? homedir(),
      env,
      stdio: {
        stdin: request.stdin === undefined ? 'ignore' : 'pipe',
        stdout: request.captureStdout ? { maxBytes: MAX_STDOUT_BYTES } : 'pipe',
        stderr: 'pipe',
      },
      graceMs: 1_000,
      signal: controller.signal,
    })
    // Raw pipes are not retained by the managed service. Drain unwanted output rather than keeping even a one-byte diagnostic tail.
    if (handle.stderr === undefined || (!request.captureStdout && handle.stdout === undefined)) throw new Error('Secret CLI output pipes were unavailable.')
    handle.stderr.once('error', () => controller.abort()).resume()
    if (!request.captureStdout) handle.stdout?.once('error', () => controller.abort()).resume()
    if (request.stdin !== undefined) {
      if (handle.stdin === undefined) throw new Error('Secret CLI stdin was unavailable.')
      handle.stdin.once('error', () => controller.abort()).end(request.stdin)
    }
    const outcome = await handle.done
    if (controller.signal.aborted) throw new Error('Secret CLI command deadline elapsed.')
    if (!(await waitForManagedExit({ handle, timeoutMs: RANGE_WAIT_MS }))) throw new Error('Secret CLI process range did not exit.')
    if (controller.signal.aborted) throw new Error('Secret CLI command was cancelled while awaiting its process range.')
    if (outcome.exitCode !== 0) throw new Error('Secret CLI command returned a failure status.')
    if (!request.captureStdout) return ''
    const output = handle.collected.stdout?.readFrom(0)
    if (output === undefined || output.lossy) throw new Error('Secret CLI response exceeded the safe size limit.')
    return output.text
  } catch {
    let cleanupConfirmed = true
    if (handle !== undefined) {
      try {
        cleanupConfirmed = await terminateManagedProcess({ handle, timeoutMs: RANGE_WAIT_MS })
      } catch {
        cleanupConfirmed = false
      }
    }
    const failure = timedOut ? 'Secret CLI command timed out.' : 'Secret CLI command failed.'
    throw new Error(cleanupConfirmed ? failure : `${failure} Process cleanup could not be confirmed.`)
  } finally {
    clearTimeout(timeout)
  }
}
