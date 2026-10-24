// SPDX-License-Identifier: AGPL-3.0-only
/** Backend-only, explicitly admitted authority channel; no Client/tool token API. */
export { DotAccountAuthorityProtocol } from './account-authority-contract.js'
export { createDotAccountAuthorityHandler } from './account-authority-server.js'
export type { DotAccountAuthorityHandler, DotAccountAuthorityHandlerOptions } from './account-authority-server.js'
export { createDotAccountAuthorityClient } from './account-authority-client.js'
export type { DotAccountAuthorityClient, DotAccountAuthorityClientOptions } from './account-authority-client.js'
