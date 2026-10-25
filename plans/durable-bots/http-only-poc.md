# Yield: browser-free go/no-go proofs —25October2026

## Scope

The user rejected any backend browser and requested small feasibility proofs before further implementation. The managed-browser path is stopped and not deployed. No live profile change, server restart, cookie/profile import, OAuth refresh, account fallback, anti-bot evasion or real message occurred in these proofs.

## Results

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
