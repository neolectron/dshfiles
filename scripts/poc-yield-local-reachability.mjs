#!/usr/bin/env node
// Harmless first-step check: public loopback HTTP only. No DSH login, account files,
// conversation reads, processes spawned, session creation, messages or disk writes.
const signal = AbortSignal.timeout(5000)
try {
  const response = await fetch('http://127.0.0.1:3198/', {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    signal,
  })
  const result = {
    check: 'yield-dsh-local-reachability-v1',
    at: new Date().toISOString(),
    loopbackReachable: true,
    httpStatus: response.status,
    authenticationUsed: false,
    taskCreated: false,
    limitation: 'A public HTTP response proves reachability only, not authenticated DSH tool access.',
  }
  await response.body?.cancel()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch {
  process.stdout.write(
    `${JSON.stringify({ check: 'yield-dsh-local-reachability-v1', loopbackReachable: false, authenticationUsed: false, taskCreated: false })}\n`,
  )
  process.exitCode = 1
}
