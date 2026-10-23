import type { Page } from '@playwright/test'

/** Only bounded counters/booleans leave this observer. Never retain URL, body, header value or capability. */
export function auditDotAuthNetwork(page: Page) {
  const counts = {
    start: 0,
    status: 0,
    frame: 0,
    input: 0,
    cancel: 0,
    malformed: 0,
    protected: 0,
    noStore: 0,
    failures: 0,
    lastFailureCode: 0,
    lastFailureOperation: '',
  }
  const methods = { start: 'POST', status: 'POST', frame: 'POST', input: 'POST', cancel: 'POST' }
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/dshfiles/dot-auth/')) return
    const operation = url.pathname.split('/').at(-1)
    if (operation !== 'start' && operation !== 'status' && operation !== 'frame' && operation !== 'input' && operation !== 'cancel') {
      counts.malformed++
      return
    }
    counts[operation]++
    if (url.search || url.hash || request.method() !== methods[operation]) counts.malformed++
    const headers = request.headers()
    if (operation !== 'start' && Object.hasOwn(headers, 'x-dot-auth-capability')) counts.protected++
    if (headers['cache-control'] === 'no-store') counts.noStore++
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api/dshfiles/dot-auth/') && response.status() >= 400) {
      counts.failures++
      counts.lastFailureCode = response.status()
      counts.lastFailureOperation = url.pathname.split('/').at(-1) ?? ''
    }
  })
  return counts
}
