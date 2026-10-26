# Yield: browser-free go/no-go proofs —25October2026

## Scope

The user rejected any backend browser and requested small feasibility proofs before further implementation. The managed-browser path is stopped and not deployed. No live profile change, server restart, cookie/profile import, OAuth refresh, account fallback, anti-bot evasion or real message occurred in these proofs.

## Latest authorized account comparison: Sylvain

The user explicitly authorized `codex_ocx_sylvain` instead of the earlier Manuel selection. The real ordinary-HTTP proof made exactly one authenticated Dot-primary GET. It returned403HTML with the explicit Cloudflare challenge in58ms. Sylvain's access token was locally usable before and after, and a private SHA-256 comparison confirmed the access-token material was unchanged; only that boolean was reported, never the digest or bearer. Native identity metadata reported signed-in both before and after. After the Dot request, the native serving-account ledger also records a successful Codex model request for this same Sylvain account in the current conversation. This independently demonstrates post-test Codex access, not future refresh-grant validity. No Dot message, OAuth refresh, logout/revoke endpoint or credential write was performed by the probe; ordinary DSH model traffic is separate.

Receipt: `/tmp/yield-direct-http-poc-MYzEhl/receipt.json`. Reproduction:

```sh
DSH_HOME=/home/neolectron/.dsh node scripts/poc-yield-direct-http.mjs --account=codex_ocx_sylvain
```

This proves no local logout/token change was observed in this bounded test. It does not remotely validate refresh-grant validity or prove that the provider could never revoke a session later. The earlier Manuel probe found an already-expired access token before Dot network I/O; Marwan was not used for authenticated provider calls in these proofs. No evidence establishes that these read-only tests caused either reported login problem.

## Follow-up26October: official Codex and inverse delegation

The earlier route-policy explanation was incomplete. Current official Codex, pinned at `970111f6cb62cc02fe36a82ea7d71b37a2889c97` (not a verified installed-binary match), enables a process-local HTTP/WSS infrastructure-cookie jar. Its hardcoded allowlist includes Cloudflare cookies such as `__cf_bm`, `cf_clearance`, `cf_chl_*`, and OpenAI's routing cookie `__oailb`; ChatGPT account/session/auth cookies are excluded from the shared jar. This is response-cookie retention, not evidence of an interactive challenge solver or proof of which cookies caused success. Its API error mapping explicitly reports some Cloudflare403blocks. Default TLS does not supply a client identity certificate. See the pinned [cookie implementation](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/http-client/src/chatgpt_cloudflare_cookies.rs) and [API error mapping](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/codex-api/src/api_bridge.rs).

No actual successful Codex request cookie/header/TLS comparison was made. Neither that source nor same-account inference success reveals the deployed security rules for Dot. Do not claim a magic header, a guaranteed cookie-based fix, or that inspected current upstream behavior necessarily exists in installed DSH/pi-ai.

The original proposal recovered from the opening conversation was **let genuine Yield create/inspect/guide DSH threads through a connector**, not automatically import Codex conversations. Current official [Dot task docs](https://learn.chatgpt.com/docs/dots/tasks-and-memory.md) distinguish delegated task threads from the Dot conversation and say a task receives selected instructions/context rather than all its history. [Computer/app docs](https://learn.chatgpt.com/docs/dots/computers-and-apps.md) say Dots can use supported installed plugins; [plugin docs](https://learn.chatgpt.com/docs/plugins.md) include MCP tools.

That inverse direction is more promising for a first step:

```text
User talks to genuine Yield in OpenAI's UI
  → Yield invokes an authenticated DSH tool
  → DSH creates one real native Session with the delegated brief
  → work and follow-ups appear in the DSH GUI
  → selected status/results return through the tool
```

DSH's owned thread actions already create and prompt through supported native SessionController services. Its owned dshx CLI also has `sessions create/start/prompt`; the existing communication MCP server is passive messaging only and cannot start a turn. A narrow authenticated external lifecycle adapter is still needed; the internal agent tools are not automatically available to external Yield. No direct session-file/database writing, generic host shell, blanket tool export or tokenized GUI credential disclosure.

For remote access, an authenticated HTTPS MCP endpoint or the official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.md) is documented. The latter uses an outbound connection and a Platform runtime key plus workspace permissions; it is not zero-setup and its availability for the user's actual Dot/account remains unverified. A local Codex skill/CLI route is conditional on the delegated task's runtime reaching DSH and receiving appropriately limited authorization; a Codex cloud task cannot reach this computer's localhost by magic. Existing loopback forwarding is reported at `http://localhost:3198`; no authenticated external connection was attempted.

First proof must be genuinely initiated by Yield: one read-only health tool returning a nonce, then one authorized task-create with an allowlisted project, request-id deduplication, a returned DSH thread link and one follow-up/status read. Do not label a normal ChatGPT MCP call or a synthetic client test as Yield proof. No MCP deployment, plugin/account changes or actual thread creation occurred in this investigation. This avoids our private Dot GET entirely, but does not mirror existing Codex tasks or move the main Yield conversation into DSH.

### Why Codex differs

The actual serving DSH uses the pi-ai HTTP/SSE Codex provider (plugin resolves1.3.0), whose default inference target is `https://chatgpt.com/backend-api/codex/responses`. The Dot adapter instead calls `/backend-api/tbo/primary`, then verified Dot/room messaging endpoints. Same host/HTTP technology does not mean same resource, edge rules or permissions. Route-specific security is a plausible explanation, not a measured OpenAI configuration.

