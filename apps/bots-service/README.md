# Bots service

A normal Node.js HTTP app for provider-neutral Bots, with one engine, one durable store and provider adapters. It does not launch DSH, require a desktop helper, or create a replacement bot.

**Current runner has no provider adapters configured.** It exposes an honestly empty roster. Real Dot authentication and the DSH client connection are not finished; the successful Yield UI exchange is not a backend test.

## Build and run

Use official Node22.23.3 and the repository-pinned pnpm. Build the existing dshx/tooling prerequisites, then `@dshfiles/bots`, then this app; the root Turbo dependency graph can order those builds. From this app, `node --run build`, `node --run typecheck` and `node --run test` exercise the executable and real HTTP process lifecycle.

Run `node dist/main.js --help` for the fixed configuration contract:

- `BOTS_SERVICE_DATA_DIR`: explicit canonical absolute private directory, with an existing parent. A new/empty directory may become the dedicated service store; an unrelated nonempty directory is refused. Do not point this at a DSH home or an existing DSH store.
- `BOTS_SERVICE_TOKEN_FILE`: absolute path to a regular non-symlink service-token file owned by the service user with no group/other permissions. Supply a random32–512 character printable ASCII token, optionally followed by one newline. The value never belongs in argv, URLs or frontend code. This is a service credential, not a ChatGPT token.
- `BOTS_SERVICE_HOST`: defaults to `127.0.0.1`; `0.0.0.0` is an explicit container option.
- `BOTS_SERVICE_PORT`: defaults to8787; use0 for an ephemeral test listener.

The app prints only a fixed readiness receipt with its non-secret listening origin and `adapters: none-configured`. SIGINT/SIGTERM stop the HTTP engine, flush/close the domain and release its exclusive owner lease. Another process cannot open the same root. A crash, replaced lease or unconfirmed cleanup retains the lease: never auto-steal it or delete storage to force startup. Operator reconciliation is required after such a failure. Private POSIX local storage is supported; this is not distributed filesystem fencing.

HTTP uses a separate bearer service credential, strict existing Bots schemas and bounded bodies/deadlines. The token grants owner-level authority. Browser Origin headers and query credentials are rejected; DSH must call it through its Host. Plain HTTP is for loopback/private container transport; use a trusted TLS reverse proxy for wider exposure. Do not publish this unaudited service directly to the Internet.

## Docker packaging

The Dockerfile consumes a **reviewed production-only pnpm deploy artifact for this app**, never a repository root, HOME, browser profile, credential directory or live DSH tree. The checked-in base is the official Node22.23.3 Linux-amd64 manifest pinned by digest. Images remain local unless publication is separately authorized.

From the repository after builds, deploy `@dshfiles/bots-service` into a fresh, disjoint temporary app directory using pinned pnpm's `deploy --prod --legacy --ignore-scripts`. Check that its dependency links resolve entirely inside the artifact and no private state was included. Build only that directory. Supply the token as a read-only private file and the dedicated data root as a durable volume. Never mount the Docker socket, existing browser profile or DSH home. Restrict port publishing to the intended local interface. A network-disabled, non-root, read-only-rootfs synthetic smoke is sufficient for packaging checks; it is not provider authentication.

The fork's lock currently forces Cordis4.0.4 while the installed storage packages declare `~4.0.5`. Local runtime/API tests pass with the locked identity, but this range mismatch must remain visible; it is not a newly certified upstream compatibility claim. Do not upgrade the live Host or rewrite global overrides to hide it as part of packaging.

## Verified boundaries

Tests use only synthetic values and private temporary directories. They cover normal Node readiness/HTTP authentication, revision persistence across process restart, SIGTERM lease release, refusal of missing/public/symlink token files, redacted failures and cleanup. The reusable Bots runtime tests additionally verify real JSON send tombstones/retry, owner exclusivity, malformed-state preservation and replaced-lease refusal.

Not verified: a real Dot adapter session, backend renewal, DSH remote-client wiring or live deployment. No real message may be sent using the already-consumed Yield UI test authorization.
