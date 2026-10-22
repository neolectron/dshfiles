# Protocol provenance and update policy

This package is a separately licensed **AGPL-3.0-only** TypeScript port of the native messaging behavior in [Beeper chatgpt-dots](https://github.com/beeper/chatgpt-dots/tree/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb), pinned to `ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb`. The original full LICENSE is preserved verbatim in [LICENSE](LICENSE). Original source credits and notices remain attributable to the Beeper chatgpt-dots contributors. The TypeScript translation and DSH glue are distributed under that same license, not the surrounding repository's MIT license. The package ships its source, fixtures and build configuration alongside the bundle for corresponding-source access.

## Source mapping

- [`pkg/chatgpt/client.go`](https://github.com/beeper/chatgpt-dots/blob/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb/pkg/chatgpt/client.go): JWT account-binding hints, identity-preserving renewal, primary/by-thread discovery, verified rooms, stable send IDs, bounded message pages. Ported into `src/protocol.ts`, `src/http.ts`, `src/adapter.ts`.
- [`pkg/connector/login.go`](https://github.com/beeper/chatgpt-dots/blob/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb/pkg/connector/login.go): explicit broad-account warning, exactly two room members, token-user mapping and latest-message since-link baseline. Browser credential extraction is **not** ported.
- [`pkg/connector/client.go`](https://github.com/beeper/chatgpt-dots/blob/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb/pkg/connector/client.go): three-second REST polling, chronology, sender mapping and request reconciliation. DSH's neutral Host owns persistence/outbox/scheduling rather than porting the Matrix bridge.
- [`pkg/chatgpt/signals.go`](https://github.com/beeper/chatgpt-dots/blob/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb/pkg/chatgpt/signals.go): inspected for room verification and real-time signals. WebSocket/presence/typing/read receipts are deliberately **not** implemented or advertised.

No Go, Matrix bridge, daemon, dependency tree, proxy rotation, browser/cookie extraction, impersonation or challenge bypass is included. This is a protocol port, not an official OpenAI SDK. Source URLs and commit are public; no private credentials or history were accessed to implement or test it.

## Deliberate differences

- Secrets are canonical credential-port references and resolve only on the Host. Unlike upstream's bridge persistence, renewal is memory-only. There is no vault/disk write callback. Reconnect resolves both original references again and may refresh again; if the provider rotated/revoked those values, the user must update their vault manually.
- All HTTP requests are fixed HTTPS `chatgpt.com` allowlisted paths. Redirects are rejected, bodies capped, cancellation/timeouts applied and errors replaced with a fixed redacted vocabulary.
- Room membership is reverified before each poll/send/reconciliation, not only once at link time. Unknown authors and identity changes are rejected.
- Poll pages and reconciliation are bounded. Each poll checks at most one additional recent 32-message page for edits/deletions and deduplicates stable IDs; the versioned opaque polling cursor carries the recent anchor. Older edits beyond that horizon may remain stale. Reconciliation starts at the original persisted since-link checkpoint passed by the neutral Host; incomplete scans return `unknown` and must not justify a duplicate send.
- Unsupported attachments/elicitation become a safe notice and fixed native ChatGPT handoff. Inline approvals and media are not capabilities.

## Updates

No runtime upstream fetches or automatic protocol updates. A maintainer must review changes against this exact pin, deliberately change the pin/source mapping, preserve the full license and attribution, update local fixtures for request/identity/auth/cursor behavior, run package test/typecheck/build/import checks, and obtain separate explicit authorization before any real-account validation. Upstream features never silently expand this adapter's advertised capabilities. Challenge or schema changes fail closed rather than starting circumvention. Distributing modified source/bundles requires following the AGPL, including applicable corresponding-source/network-use obligations; keep this package's source available with deployments.
