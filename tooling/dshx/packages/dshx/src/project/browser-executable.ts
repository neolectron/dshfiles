import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { isAbsolute } from 'node:path'

const OVERRIDE = 'DSHX_E2E_CHROMIUM_EXECUTABLE'
type VersionProbe = (
  file: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number; readonly maxBuffer: number },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>

/** Explicit opt-in only: never discover a browser or reuse the user's browser profile. */
export class BrowserExecutable {
  static path(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined
    if (!isAbsolute(value)) throw new Error(`${OVERRIDE} must be an absolute Chrome/Chromium executable path; unset it to use Playwright's pinned browser.`)
    return value
  }

  static options(value: string | undefined): { readonly executablePath?: string } {
    const executablePath = BrowserExecutable.path(value)
    return executablePath === undefined ? {} : { executablePath }
  }

  /** Cache evidence must change when an explicitly selected, unpinned browser changes version. */
  static versionEvidence(executablePath: string, probe: VersionProbe = spawnSync): string {
    const result = probe(executablePath, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })
    const version = result.stdout?.trim() ?? ''
    if (result.error !== undefined || result.status !== 0 || version === '') {
      const reason = result.error?.message ?? (result.status === 0 ? 'empty version output' : `exit ${String(result.status)}`)
      throw new Error(
        `${OVERRIDE} --version failed (${reason}). Choose a runnable absolute Chrome/Chromium executable or unset the override to use Playwright's pinned browser.`,
      )
    }
    return `chromium override ${JSON.stringify(executablePath)}: ${version.replace(/\s+/g, ' ').slice(0, 1000)}`
  }
}