The serving model route also has an OAuth credential store with refresh/persistence; pi-ai refreshes near expiry. The Dot probe deliberately uses a read-only capability that rejects an expiring token and does not invoke that model resolver. Expired access JWT, invalid/revoked refresh grant and a local UI signed-in indicator are different facts. Calling Codex inference cannot address the user's existing Yield and its memory/tools.

Read-only source trace also found a possible model-routing handoff risk: `options.apiKey` can take precedence over a just-refreshed credential on that request. This is not reproduced and is not evidence of the cause of the reported account expirations. Do not silently patch or expand this feasibility task to fix it.

## Earlier results

| Path | Evidence | Verdict |
| --- | --- | --- |
| Ordinary OpenAI API network control | A real unauthenticated `GET https://api.openai.com/v1/models` returned401 `application/json`, no Cloudflare challenge. | Normal backend HTTP reaches the official API. This does not authenticate or address Yield. |
| Current selected-login Dot discovery | The read-only public owner capability for `codex_manuel` rejected the login as `expired`, before any Dot HTTP request. The adapter returned `auth-required`; no other account or refresh was attempted. | Current authenticated test is inconclusive until owner-managed renewal; do not mislabel it a fresh authenticated Cloudflare refusal. |
| Current Dot edge control | A real unauthenticated `GET https://chatgpt.com/backend-api/tbo/primary` returned403 `text/html` with `cf-mitigated: challenge`. Body canceled unread. | The security barrier still exists independently of the local expiry prerequisite. No bypass or retry sequence was attempted. |
| Earlier authenticated direct Dot read | Retained redacted receipt: selected account, unexpired token, exactly one request,403 HTML, explicit challenge and Cloudflare edge server. No body read. | Authenticated direct HTTP previously reached the same barrier. It did not prove an OAuth permission denial. |
| Browser-free adapter/control-plane composition |21existing focused tests pass, including the real private HTTP channel/public account-owner capability and Dot factory using a synthetic provider fetch seam. No browser is imported/started by this flow. | Transport/adapter mechanics work in controlled conditions; not proof of real provider authorization or a genuine Yield reply. |
| Official Workspace Agents API | Published `agtch_` API channel plus workspace-scoped PAT. Triggering/status are documented, but agent response retrieval is explicitly unavailable. Personal-Dot compatibility is not documented. | Does not meet two-way chat with existing personal Yield. Documentation assessment, not an authenticated runtime test. |
| Sign in with ChatGPT / Responses | Official docs expressly exclude access to ChatGPT conversations/other account context. This is model inference, not selecting the existing Dot. | Not a substitute for Yield identity/memory/tools. Documentation assessment only. |

Safe current receipts: `/tmp/yield-direct-http-poc-otKUtv/receipt.json`, `/tmp/yield-dot-edge-public-control.json`. Earlier authenticated edge receipt: `/tmp/bots-renewed-read-dBUjs5/receipt.json`. No bearer values, cookies, raw identity claims or transcript text appear in these receipts.

Reproducible read-only script: [poc-yield-direct-http.mjs](../../scripts/poc-yield-direct-http.mjs). It admits only bounded canonical GET discovery, has no send implementation, and reads through the selected account owner's public backend capability rather than exposing credentials to an agent/tool result.

```sh
DSH_HOME=/home/neolectron/.dsh node scripts/poc-yield-direct-http.mjs
# No browser/service/profile changes. Retains only a private redacted receipt.
```

Focused controlled check:

```sh
node --run test -- tests/account-access.test.ts
# from plugins/@dshfiles/bot-openai-dot:21passed
```

## Would removing Cloudflare simplify the project?

**Yes, substantially.** A provider-authorized plain HTTP route would remove the browser process/profile, pixel viewer, input relay, handoff controller, screenshot/input concurrency, browser sandbox/container provisioning and browser-specific cleanup. The remaining shape is simply DSH Bots UI → ordinary Node HTTP service → existing Dot HTTP adapter → real Yield, with the existing account-owner capability and one durable outbox.

It would not, by itself, prove that the current DSH/Codex OAuth grant can access personal Dot endpoints. Remaining proof gates: owner-managed usable login, provider acceptance of that grant, correct primary Dot/exact room membership, one authorized send plus real reply, proactive incoming delivery, reconnect/idempotency and usable reauthorization. The unofficial protocol remains a maintenance risk.

Do not ask the user to renew a login merely to rediscover the already-observed security barrier. First establish a legitimate browser-free provider-access route; then renew through the normal account owner and perform one read-only genuine discovery. No further full implementation/deployment should proceed until that go/no-go succeeds. A normal platform API key, a Responses conversation or a new agent does not automatically unlock the existing Yield.

## Official/public references checked

- [Workspace trigger and run status](https://developers.openai.com/workspace-agents/trigger-runs.md): “The agent's response cannot currently be retrieved through the API.”
- [Workspace authentication](https://developers.openai.com/workspace-agents/authentication.md): workspace-scoped access-token and admin prerequisite.
- [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source.md): “This does not grant access to their ChatGPT conversations or other account context.”
- [Beeper connector](https://github.com/beeper/chatgpt-dots): claims existing personal Dot identity/memory/tools preservation, but labels the undocumented protocol unofficial/experimental; its current plain-HTTP viability is not established by these docs.
