# Durable Bots plan

## Context

The user wants first-class functional and visual integration with existing long-lived agents, independent of provider. Existing Agents are saved DSH thread-launch configurations, not remote durable identities. The first real adapter is OpenAI Dot; no Grok or self-hosted implementation is in scope yet. DSH 0.2.1-rc.2 supports a global `main` panel plus additive sidebar navigation and Host-owned persistence. The running instance is profile `manuel` at :3198 and must not be changed or restarted. This checkout is Git-only; work is isolated in the `feature/durable-bots` Git worktree.

## Goal

Connect an existing Dot to a provider-neutral Bots roster and conversation UI, preserving the remote identity and safely handling unsolicited messages, reconnects, durable sends and explicit account consent.

## What / Why

Provide one Bots workspace, a versioned adapter registry, durable Host service, common UI and agent tools. Dot's private messaging protocol is isolated in its own adapter. Connecting a bot must not create a replacement model, native DSH Session or Codex task. Other adapters must plug in without branching the core UI.

## How

### Conceptual model

A connection binds an adapter/account configuration to remote bot identities. A bot owns provider conversations and normalized incoming/outgoing messages. Connection health is separate from activity. Disconnecting stops local synchronization, not the remote bot. Removing local data never deletes the remote bot or vault credentials.

### Architecture

```text
Bots sidebar + conversation UI -> typed Bots API -> durable Host service
                                                   -> versioned adapter registry
                                                        -> OpenAI Dot adapter
                                                             -> existing remote Dot
```

### Tech choices

| Choice | Decision | Rationale |
| --- | --- | --- |
| Ownership | New `@dshfiles/bots` + `@dshfiles/bot-openai-dot` | Do not change Agents/model/session semantics. |
| Reuse | Port pinned Beeper protocol behavior, preserve AGPL provenance | Avoid rediscovery and a full Matrix stack. A small TypeScript Host adapter fits the installed Node runtime; Go is unavailable. |
| Persistence | Supported storageDomain, serialized durable writes | Persist send intent before external effects and advance cursors only after messages. |
| Updates | Host-owned bounded polling; UI query snapshots | Works without a mounted panel; no fake stream or always-running browser promise. |
| Credentials | Secret references resolved on Host only | Never accept raw tokens in UI, settings, tools or logs. No automatic browser/cookie extraction. |
| UI state | Query + Form + explicit lifecycle state | No browser-owned connection loop or duplicated transcript authority. |

### Operations / behavior

Discover registered adapters; connect after risk consent; list bots; read conversation; send/reconcile a stable request; mark local messages read; reconnect/disconnect; explicitly remove local connection data. Unsupported provider content is a safe native handoff, not dropped or executed. Adapter capabilities must be honest: initial implementation is durable text messaging, with unsupported rich content linked to the original application.

## What this allows

- The same existing Dot, not a clone.
- Provider-neutral roster, normalized conversation and delivery states.
- Proactive message polling and reconnect recovery while the Host runs.
- Independent minimal test adapter to prove substitution.

## What this does not allow

- No Grok implementation, remote agent provisioning or universal model/memory editing.
- No claim of official OpenAI API support, full pre-link history import or authenticated validation without the user's separate account-linking action.
- No automatic approvals, browser-session extraction, challenge bypass or proxy rotation.
- No per-human isolation: all admitted browsers share DSH's owner authority. No shared-user deployment endorsement.
- Host shutdown stops synchronization; the remote Dot can still run. No separate OS daemon in this milestone.

## UI & UX

### Desktop

A Bots roster beside a conversation, with provider identity, unread counts, honest connection status, last sync and a secondary details/connect pane. The composer has explicit send/retry state and no model picker. Risk disclosure precedes connecting; credentials are reference-only fields with the vault picker binding. Disconnected text drafts survive bot navigation; no silent send or retry.

### Mobile

Roster and conversation are separate narrow-pane views with Back navigation; no fixed desktop-width columns. Keyboard access, accessible labels and semantic DSH colors are required.

### Common interactions

| Action | Result |
| --- | --- |
| Connect | Adapter validates references and discovers exact remote identity; explicit risk acceptance required. |
| Send | Durable request intent then provider send; confirmed/failed/uncertain state shown truthfully. |
| Reconnect | Same verified identity, cursor replay and no blind duplicate sends. |
| Disconnect | Stop local synchronization; keep local history; remote work is unaffected. |
| Remove | Explicit confirmation removes local connection/history only. |

## Data model

Host storage owns connection references, verified bot identity, per-conversation cursor, local message IDs and remote IDs, pending request IDs/body fingerprints, unread boundaries and sanitized health. Provider credentials and raw provider payloads do not enter that store. A provider's remote conversation remains canonical; DSH owns a bounded local projection and outbox.

## Implementation steps / progress

| Milestone | Status | Evidence |
| --- | --- | --- |
| Plan, schemas and adapter contract | In progress | Isolated worktree; supported contracts inspected. |
| Durable Bots Host/store and substitution tests | Pending | |
| Dot adapter with protocol/security fixtures | Pending | |
| Roster, connection form and conversation | Pending | |
| Build/import/contract and scratch browser proof | Pending | |
| Documentation, deployment and completion review | Pending | |

**Resume here:** Define the shared v1 schemas and adapter contract; delegate non-overlapping Host, UI and Dot implementation. Dependency setup is running as job `bash-be8bebdbe30748cc`.

## Open questions / proof gates

- Personal primary Dot compatibility is source-backed; user's account/workspace compatibility is unverified.
- Connecting requires existing renewable session credentials stored through the user's vault; secure browser-assisted linking is not silently assumed.
- OpenAI can reject this unofficial protocol. Fail safely on access denial/challenges; do not bypass them.
- Rich task/approval/media interactions are not advertised unless implemented and tested.

## Acceptance criteria

- [ ] Generic adapter registration/substitution and unsupported capability tests.
- [ ] Durable send/replay/restart, identity binding, cancellation and failure tests.
- [ ] Dot fixture tests cover discovery/send/pagination/auth failures and credential redaction.
- [ ] Read/write tools share the UI API and destructive actions require explicit confirmation.
- [ ] Global Bots UI works without a native Session and on narrow panes.
- [ ] Unit/typecheck/build/import and scratch end-to-end journey pass; screenshot is kept with the UI plugin.
- [ ] No raw credentials in UI/storage/logs; no live instance changes.
- [ ] Unverified real-account behavior is stated explicitly.

## Decisions log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-10-23 | Provider-neutral Bots, Dot adapter only | Direct user requirement; avoid provider-shaped product. |
| 2026-10-23 | Port protocol to a separately licensed Host adapter | Node is installed, Go is not; avoid unnecessary Matrix/daemon infrastructure. |
| 2026-10-23 | Vault-reference linking first, no automated credential acquisition | Broad ChatGPT credentials require explicit consent and must not cross the client boundary. |
