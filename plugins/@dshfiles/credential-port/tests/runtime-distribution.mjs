import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSecretReference, formatSecretReference } from '@dshfiles/credential-port'

// Ordinary Node, not Vite: no TypeScript loader can conceal a broken runtime export.
test('the public credential port loads built JavaScript with working sibling imports', () => {
  assert.ok(import.meta.resolve('@dshfiles/credential-port').endsWith('/dist/index.js'))
  const parsed = parseSecretReference('secret:SYNTHETIC_DOT_SESSION')
  assert.deepEqual(parsed, { alias: 'SYNTHETIC_DOT_SESSION', environment: 'prod' })
  assert.equal(formatSecretReference(parsed), 'secret:SYNTHETIC_DOT_SESSION')
})
