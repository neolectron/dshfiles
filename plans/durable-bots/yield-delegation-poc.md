# Genuine Yield → DSH delegation proof

## Current state —26October2026

The user authorized a small proof: keep talking to genuine Yield in OpenAI's UI, let Yield create work as real native DSH conversations, then inspect results and send follow-ups. No Codex transcript mirror, private Dot messaging API, backend browser or full product implementation.

The interrupted turn was recovered: clean Git workspace at d6ca2077, no active background jobs or subagents; the active proof goal was explicitly resumed. Current public DSH CLI @dshfiles/dshx0.1.4-preview.3 exposes `sessions create/start/prompt` and the existing DSH GUI has loopback forwarding at `http://localhost:3198`.

## Observed proof results

| Stage | Actual evidence | Meaning |
| --- | --- | --- |
| Local script, run by this DSH agent | [poc-yield-local-reachability.mjs](../../scripts/poc-yield-local-reachability.mjs) made one unauthenticated GET to127.0.0.1:3198 and returned401. Syntax and focused lint pass. | DSH is locally reachable and still rejects unauthenticated access. This is NOT a Yield tool-call result or authenticated DSH control. |
| Genuine Yield request through the normal signed-in UI | In the existing Chrome profile, the genuine Yield page was available. Yield was asked to run that exact harmless script on the connected local computer, without reading credentials, adding services or changing files. | Uses the user's real Dot, not a replacement model, fixture or backend browser. The normal user-facing browser was used only to send the requested proof instructions. |
| Yield local task executor | Yield reported its connected computer was authorized but the `cloud_threads` local executor refused before running: **“Your workspace is out of credits. Add credits to continue.”** It explicitly reported no stdout, exit code or reachability measurement and no substitute attempt. | The local-task route is blocked by a reported provider credit prerequisite before DSH. This is separate from the earlier Cloudflare private-API refusal. No genuine local execution or DSH thread creation is proved. The report was observed in Yield's reply, not independently inspected provider telemetry. |
| Direct MCP capability inquiry | Yield inspected available tool definitions only. It reported no installed DSH tool and no generic arbitrary-MCP invoker, but identified an existing non-DSH plugin tool and said exposed plugin/MCP tools are callable directly in the Dot conversation without a Codex/cloud_threads task. No endpoint was invoked in that inquiry. | Promising direct-tool path, not yet a working DSH connection and not proof that a new tool succeeds or is exempt from all usage restrictions. |
| Actual ChatGPT plugin UI | The signed-in plugin page's Add menu offers **Create plugin**, **Upload plugin archive**, **Add custom MCP server**. No plugin was created/installed and no credential/config changed. | Custom-MCP setup UI is available in the actual account, not merely documented. Network delivery/authentication still needs setup. |

The prompt's multi-paragraph input was submitted by the Dot composer as separate UI messages because newline acts as Send. The complete bounded instructions and final restrictions were then sent and verified; subsequent inquiry used one line and explicit Send. This is recorded as papercut `p_2641369933`, not hidden as a single API request. Only the one harmless local-check attempt was requested; no automatic retry was made.

## User concern and routing alternatives

The user declined selecting an MCP carrier for now: a voluntary tool could be forgotten or skipped by subagents. Do not proceed with MCP provisioning on the assumption that a transport solves routing reliability. The requirement is deterministic handoff, not merely an extra tool.

The official [Hooks guide](https://learn.chatgpt.com/docs/hooks.md) documents SessionStart/UserPromptSubmit/SubagentStart/PreToolUse events for supported local Codex execution, but explicitly says cloud-orchestrated Dots do not load local/plugin command hooks even when tools run locally. Enterprise managed remote MCP hooks are a different administrative feature; personal accounts do not use them. Missing/erroring MCP hook callbacks can fail open. Therefore a local hook is an investigation candidate, NOT an established way to redirect every genuine Dot-created task or child. Native cloud_threads → custom DSH executor selection is not documented by the sources checked.

A GitHub-issue/queue handoff can make dispatch/retries/idempotency deterministic once a brief is submitted, but does not guarantee that Yield decides to submit the brief. A transcript/file watcher or emulated Codex backend would be unofficial, larger and brittle; do not present either as a clean first proof. No such mechanism was implemented. Await a decision about whether to investigate actual local-task launch events (still blocked by the reported task credit prerequisite), accept an explicit handoff action, or defer until a supported native executor extension exists.

## Earlier proposed next steps — not authorized to provision yet

1. Choose a reachable carrier for a read-only MCP health tool: existing user-owned HTTPS hosting, or the official private Secure MCP Tunnel. Do not publish the DSH owner API or hand Yield a tokenized GUI URL/cookie. Do not reuse unrelated installed plugin authority.
2. Private tunnel prerequisites are a Platform runtime key/tunnel identity and the required Platform/workspace permission. No secret aliases were available in this workspace; do not hunt account files or echo a key. Any new credentials must stay operator-side and referenced through supported secret handling.
3. Implement/provision only the selected minimal read-only health capability, validate negative access locally, then have genuine Yield invoke it and compare the observed server receipt. A synthetic MCP client alone is not acceptance.
4. Only after that succeeds, add ONE project-allowlisted task-create with deduplication/explicit human authorization, return a DSH thread link, then one status/result read and follow-up. Native SessionController remains the only conversation owner; no second agent loop or transcript store.
5. The Codex-local alternative can be retried only after the user resolves the reported task credits and authorizes a retry. Do not ask for payment or fund anything automatically.

No server/tunnel was started; no system package installed; no DSH owner credentials exposed; no OpenAI login refresh, private Dot API call, real DSH conversation creation, live plugin/profile mutation or DSH restart occurred. The genuine Yield chat now contains the proof request and reported failure, which the user can review.
