# Normal Node Bots service — verified boundary and remaining composition

## Architecture decision

Follow the user's correction: a reusable Node.js HTTP Bots service with provider adapters, deployable in Docker. Do not make the product a Dot-specific proxy appliance or require desktop automation. One engine owns workers, durable outbox, request tombstones and cursors; the DSH UI/Host must eventually become a client to that owner rather than running another engine against the same data.

## Implemented boundary

The same-package public `@dshfiles/bots/server` module now starts a real Node HTTP listener owning the existing `BotsEngine`. It receives the existing store and registry ports instead of duplicating domain logic or forwarding to a live DSH API. No provider switch is added.

- Loopback/ephemeral-port default; explicit container bind only. No TLS termination is implemented: use private transport or a trusted TLS reverse proxy for wider exposure.
- A separate deployment-supplied service bearer token, at least32 printable ASCII characters, is validated before engine construction/start. It grants owner authority and is not a provider credential or frontend secret.
- `GET /healthz` exposes liveness only. Authenticated `GET /v1/snapshot` and fixed JSON POST routes serve all nine existing Bots operations with their canonical input/output Standard Schemas.
- Reject browser Origin headers, query/absolute URLs, encoded bodies, wrong methods/media types, invalid JSON and bodies over64 KiB. A real unfinished request receives408 after the10-second application deadline. Headers/connections and outer request lifetime are bounded.
- Unexpected provider errors become fixed codes, not raw payloads. An admitted send can outlive a lost HTTP response; only an explicit retry of the original UUID is valid. No automatic resend or new request ID is introduced.
- Closing revokes the server and closes the engine/listener. The composition root remains responsible for the exclusive store/domain and registry registrations.

The public `@dshfiles/bots/node` composition and the normal [Node app](../../apps/bots-service/README.md) now reuse the existing JSON/domain backend. Explicit private roots carry a marker and a cross-process exclusive owner directory; stale/replaced ownership is never stolen automatically. The CLI reads its own private service-token file and handles SIGINT/SIGTERM. Native DSH libraries remain plugin peers; the app owns standalone dependencies. No Host guard or peer policy was disabled.

## Verified on this branch

- **107/107 Bots tests**, including eight durable-owner tests plus six real TCP/fetch tests with synthetic adapters and temporary real JSON storage. Fixtures use only bare public Cordis Context + Storage/StorageJson/StorageDomain, not a DSH app, profile, Connection, commands or tool runtime.
- HTTP tests cover auth before operations, connect/poll/incoming/messages/send, same-UUID retry through real JSON close/reopen with exactly one provider send, changed-body conflict, destructive/credential consent checks, uncertain delivery, redaction, malformed/oversized/chunked/slow bodies, invalid listen/token settings before state mutation, independent roots and shutdown.
- Strict package types, modified-source lint/AST/format and diff checks pass. Existing unrelated UI ref warnings remain warnings, not server-test failures.
- The package build emits `dist/server.js`; ordinary Node with TypeScript loading disabled imports the public subpath.
- A separate ordinary-Node built-artifact smoke (memory fixture only) starts the real listener, verifies health200/missing-auth401/authenticated empty snapshot200, then confirms idempotent close stops the listener. No DSH process or provider is started.
- Independently, bare ordinary Node + the installed public storage packages wrote a synthetic domain, disposed the Context, reopened it in a new Context and read the retained value; its positively identified temporary directory was removed. This validates the reusable storage assembly, not a finished production runner.

- Two real CLI process tests pass: restart preserves and advances the existing revision, SIGTERM releases ownership, unsafe credential files are refused with no value/path echo. Strict app types/build and TypeScript-disabled public runtime import pass.
- The production-only app artifact contains45,357 files and4,313 internal links; no escaping links or named private-state files were found. It runs outside the source checkout. The exact compiled CLI/runtime bytes still match after final source-entry/builder cleanup; the artifact is a historical smoke input, not the final release candidate.
- A pinned official Node22.23.3 Linux-amd64 image was built locally with build networking disabled. The app ran as uid1000, read-only-rootfs, all capabilities dropped and `--network none`, mounting only fresh private synthetic data and a synthetic token file. Health200, missing-auth401 and authenticated empty snapshot200 passed; a second container reopened the same volume and advanced revision. Both exited0, removed themselves, released the lease, and the synthetic token was deleted. [Private local receipt](</tmp/bots-container-proof-F8vpGq/report.json>); no real provider session or DSH home was mounted.
- The repository still locks Cordis4.0.4 while native storage declares `~4.0.5`; actual tests pass with the locked identity, but this range mismatch is disclosed, not hidden by a global upgrade. No live runtime changed.

## Not yet implemented or verified

The durable normal app and its container smoke are verified, **not a real Dot backend connection or live deployment**.

1. Finish provider composition/authentication before generating a final deployment artifact. Do not deploy the empty-adapter smoke image as a completed Dot integration.
2. Legitimate provider authentication and an intentional public adapter composition seam. The user's existing Yield is proven through normal desktop/web UI only; no session was imported into Node. The read-only token-free `/backend-api/tbo/primary` compatibility probe returned401. Do not call this proof that a properly authenticated adapter will fail, or that its protocol/schema is current.
3. A DSH Host client transport to this service, with service credentials resolved on the Host and no second local engine. Preserve the existing UI/tools and explicit operation consent.
4. Safe actual-installation promotion, user-controlled activation and real backend account/room/cursor/reconnect/renewal checks. No live profile was edited and no DSH restart occurred.

The one real test message was already sent and replied **OK** in the normal app. Its authorization is consumed; any later backend send needs fresh permission. Do not reuse it merely to make service fixtures look live.

## Resume

Address legitimate backend authentication and the DSH client next. A new explicit question asks whether to try a one-time short-lived access-token handoff directly from the existing signed-in ChatGPT page into the local backend, without token display, cookies/profile import or another send. That question is pending; do not perform the handoff until answered. A separate fresh sign-in remains the alternative, not automatic desktop automation. Keep manual UI proof, synthetic HTTP proof and real integration acceptance separate. Do not deploy the old frozen offline candidate after these source changes; generate a new one only after the chosen implementation is complete.
