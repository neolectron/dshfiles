# OpenAI Dot adapter (unofficial)

**Port**, not a fresh protocol implementation: pinned Beeper behavior avoids rediscovering the private protocol while staying native to the DSH Node Host (no Go or Matrix daemon). This package alone is **AGPL-3.0-only**; see [LICENSE](LICENSE) and [provenance/update policy](PROVENANCE.md).

Registers a v1 `BotAdapter` with `ctx.get('botAdapters')`; the provider-neutral Bots plugin owns UI, durable outbox, checkpoints and the three-second polling loop. This Host-only plugin adds no browser surface and performs no network requests until the user connects through Bots after accepting its explicit broad-account/unsupported-protocol warning.

## Credentials and linking

Configuration has exactly two required reference fields: `accessTokenRef` and `sessionTokenRef`, each `secret:ALIAS` or `secret:ALIAS@env`. No raw tokens, browser/cookie extraction or implicit process-environment fallback. Existing credentials must already be stored by the user through their supported vault workflow. The canonical credential-port Host resolver reads the values; clients, tools and local history receive references only.

Credentials are broad ChatGPT account authority, **not** provider-enforced Dot-only scope. This unsupported protocol can break or be denied at any time. Access JWT decoding is a binding hint, **not signature validation or authorization**. Successful provider discovery plus exact two-member room verification authorizes the Dot messaging room.

### Optional managed renewal (default off)

Without Core's separate explicit credential-management grant and post-verification `bindCredentialReferences` call, renewal remains memory-only: **zero vault writes**, even if the Host store is available. Reconnecting resolves the original references again; manual reauthorization may be necessary. Discovery can renew in memory, but cannot publish or persist credentials before Core verifies and durably saves identity.

With the additional grant, legacy two-reference configuration migrates to **one fresh, uniquely named global scalar vault item** (`DSH_DOT_<random UUID>`). Its provider-owned JSON bundle contains a format version, owner connection ID, its own canonical `reference` (chosen before creation), opaque generation UUID, the complete access/session pair and account binding. One Core compare-and-replace publishes both reference fields pointing to that same alias; raw bundle/token values never enter Core, the browser, tools, logs or the Bots store. Original user aliases are never overwritten, renamed or deleted. A failed or ambiguous creation/publication stops the session, retains the old configuration unless publication was actually accepted, and safely reports that a potentially unlinked bundle may remain; no destructive cleanup or claimed rollback.

Different canonical references retain legacy two-scalar resolution. Equal canonical references are read **once**: a recognized JSON bundle must validate its version, owner connection ID and account binding (and requires Core's connection ID); malformed/object-like bundles fail closed. Historical equal-reference scalars remain compatible and use their one resolved scalar for both fields. Bundle account binding is checked against both decoded access-token hints and the subsequently verified room/account identity.

Renewals replace the **same whole scalar bundle**, not two independent vault items. Reconnect reuses that bundle; it does not create another item. Session operations, bind and persistence serialize; refresh is singleflight. Managed bind/updates require the generated provider alias pattern plus format, owner, account and exact self-reference binding; a valid bundle copied under another alias is never updated. These are accidental-provenance safeguards, not cryptographic ownership proof. Owned updates verify the previous owner/generation before writing and read back the exact next bundle, preserving its self-reference. An update with a lost acknowledgment proceeds only if guarded readback establishes the exact next value. Any unresolved persistence failure stops the operation before further messaging; it never blindly repeats a POST or refresh. Stable message UUID idempotency is unchanged.

**Limits:** pre-read/generation verification and readback are **not backend CAS**, a vault transaction, or cross-host exclusion. Concurrent/cross-host sharing of a managed bundle is unsupported. The provider refresh and local vault commit have a crash window; provider rotation followed by process failure can require reauthorization. Grant revocation/cancellation prevents **new** work but cannot undo an in-flight Catalog call already accepted by its backend; acknowledged writes/publication are never presented as rolled back. No auto-delete is implemented. Explicit user reauthorization remains the recovery path.

The Host composition uses the public `@dshfiles/secret-catalog/api` contract through `createHostApiClient` for scalar create/update only (Catalog transports values on stdin). Reads exclusively use `SecretReferenceResolver`/`secretCatalogValues`, never reveal RPC/tool calls. `DotCredentialStore` is injected at the adapter factory; tests substitute in-memory fakes.

The adapter links only the existing primary Dot. A stable latest-message baseline is required; no old transcript is imported. The Host must retain that original baseline/cursor and account/bot/conversation identity on reconnect. Shutdown/disconnect stops local synchronization, not the remote Dot.

## Behavior and limits

- Verified one-to-one `DM`, exact `chatgpt:messaging`, selected Dot and human account-user binding.
- Text sends use the same stable UUID for `request_id` and `idempotency_token`. Unknown delivery is never silently retried with a new ID.
- GET pages contain at most 32 messages. Non-advancing/invalid pagination retains the checkpoint. Reconciliation scans at most 16 pages from the original since-link baseline and returns `unknown` if incomplete.
- User and Dot authors remain distinct; unknown authors are rejected. Room membership is reverified before I/O.
- Attachments/approvals render a safe notice and native ChatGPT handoff; no media download, inline approval, typing, activity or WebSocket capability is advertised. Each poll also rechecks at most one recent 32-message page for edited/deleted messages; stable IDs are deduplicated with fresh results (at most 64 messages). The opaque versioned cursor owns the recent anchor, latest chronology and a bounded checkpoint-cycle guard. Older edits outside that bounded horizon can remain stale; no full historical parity is claimed.
- Fixed `https://chatgpt.com` paths, redirects denied, 15-second per-request timeout, 4 MiB message response cap (64 KiB renewal), zod boundary decoding. 403/challenges stop safely; no bypass, impersonation or proxy rotation.

## Verification

`pnpm --dir plugins/@dshfiles/bot-openai-dot typecheck`, `test`, and `build`. Tests inject a scripted HTTP boundary and synthetic credentials only; **no real account, authenticated network call or private history** is needed. Public source retrieval is the only research network activity.

Build keeps the public `@dshfiles/bots/adapter` import external and bundles credential-port into the Host. The parent package supplies source types and its built runtime module. No root manifest, lockfile, core patch, live profile or service changes belong to this package. Real-provider compatibility and scratch runtime activation remain separate parent-owned proof gates; this package does not claim account verification from fixtures.
