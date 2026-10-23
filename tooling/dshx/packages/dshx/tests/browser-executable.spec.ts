import { describe, expect, it, vi } from 'vitest'
import { BrowserExecutable } from '../src/project/browser-executable.js'

describe('explicit browser executable override', () => {
  it('leaves the pinned Playwright browser unchanged by default', () => {
    expect(BrowserExecutable.path(undefined)).toBeUndefined()
    expect(BrowserExecutable.options(undefined)).toEqual({})
    expect(BrowserExecutable.options('')).toEqual({})
  })

  it('accepts an explicit absolute executable path without changing profile or launch flags', () => {
    expect(BrowserExecutable.options('/opt/system browser/chrome')).toEqual({ executablePath: '/opt/system browser/chrome' })
  })

  it('rejects relative paths and shell commands instead of discovering or falling back', () => {
    for (const value of ['chrome', './chrome', '~/bin/chrome', 'google-chrome --no-sandbox', ' '])
      expect(() => BrowserExecutable.options(value)).toThrow('DSHX_E2E_CHROMIUM_EXECUTABLE must be an absolute')
  })

  it('records the selected browser version with a bounded shell-free probe for cache invalidation', () => {
    const probe = vi.fn(() => ({ status: 0, stdout: 'Chromium 155.0.1\n' }))
    expect(BrowserExecutable.versionEvidence('/opt/chrome', probe)).toBe('chromium override "/opt/chrome": Chromium 155.0.1')
    expect(probe).toHaveBeenCalledExactlyOnceWith('/opt/chrome', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })
    const newer = () => ({ status: 0, stdout: 'Chromium 156.0.1\n' })
    expect(BrowserExecutable.versionEvidence('/opt/chrome', newer)).not.toBe(BrowserExecutable.versionEvidence('/opt/chrome', probe))
    expect(BrowserExecutable.versionEvidence('/opt/other-chrome', newer)).not.toBe(BrowserExecutable.versionEvidence('/opt/chrome', newer))
  })

  it('fails helpfully when version evidence is unavailable instead of replaying an incompatible cache', () => {
    expect(() => BrowserExecutable.versionEvidence('/missing/chrome', () => ({ status: null, stdout: '', error: new Error('ENOENT') }))).toThrow(
      'DSHX_E2E_CHROMIUM_EXECUTABLE --version failed (ENOENT)',
    )
    expect(() => BrowserExecutable.versionEvidence('/blocked/chrome', () => ({ status: null, stdout: '', error: new Error('ETIMEDOUT') }))).toThrow(
      'Choose a runnable absolute Chrome/Chromium executable',
    )
    expect(() => BrowserExecutable.versionEvidence('/broken/chrome', () => ({ status: 127, stdout: '' }))).toThrow('exit 127')
    expect(() => BrowserExecutable.versionEvidence('/silent/chrome', () => ({ status: 0, stdout: '  ' }))).toThrow('empty version output')
  })
})
