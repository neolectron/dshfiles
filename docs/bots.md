# Durable Bots integration

The Bots workspace connects **existing remote identities** without turning them into DSH model routes, prompt presets, ordinary Sessions or internal Agent mailboxes. The current first provider is the unofficial OpenAI Dot adapter. Other providers are extension points, not shipped implementations.

## Ownership and extension boundary

```text
sidebar.panellist + global main panel
                  |
         @dshfiles/bots typed API + tools
                  |
    Host-owned durable projection / outbox / cursor
                  |
        versioned BotAdapter registry
                  |
       @dshfiles/bot-openai-dot (AGPL-3.0-only)
                  |
        existing remote ChatGPT Dot
```

The shared feature is [Bots](../plugins/@dshfiles/bots/README.md). Providers implement its [public adapter module](../plugins/@dshfiles/bots/src/adapter.ts), register through the supported Cordis service, and declare their connection fields and risks. The contract is declared in `dshx.config.ts` and has a built JavaScript export; consumers never import another plugin's private source or execute raw TypeScript exports.

The Host owns one cancellable worker per active connection. React owns rendering and local input; Query owns remote reads. Closing the panel does not stop synchronization. Closing DSH does; there is no separately managed daemon in this version. A remote bot can continue working independently while DSH is offline.

Bot identity is account/provider-bound and distinct from its display name. Reconnect must preserve the account, bot, conversation and original link boundary. Duplicate links to the same verified remote bot are rejected. Disconnect stops local sync only; explicit local removal does not delete a remote bot or vault credentials.

## Durable messaging

Send intent is persisted before the provider is called. The client chooses one UUID and an explicit retry reuses that original request and body. A lost response is uncertain delivery, not success or proof of failure. Reconciliation must establish the old request's outcome before another send; unknown is never silently resent. A Host restart turns interrupted sending into uncertainty, not automatic replay.

Receive batches, deduplication and cursors are committed together. Unread boundaries use durable local sequence, not wall-clock time. Old settled messages form a bounded local projection; unresolved intents are never silently evicted. Outgoing request tombstones preserve destination and original body fingerprints after projection pruning. See the package documentation for current bounds and exhaustion behavior.

The provider conversation remains canonical. Since-link cache is not a claim to import the old transcript or copy the provider's memory into DSH. Native message text can be updated/deleted independently of the immutable outgoing request fingerprint.

## Security and account linking

