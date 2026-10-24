import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JsonText } from '../src/api/index.js'
import { readProfileComposition } from '../src/project/profile-composition.js'
import { ScratchProfileRuntime } from '../src/project/scratch-profile.js'

const proofSchema = z.object({ home: z.string(), profileRoot: z.string(), privateCredentialPresent: z.boolean() })
afterEach(() => vi.unstubAllEnvs())

describe('scratch DSH executable selection', () => {
  it('preserves the ordinary PATH fallback only when no override is present', () => {
    expect(ScratchProfileRuntime.dshExecutable({})).toBe('dsh')
    expect(ScratchProfileRuntime.dshExecutable({ DSHX_DSH_EXECUTABLE: '/selected/installed/dsh' })).toBe('/selected/installed/dsh')
  })

  it('rejects blank, relative and control-character overrides without exposing their value', () => {
    for (const value of ['', ' ', 'relative/PRIVATE_CLI', './PRIVATE_CLI', '/PRIVATE_CLI\nargument', ' /PRIVATE_CLI', '/PRIVATE_CLI ']) {
      expect(() => ScratchProfileRuntime.dshExecutable({ DSHX_DSH_EXECUTABLE: value })).toThrow('DSHX_DSH_EXECUTABLE must name an absolute executable path.')
    }
  })

  it('bypasses an unsafe PATH wrapper and preserves the isolated home when dumping composition', async () => {
    const parent = await realpath(tmpdir())
    const root = await mkdtemp(join(parent, 'dshx-executable-test-'))
    const identity = await lstat(root)
    try {
      const unsafeBin = join(root, 'unsafe-bin')
      const home = join(root, 'home')
      const profileRoot = join(home, 'profiles', 'sample')
      await mkdir(unsafeBin)
      await mkdir(profileRoot, { recursive: true })
      const wrapper = join(unsafeBin, 'dsh')
      await writeFile(wrapper, '#!/bin/sh\nexit 91\n', { mode: 0o700 })
      const executable = join(root, 'installed-cli.mjs')
      await writeFile(
        executable,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ home: process.env.DSH_HOME, profileRoot: process.env.DSHX_BOOT_PROFILE_ROOT, privateCredentialPresent: Boolean(process.env.OPENAI_API_KEY) }))\n',
        { mode: 0o700 },
      )
      await chmod(executable, 0o700)
      vi.stubEnv('DSHX_DSH_EXECUTABLE', executable)
      vi.stubEnv('PATH', `${unsafeBin}${delimiter}${process.env.PATH ?? ''}`)
      vi.stubEnv('OPENAI_API_KEY', 'SYNTHETIC_PRIVATE_CREDENTIAL_NOT_INHERITED')
      const dump = await readProfileComposition({ projectRoot: root, profile: 'sample', profileRoot, dshHome: home, timeoutMs: 5000 })
      expect(JsonText.parse(dump, proofSchema)).toEqual({ home, profileRoot, privateCredentialPresent: false })
    } finally {
      const current = await lstat(root)
      expect(dirname(root)).toBe(parent)
      expect(basename(root).startsWith('dshx-executable-test-')).toBe(true)
      expect(await realpath(root)).toBe(root)
      expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino])
      await rm(root, { recursive: true })
    }
  })
})
