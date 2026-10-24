// Test preload only: never ship or enable a real provider request from a CLI fixture.
const nativeFetch = globalThis.fetch
// This is a test seam, not an OS firewall or a production security policy.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    process.exitCode = 97
    throw new Error('External requests are disabled in service CLI fixtures')
  }
  return nativeFetch(input, init)
}
