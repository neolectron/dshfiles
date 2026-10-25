# BDots: useful patterns, without replacing an existing Dot

Reviewed at [`ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b`](https://github.com/fayazara/bdots/tree/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b), following the user's reference. Public source was read directly; no clone, package installation, Cloudflare account or deployment was needed. Its root [agent notes](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/AGENTS.md) describe its architecture; those are reference evidence, not instructions for DSH.

## Scope difference

BDots creates its **own** durable agents, with their own model, memory, routines, workspace and browser. Its model path uses Workers AI/AI Gateway. Our goal is to connect the user's **existing remote bot and chat**, starting with ChatGPT Dot, without replacing its identity/memory with a new model loop. We therefore extend the existing Bots owner rather than adopt BDots as the backend. This decision is based on its [UserHub bot creation](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/src/agents/user-hub.ts), [BotAgent model/runtime](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/src/agents/bot-agent.ts) and [deployment bindings](https://github.com/fayazara/bdots/blob/ce94160cd9cf1544f1ab5ddcdfec4006eb151a7b/cloudflare.config.ts).

## Learning translated into implementation

**A failed action must update the connection owner, not just the message bubble.**

BDots' `UserHub.callAppTool` records the latest failure centrally and tells callers not to retry an authentication failure until reconnection. Its `BotAgent.repairInterruptedToolPart` separately distinguishes safe reads from ambiguous side effects. Those are useful behavioral ideas; no source code or Cloudflare dependency is copied.

Our polling path already published connection failures and retired terminal workers. The send path only marked its outgoing message failed/uncertain, while reconciliation swallowed typed authorization errors into unknown delivery. That left a stale **Connected** state and admitted another call until polling noticed the failure.

The implementation closes that gap at the existing neutral `BotsEngine` owner:

- Publish terminal typed authentication/access/identity/protocol failures promptly; access denial is not relabeled as an expired OAuth login.
- Retire only the worker that failed, with generation checks so an old completion cannot stop a newly reconnected worker.
- Preserve failed versus uncertain delivery and an already-confirmed echo. Reconnect/reconciliation use the original UUID; no automatic resend, reauthorization or fresh POST is introduced.
- Keep transient/rate-limited failures separate. The UI, API and service all read the same durable owner state; no OpenAI-specific Core branch or second state owner is added.

**Implemented and verified:**16 new cases in the [owning engine tests](<../src/engine.test.ts>) reproduce terminal send/reconcile failures, preserve confirmed echoes/unknown delivery, require explicit reconnect and fence stale-generation plus queued-poll races. Engine47/47 and full Bots141/141 pass; strict typecheck/build/Host import and scoped static checks pass. The rebuilt normal Node app also passes9/9 tests, and the provider290/290. Existing unrelated workspace-contract failures remain outside this patch. This fixes reliability/state reporting, not the provider's network authorization.

## Actual GUI regression

A synthetic adapter now exercises the complete connect → one Send → terminal refusal → explicit Reconnect path in the real scratch DSH GUI. Public native API/storage observations prove one retained failed message with its original UUID, one provider POST and no provider calls/polls after retirement for more than two polling intervals. Reconnect resumes normal reads but never resends the failed intent; the original retry remains an explicit action.

The first reviewed screenshot also exposed a presentation bug: delivery failures used the same optional original-app helper text as unsupported provider content. A one-condition rendering fix removes that unrelated hint for failed/uncertain sends. Three DOM regressions retain the real error/retry control and the original fallback for received unsupported content. No state, API, styles or provider behavior changes.

[Reviewed synthetic failure state](<screenshots/bots-terminal-failure.png>). This is a fixture, not successful OpenAI authorization or a real delivered message. The terminal journey asserts read-only/disabled-send state, no misleading helper text, retained failure and clean native teardown. The focused journey and the complete owner gate both pass after the display fix: **6actual browser scenarios,0failed/0skipped**, scenario replay disabled, official Node22.23.3 and system Chrome155.0.8059.79. Each owned scratch root and its exact Host PID disappear after teardown. Optional explicit retry itself is not exercised by this GUI journey; original-UUID reconciliation remains covered by the engine tests. Broader catalog hygiene retains60 unrelated baseline findings; it is not represented as globally clean.

## Patterns already present — not rebuilt

| BDots idea | Existing Bots ownership |
| --- | --- |
| One user-level credential/connection owner | AI Accounts capability and separately authenticated private backend channel; no values in Client/tool/history |
| Durable identity and transcript | One Node engine/store, atomic message/cursor changes, stable IDs |
| Safe interrupted-write recovery | Sending becomes uncertain after crash; original-UUID reconciliation and durable send tombstones prevent blind replay |
| Honest live status | Connection health is separate from remote bot activity; unknown activity is not guessed idle/working |
| Separate UI projection | Bounded cache, per-conversation drafts, abortable queries, scroll-follow controls |

BDots' WebSocket hooks rely on its agents SDK. Their existence alone is not evidence that our current HTTP owner needs a WebSocket rewrite. Its background-read tool-name heuristic and broad403-as-auth regex are not copied; our adapter contract has explicit typed capabilities/errors.

## What the reference does not solve

BDots does not establish ChatGPT Dot access or a Codex-login-to-Dot exchange. Its Cloudflare application authentication is not an OpenAI login. Do not substitute its model loop, demo identity fallback, app MCP OAuth, shell/browser service or deployment stack for the user's existing chat.

Separately, source research found Beeper's [egress layer](https://github.com/beeper/chatgpt-dots/blob/05bfac9f682bf27e73d5c87755245031f556a066/pkg/connector/proxy.go) uses Chrome impersonation/browser headers and selected Cloudflare cookies; its [runtime client](https://github.com/beeper/chatgpt-dots/blob/05bfac9f682bf27e73d5c87755245031f556a066/pkg/connector/client.go) selects that transport even without a configured proxy. Our protocol port intentionally does **not** copy that layer. Request-builder parity is not full transport equivalence, and neither reference proves ordinary Node HTTP is accepted.

The renewed real checks established a Cloudflare challenge for the Node request, but successful normal-browser reads for the same account. They also exposed two genuine nullable response bugs, fixed in the provider decoder: `latest_messages: null` and `content.text: null`. Successful browser-side schema validation is not a claim that a deployed Node backend or DSH send is working.
