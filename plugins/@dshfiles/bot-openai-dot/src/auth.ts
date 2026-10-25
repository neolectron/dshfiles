// SPDX-License-Identifier: AGPL-3.0-only
/** Private Host/Node composition contract. Never register these operations as tools or generic RPC. */
export { AuthAttemptError, AuthAttemptManager } from './auth-attempt.js'
export type { AuthAttemptErrorCode, AuthAttemptOptions, BrowserPort } from './auth-attempt.js'
export {
  authAttemptSnapshotSchema,
  authCompleteRequestSchema,
  authEmptyRequestSchema,
  authFrameMaxBytes,
  authInputRequestSchema,
  authStartResultSchema,
  authStartSchema,
  dotAuthCapabilityHeader,
  dotAuthRoutes,
} from './auth-protocol.js'
export type {
  AuthAttemptOperations,
  AuthAttemptSnapshot,
  AuthCompleteRequest,
  AuthInput,
  AuthInputRequest,
  AuthStartInput,
  AuthStartResult,
  Awaitable,
} from './auth-protocol.js'
export { registerDotAuthRoutes } from './auth-transport.js'
export { createDotEnrollmentEndpoints, dotEnrollmentServiceRoutes } from './enrollment-server.js'
export { createDotEnrollmentProxy } from './enrollment-proxy.js'
export type { DotEnrollmentProxyOptions } from './enrollment-proxy.js'
