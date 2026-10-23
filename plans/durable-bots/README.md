# Durable Bots: end-to-end completion

The first version implements provider-neutral Bots, durable messaging and an unofficial Dot protocol adapter, but it is **not a complete live product**. The user now requires being able to chat with their existing Dot in this GUI. Passing fixtures or preparing a release is not acceptance. Current behavior and limits remain documented in the [guide](../../docs/bots.md), [Bots README](../../plugins/@dshfiles/bots/README.md) and [Dot README](../../plugins/@dshfiles/bot-openai-dot/README.md).

## Completion criterion

In the actual GUI: link the user's genuine existing Dot with explicit authorization, send one approved message, display its genuine reply and an incoming native-origin message, reconnect without duplicates or identity changes, and verify usable credential renewal/re-authorization. No replacement model/bot, Codex relay, invented provider access or claimed native feature parity.

## Progress

| Work | Status | Evidence / next action |
| --- | --- | --- |
| Existing implementation and scratch checks | Complete as local proof only | 64 Bots tests, 57 Dot tests, focused SDK tests and four scratch browser journeys. No real-account proof. |
| Audit actual installation | Complete | GUI :3198 serves the customized, unversioned Manuel export, not the feature branch. Neither Git nor JJ metadata exists there. Its HMR, agent plugin-manager and profile-sync path are intentionally disabled. Do not merge/rebase/checkout-sync it or apply a broad web seed. |
| Compatible offline release | Prepared, not deployed | `.local/bots-release-staging/` contains freshly built two bundles and a single stylesheet from serving-source union plus Bots: 1,774 existing selectors retained, 14 added, no missing selectors. Stock Cordis 4.0.5 imports and one canonical public adapter/error class verified. Local linked candidate, not a portable archive; retain its recorded dependency targets. |
| Finished sign-in onboarding | Pending user interaction-mode choice, then implementation | Current adapter only accepts two pre-provisioned global vault references. It has no automatic sign-in/import flow. Host has no DISPLAY/WAYLAND_DISPLAY/XDG_RUNTIME_DIR, so do not promise a visible Host-side browser. User is asked whether a helper on their actual desktop is acceptable or a browser-only experience is required. No existing browser/profile/cookie inspection. |
| Consistent credential lifecycle | Needs owned design/implementation | Catalog scalar writes are supported through an in-process Host API after correctly exporting its existing contract with explicit owner, or a narrower writer port. No pair transaction/CAS/rollback exists. Do not disguise two writes as atomic. Design immutable generations with atomic reference publication, or a single validated credential bundle, plus honest orphan/cleanup and re-authorization behavior. Never put values in Bots storage, browser storage, chat, tools or diagnostics. |
| Account authorization | Waiting for user's explicit risk decision | Private session pair grants broad ChatGPT-account access, not a Dot-only scope; all authenticated DSH browsers share authority. Pending question also requests one exact harmless test message. No consent inferred from a timeout. No account or vault access yet. |
| Actual installation | Pending user-controlled maintenance window | With the user stopping the runtime, preserve rollback copies/checksums, add only the two local bundle links/names, install with exact pnpm 12.5.1, and replace only the staged sheet in the existing owner path. Retain all current links/customizations/shared-runtime and disabled account seeding. User starts the same existing launcher and reloads :3198. Agent never restarts/kills the running DSH. |
| Real Dot verification | Pending consent, usable sign-in and activation | Verify account/room/Dot identity; requested send/reply; unsolicited incoming message; reconnect/checkpoint/no duplicates; renewal or explicit re-authorization; 403/challenge/rate-limit/unknown delivery fail safely. Do not mark the project complete without these real checks. |

**Resume here:** Wait for the two pending user choices (account access/test authorization and desktop-helper versus web-only sign-in) before choosing/acquiring credentials. The offline deployment candidate is prepared; do not rebuild/recreate it without reason. Review its deployment/rollback manifest before any maintenance action, and recheck baseline hashes for concurrent edits. Finish the chosen onboarding/lifecycle implementation and verify it before asking the user to activate a candidate containing it.

## Verified constraints

- Official Sign in with ChatGPT exists, but its identity/Responses scopes explicitly do **not** grant ChatGPT conversation access. It is not a drop-in credential source for this private Dot protocol. [OpenAI scope limits](https://developers.openai.com/siwc/quickstart.md).
- Beeper's upstream login transfers a fresh session pair after user sign-in; manual clipboard copying of session tokens is not inherently required. That acquisition flow was **not** ported into version one. [Pinned authentication source](https://github.com/beeper/chatgpt-dots/blob/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb/pkg/connector/login.go).
- A user-run desktop helper is only viable after confirming it and the Host share the actual same global vault/config context. Same alias names on another machine do not establish that. Host global Bots cannot resolve project-local aliases.
- The provider protocol is experimental and unsupported. An eligible existing primary Dot, provider availability and successful authenticated replies cannot be inferred from fixtures. Stop on access denial/challenges; no impersonation, proxy rotation or security bypass.
- A restart is operationally unavoidable under this installation's current disabled-HMR policy. Preparing files is not activation, selector retention is not computed-style/browser proof, and a local linked candidate is not a standalone release.

Grok/self-hosted adapters, full pre-link history, inline approvals/media/computer control, WebSocket presence and per-human isolation remain separate scope. First complete real text chat; do not advertise capabilities that are absent. Keep this plan open until the real completion criterion is verified, then follow `complete-plan`.
