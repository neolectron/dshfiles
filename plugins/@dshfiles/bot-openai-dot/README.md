# OpenAI Dot adapter (unofficial)

**Port**, not a fresh protocol implementation: pinned Beeper behavior avoids rediscovering the private protocol while staying native to the DSH Node Host (no Go or Matrix daemon). This package alone is **AGPL-3.0-only**; see [LICENSE](LICENSE) and [provenance/update policy](PROVENANCE.md).

Registers a v1 `BotAdapter` with `ctx.get('botAdapters')`; the provider-neutral Bots plugin owns UI, durable outbox, checkpoints and the three-second polling loop. This Host-only plugin adds no browser surface and performs no network requests until the user connects through Bots after accepting its explicit broad-account/unsupported-protocol warning.

## Credentials and linking

Configuration has exactly two required reference fields: `accessTokenRef` and `sessionTokenRef`, each `secret:ALIAS` or `secret:ALIAS@env`. No raw tokens, browser/cookie extraction or implicit process-environment fallback. Existing credentials must already be stored by the user through their supported vault workflow. The canonical credential-port Host resolver reads the values; clients, tools and local history receive references only.

Credentials are broad ChatGPT account authority, **not** provider-enforced Dot-only scope. This unsupported protocol can break or be denied at any time. Session renewal uses the provider session endpoint only, retains renewed values in memory and verifies unchanged account/user/mapping. Nothing writes plaintext to disk or automatically updates the vault. Reconnecting resolves the configured references again; manually update them if provider rotation makes the old session unusable. Access JWT decoding is a binding hint, **not signature validation or authorization**. Successful provider discovery plus exact two-member room verification authorizes the Dot messaging room.

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
