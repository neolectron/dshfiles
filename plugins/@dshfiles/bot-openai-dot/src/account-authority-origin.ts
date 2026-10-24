// SPDX-License-Identifier: AGPL-3.0-only
/** Canonical pinned backend origin; never silently downgrade to LAN HTTP or trust forwarded headers. */
export function parseAccountAuthorityOrigin(value: string): URL {
  const url = URL.parse(value)
  if (
    url === null ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    (value !== url.origin && value !== `${url.origin}/`)
  )
    throw new Error('Unsafe account authority origin')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')))
    throw new Error('Unsafe account authority transport')
  return url
}