- Credential fields are canonical `secret:ALIAS`/`secret:ALIAS@env` references, resolved on the Host by credential-port. No raw credential fields, browser storage, log payload tracing or automatic browser-profile extraction.
- An adapter's risks must be explicitly accepted. Dot credentials are broad ChatGPT authority, **not a provider-enforced Dot-only grant**.
- The Dot adapter does not implement standard Sign in with ChatGPT: [its public scopes do not grant conversation access](https://developers.openai.com/siwc/quickstart.md). Credentials currently must already be stored through the user's vault workflow. Secure user-assisted sign-in/provisioning is unfinished end-to-end work, tracked in the plan; a reference-only form is not a finished sign-in experience.
- Dot refresh remains memory-only; it does not overwrite the user's vault. Invalid or rotated references require the user to update the vault.
- Public APIs/tools expose sanitized connection state; reading private conversation text is a separate user-authorized operation. Sending DSH context externally is never automatic.
- Every authenticated browser shares DSH's owner principal. This is **single-owner integration**, not per-human/tenant isolation. Do not expose a personal Dot to a shared-user instance under a false isolation promise.
- Native links are validated, credential-free HTTPS links. Messages render as safe text, not raw HTML. Unknown provider content is a notice/native handoff, never executable UI or automatic approval.

## Dot implementation and limits

The adapter is a **port** of pinned [Beeper chatgpt-dots](https://github.com/beeper/chatgpt-dots/tree/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb), not an official OpenAI API. [Provenance and update policy](../plugins/@dshfiles/bot-openai-dot/PROVENANCE.md) and the full AGPL license are preserved. The TypeScript Host port avoids adding Go, Matrix, proxy rotation or a second agent runtime. Process/package separation is not a claim that AGPL obligations disappear.

Initial scope is text messaging, provider conversation selection, incoming polling, recent message edits/deletions, reconnect recovery and explicit native handoff. Media transfer, inline approvals, voice, computer controls, full pre-link history, typing/read-receipt mirroring and WebSocket presence are not advertised. Older edits outside the recent recheck window can remain stale. A failed challenge or unsupported schema stops safely; no circumvention is attempted.

## Installation and deployment

Use [profile installs](profile-installs.md), not `pnpm add <path>`. Both `@dshfiles/bots` and `@dshfiles/bot-openai-dot` must be built and composed, with the shared UI runtime/styles. The adapter requires the Bots registry; credentials require Secret Catalog at connect time. A fresh install with no enabled connections performs no Dot authentication or discovery network request. Previously accepted, enabled connections resume their Host workers after restart or adapter reactivation; disconnect first to prevent that synchronization.

The checked-in web seed includes both bundles after isolated verification; with no stored enabled connection, activating them does not read credentials or contact ChatGPT. Source changes are not a deployment: the selected profile must be reconciled from the checkout the user chooses. Implementation and scratch checks do not install into, rebuild, restart or validate a different running GUI. Promotion/install and the user's restart decision remain distinct from source implementation.

## Validation boundaries

The [Bots feature catalog](../plugins/@dshfiles/bots/dshx.features.json) and [journeys](../tooling/dshx/e2e/features/bots.feature) exercise the real Host/API/browser with a scratch-only synthetic adapter. Dot protocol fixtures use synthetic credentials and scripted HTTP responses, including failure and identity cases; they do not authenticate a real account.

Real account/workspace compatibility remains unverified until the user explicitly links their own Dot. No fixture test proves that OpenAI currently accepts this private protocol for that account. The [end-to-end completion plan](../plans/durable-bots/README.md) stays open for secure onboarding and credential lifecycle, safe deployment into the actual installation, and authorized real-account proof. Version one is a fixture-verified foundation, not a completed live Dot integration.

### Focused verification

From the repository root with the pinned official Node and stock `dsh` on PATH:

```sh
pnpm --dir plugins/@dshfiles/bots test
pnpm --dir plugins/@dshfiles/bots typecheck
pnpm --dir plugins/@dshfiles/bot-openai-dot test
pnpm --dir plugins/@dshfiles/bot-openai-dot typecheck
pnpm check:e2e bots bot-openai-dot
node --run check:screenshots
node --run verify:web-profile-contract
```

On NixOS, pinned Playwright headless build 1194 could not load `libglib-2.0.so.0`. The verified alternative is an explicit system Chrome executable, never the user's browser profile:

```sh
DSHX_E2E_CHROMIUM_EXECUTABLE=/etc/profiles/per-user/neolectron/bin/google-chrome \
  DSHX_E2E_SCENARIO_CACHE=0 pnpm check:e2e bots bot-openai-dot
```

This verified **Chrome 155.0.8059.79**, not the pinned Playwright browser. Its absolute path and bounded `--version` evidence participate in the task and scenario cache keys. Default browser selection is unchanged when the override is absent.

| Boundary | Verified result |
| --- | --- |
| Bots unit/real DOM/real Cordis+JSON storage | 64 tests; strict types; durable restart, outbox, cancellation, projection/edit/replay and UI flows |
| Dot protocol/security/real Cordis credential port | 57 tests; strict types; synthetic credentials only, no authenticated HTTP |
| SDK boundaries | 33 focused tests: existing typed API, mandatory-schema JSON/redaction, Host+Client public facade compilation and explicit browser selection; six scenario-cache tests |
| Browser | Three Bots journeys plus the Dot adapter registration/reference-consent journey, executed fresh with no scenario replay |
| Catalog reaches | `bots/bots-workspace` and `bots/connect-bot` walked through `dshx dev`; 170 active entries, four bundles loaded, no Host errors |
| Captures | Both catalog reaches: zero console/page/request/HTTP errors and zero warnings; committed screenshots contain no private account data |
| Public modules | Both built Host entries and the public adapter/API modules import under the pinned Node |
| Generated/configuration | Browser-task generation is idempotent; screenshot gate, frozen offline lockfile, scripts types and web-profile dependency closure pass |

`dshx dev down` stops the owned scratch Host/browser/watchdog and deletes its token-bearing state, retaining only evidence. No live process or profile is changed. The source checkout's original uncommitted files are preserved.

### Wider checks are not a green release claim

The unchanged source baseline has **60 feature-catalog issues** and **three workspace-contract findings** (subprocess-local's tsconfig base and two session-controller dependency ranges). Current catalog comparison adds **zero** issues. The root Oxlint ratchet also already fails on **500 conditional-empty-object-spread findings against a cap of 494**; comparison with the untouched base confirms that count is unchanged. The feature does not raise ratchet caps or suppress those unrelated owners. The shared DialogOverlay emits an existing React ref warning in JSDOM tests; it is not hidden, and the real scratch captures report no browser warnings.

Full web-profile activation, live-GUI behavior, a real account's private protocol, approvals/media/computer-control parity and performance of the running user instance are **not verified** by these scoped checks.
