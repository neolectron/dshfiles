# Bots service

A normal Node.js HTTP app for provider-neutral Bots, with one engine, one durable store and provider adapters. It does not launch DSH, require a desktop helper, or create a replacement bot.

**Default: no adapters.** An explicit opt-in can now register the existing Dot factory through its public Node module. Registration exposes provider metadata, not a sample bot or authenticated account. A private read-only reference file is an operator bootstrap backend, not a completed web sign-in flow. Real account authentication and live DSH activation remain unverified; the successful Yield UI exchange is not a backend test.

The definitive product is intended to reuse the user's selected existing OpenAI login from DSH, **not require a browser-token handoff or this operator file**. That needs a purpose-bound Host-only AI Accounts capability and explicit access-only Dot authorization, neither implemented yet. Codex OAuth refresh tokens are not web session cookies; they must never be put into the session reference field. A selected-login read-only feasibility request was denied403; its cause and actual Dot authorization remain unproven. No automatic fallback to another pooled account or security workaround is part of this app.

## Build and run

Use official Node22.23.3 and the repository-pinned pnpm. Build the existing dshx/tooling prerequisites, then `@dshfiles/bots`, then this app; the root Turbo dependency graph can order those builds. From this app, `node --run build`, `node --run typecheck` and `node --run test` exercise the executable and real HTTP process lifecycle.

Run `node dist/main.js --help` for the fixed configuration contract:

- `BOTS_SERVICE_DATA_DIR`: explicit canonical absolute private directory, with an existing parent. A new/empty directory may become the dedicated service store; an unrelated nonempty directory is refused. Do not point this at a DSH home or an existing DSH store.
- `BOTS_SERVICE_TOKEN_FILE`: absolute path to a regular non-symlink service-token file owned by the service user with no group/other permissions. Supply a random32–512 character printable ASCII token, optionally followed by one newline. The value never belongs in argv, URLs or frontend code. This is a service credential, not a ChatGPT token.
- `BOTS_SERVICE_HOST`: defaults to `127.0.0.1`; `0.0.0.0` is an explicit container option.
- `BOTS_SERVICE_PORT`: defaults to8787; use0 for an ephemeral test listener.
- `BOTS_SERVICE_ADAPTERS`: empty by default, or explicit `openai-dot`. Unknown or duplicate names are refused. Concrete factories live only at this app's composition root, not in the neutral engine or UI.
- `BOTS_SERVICE_CREDENTIALS_FILE`: required when providers are selected. An explicit canonical absolute private regular file, owner-only permissions, no symlinks/hardlinks. It maps canonical `secret:ALIAS` or non-default-environment references to string values. Default `prod` keys omit `@prod`. The file is capped at256KiB,64 references,128KiB per scalar; invalid content yields fixed diagnostics without data/path echo. It is **plaintext private operator storage, not an encrypted vault or web-based onboarding**. Never put it in a build context/image or a browser field.

The app prints only a fixed readiness receipt with its non-secret listening origin and selected adapter IDs (or `none-configured`). The reference backend loads one immutable whole-map process snapshot before engine startup and rejects detected edits during reading; atomically replace the file and restart the service to load another generation. It never watches files, scans HOME, imports DSH aliases or provides credential-write authority. Dot's optional vault-management capability is absent without a writable store; explicit grant attempts are refused without disrupting a manual connection. Renewal may still occur in the session's memory, but nothing writes the reference file. SIGINT/SIGTERM stop the HTTP engine, flush/close the domain and release its exclusive owner lease. Another process cannot open the same root. A crash, replaced lease or unconfirmed cleanup retains the lease: never auto-steal it or delete storage to force startup. Operator reconciliation is required after such a failure. Private POSIX local storage is supported; this is not distributed filesystem fencing.

HTTP uses a separate bearer service credential, strict existing Bots schemas and bounded bodies/deadlines. The token grants owner-level authority. Browser Origin headers and query credentials are rejected; DSH must call it through its Host. Plain HTTP is for loopback/private container transport; use a trusted TLS reverse proxy for wider exposure. Do not publish this unaudited service directly to the Internet.

## License and source

Opt-in Dot composition links the separately licensed AGPL adapter. The combined app is AGPL-3.0-only; the earlier MIT notice is retained. See [composition notices](NOTICE.md) for provenance and corresponding-source/network-use obligations. No image publication is implied by local verification.

## Docker packaging

The Dockerfile consumes a **reviewed production-only pnpm deploy artifact for this app**, never a repository root, HOME, browser profile, credential directory or live DSH tree. The checked-in base is the official Node22.23.3 Linux-amd64 manifest pinned by digest. Images remain local unless publication is separately authorized.

From the repository after builds, deploy `@dshfiles/bots-service` into a fresh, disjoint temporary app directory using pinned pnpm's `deploy --prod --legacy --ignore-scripts`. Check that its dependency links resolve entirely inside the artifact and no private state was included. Build only that directory. Supply the token as a read-only private file and the dedicated data root as a durable volume. Never mount the Docker socket, existing browser profile or DSH home. Restrict port publishing to the intended local interface. A network-disabled, non-root, read-only-rootfs synthetic smoke is sufficient for packaging checks; it is not provider authentication.

The fork's lock currently forces Cordis4.0.4 while the installed storage packages declare `~4.0.5`. Local runtime/API tests pass with the locked identity, but this range mismatch must remain visible; it is not a newly certified upstream compatibility claim. Do not upgrade the live Host or rewrite global overrides to hide it as part of packaging.

## Verified boundaries

Tests use only synthetic values and private temporary directories. They cover normal Node readiness/HTTP authentication, revision persistence across process restart, SIGTERM lease release, refusal of missing/public/symlink token files, redacted failures and cleanup. The reusable Bots runtime tests additionally verify real JSON send tombstones/retry, owner exclusivity, malformed-state preservation and replaced-lease refusal.

The DSH Host has an explicit profile-owned service placement mode with a per-request service-credential reference. It opens no local Bots domain/workers, never falls back to local on network failure, and does not stop this app on Host disposal. The Host still needs its existing storageDomain service activated, although it does not use that service for Bots data in service mode. This is not a live settings toggle or automatic migration.

Provider references must resolve at this app's worker. The explicit read-only file supplies an initial service-side value port, but DSH vault aliases/values are not automatically copied and web-based acquisition/provisioning is still unfinished. The current Dot adapter still requires **both access and session references**; a one-time access-token-only handoff is not implemented and must not be simulated with a fake second credential. The Host-to-service credential is not a ChatGPT credential.

Not verified: a real Dot adapter session, backend renewal, browser UI in remote placement or live deployment. No real message may be sent using the already-consumed Yield UI test authorization.
