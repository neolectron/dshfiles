# Durable Bots: remaining promotion gates

The provider-neutral Bots workspace, durable Host service, public v1 adapter contract and first unofficial OpenAI Dot adapter are implemented in the isolated `feature/durable-bots` Git worktree. Finished behavior, decisions, limits and verification receipts live in the [architecture/deployment guide](../../docs/bots.md), [Bots README](../../plugins/@dshfiles/bots/README.md) and [Dot README](../../plugins/@dshfiles/bot-openai-dot/README.md). This plan stays open because the work is not yet integrated into the owning checkout or activated in the user's running GUI, and no real Dot account has been authenticated. The original checkout's uncommitted work and the live instance are untouched.

## Open work

| Gate | Status | Required action |
| --- | --- | --- |
| Review and integrate source | Pending explicit promotion | Review the feature branch, preserve the original checkout's existing edits, and integrate into the chosen owning checkout. The source repository was Git-only; do not invent a JJ revision or assume a JJ workspace exists. |
| Activate in the selected profile | Pending user deployment choice | Confirm which checkout serves the GUI, reconcile the two bundles with the supported profile workflow, and let the user choose when to restart. The checked-in web seed is ready; it is not a claim that the current live profile changed. |
| Real account smoke check | Pending explicit account linking | The user stores/chooses existing renewable access/session credential references, reads and accepts broad ChatGPT-account authority, then connects their existing primary Dot. Verify account/room binding, one requested send/reply and a reconnect. Never extract a browser session, echo values, bypass challenges or silently resend uncertain delivery. |

**Resume here:** Review the completed implementation and focused receipts in the linked docs. Do not repeat fixture implementation or restart the live GUI. Source tests and a synthetic provider prove the integration boundaries, not OpenAI's current acceptance of this private protocol for the user's account/workspace.

## Not part of this release

Grok/self-hosted adapters, browser-assisted credential acquisition, full pre-link history, inline approvals, media/computer control, WebSocket presence and per-human isolation need separate scoped work. V1 text/read-only capability limits are explicit; unsupported content hands off to native ChatGPT. Synchronization runs while the DSH Host runs, not as a separately managed OS daemon.

When the promotion gates are resolved, use `complete-plan`: preserve the durable guide and receipts, remove this plan and its index row, and fix links. Until then, do not report that the live Dot is linked.
