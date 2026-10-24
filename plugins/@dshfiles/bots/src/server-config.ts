import type { BotsServerOptions } from './server.js'

/** Shared admission check: standalone composition calls this before touching its storage root. */
export const validateBotsServerConfiguration = (options: Pick<BotsServerOptions, 'bearerToken' | 'host' | 'port'>) => {
  if (!/^[\x21-\x7e]{32,512}$/.test(options.bearerToken)) throw new Error('Bots requires a 32–512 character printable ASCII service token.')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  if ((host !== '127.0.0.1' && host !== '0.0.0.0') || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Bots listen configuration.')
  return { host, port }
}
