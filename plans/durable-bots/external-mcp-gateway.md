# Reusable external DSH MCP task gateway

## Current result —26October2026

**Genuine Yield is connected: health and existing-native-task read acceptance passed.** After explicit new approval, only the dedicated DSH tunnel received Incentive association; DSH Tasks was personally installed, not workspace-published. See [observed cloud acceptance and limits](../../apps/dsh-mcp-gateway/docs/cloud-acceptance.md) and [operator deployment](../../apps/dsh-mcp-gateway/docs/local-deployment.md). Yield returned ready=true/project=dshfiles and completed/the exact real native probe marker. Accepted tunnel delivery progressed5→10→14 with zero terminal delivery failures. Cloud create/send/cancel remain unexercised; the historical next-step note below is not proof of those actions. No DSH/Discord restart, core patch, public endpoint or owner API exposure occurred. The sections below retain the source milestone evidence as history.

## Boundary

A standalone normal Node22.23.3 app, `apps/dsh-mcp-gateway`, consumes the declared public `@dshfiles/dshx/platform` client against an existing **local** DSH. Native Sessions remain the sole execution/conversation owner. The gateway stores private ownership/idempotency metadata in SQLite, not another agent engine or transcript store. It holds the operator's local owner connection inside the process; external keys never receive a tokenized GUI URL/cookie or arbitrary native RPC access.

Six tools: `dsh_health`, `dsh_create_task`, `dsh_send_message`, `dsh_read_task`, `dsh_list_tasks`, `dsh_cancel_task`. Explicit principal/action/project grants; only gateway-admitted tasks owned by that principal; no remote cwd/preset/model/account/tool/profile selector. Stateless authenticated MCP transport uses the public maintained SDK1.30.0 WebStandard implementation, independently authorizing every request. Loopback bind only; exact Host, no browser Origin,128KiB request/1MiB response/16 concurrent request bounds. Output uses canonical declared task schemas, not raw provider errors, reasoning or tool arguments.

Creation/mutation claims are atomic across processes and survive restart. Same key/payload never dispatches again; mismatched reuse conflicts. Intent is durable before native effects. An uncertain side effect remains busy/unknown and is not timer-reclaimed or blindly replayed; unknown requested Session identity cannot be used to read a transcript. Stable UUID prompt request IDs are passed through the public SDK. Native creation can choose a different Session identity; the acknowledged returned ID is authoritative.

Cancellation acceptance is not termination confirmation. Native active-turn cancel retains its inbox and does not universally revoke descendants/jobs/goals/future schedules; the API/guide disclose that limit. Gateway cancellation gates subsequent gateway follow-ups. Actual observed aborted turn plus known-empty sequenced inbox is required to report cancelled. Gateway shutdown drains its admitted effects; already accepted DSH work remains owned by DSH and can continue.

## Verified

- **46gateway tests passed**:21durable service/real SQLite (including a second OS process),14native runtime through actual SDK,8real HTTP/MCP protocol boundaries,3operator config safety tests. Full strict typecheck, build, no-TS-stripping CLI/public protocol imports passed.
- **52public SDK platform tests passed** (23producer/client +29commands); owned SDK rebuilt. Additions are optional requested Session ID, stable prompt UUID and optional normalized native inbox counts/watermark. Existing call signatures retain their defaults.
- **20browser-task generator tests passed.** A fail-first regression exposed missing new-app source inputs for the global-owner journey cache. The existing feature-specific fixture-input map now includes this app's sources/manifest/config, canonical owner-scoped regeneration updated only `plugins/turbo.json`, and the fixture builds the app through its own declared script so fresh/stale dist cannot fabricate green.
- Gateway source/tests strict focused lint: **0warnings/0errors**. Gateway AST scan and diff whitespace check pass. A bounded independent read-only audit found no confirmed high/medium issue; actual ephemeral probes verified auth-before-body, Origin denial,16/17concurrency, input/output bounds, native-error redaction and close waiting for a held effect.
- **Actual external MCP SDK client → normal compiled gateway CLI → public SDK → real native DSH Session/Agent/logs → real GUI: green.** Initial accepted→observed running→completed; duplicate create yields one Session/one initial provider call; one follow-up/reply in the same Session; scoped list/read and wrong-key refusal; held native turn cancel acknowledgment then observed aborted/empty inbox→cancelled; positive gateway/Host/private-root cleanup. Only the LLM provider boundary is synthetic, no real provider funds/account used. This is not a genuine Yield call.

Latest frozen proof: `.dsh-e2e-evidence/1792989262527-f95fda4a-2c4c-403f-b9de-5233a886345f/manifest.json`,1passed/0failed/0skipped/retry0 in75s. `003-external-mcp-native-lifecycle-proof.json` records initial/followup/cancel calls for one Session and actual completed#16/completed#24/aborted#32; final state cancelled at32. `004-external-mcp-owned-cleanup.json` records gatewayPID2478348 exited and nativeHostPID2477927 exited; final scenario separately asserts the private root removed. The [retained synthetic screenshot](../../apps/dsh-mcp-gateway/docs/screenshots/native-task.png) was visually reviewed and contains no credential/transcript from a real account.

Reproduce (official Node22.23.3, existing built owned dependencies):

```sh
# Gateway package
node --run typecheck
node --run test
node --run build
node --no-experimental-strip-types dist/main.js --help
# SDK package
node --run build
node --run test -- tests/platform-cli.spec.ts tests/platform-commands.spec.ts
# Repository root
node --test tooling/dshx/scripts/browser-tasks.test.mjs
DSHX_DSH_EXECUTABLE=/home/neolectron/.local/share/dsh-install/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
DSHX_E2E_CHROMIUM_EXECUTABLE=/etc/profiles/per-user/neolectron/bin/google-chrome \
DSHX_E2E_PREWARM=0 DSHX_E2E_SCENARIO_CACHE=0 DSHX_BROWSER_PREBUILT=1 \
tooling/dshx/node_modules/.bin/playwright test \
  --config=tooling/dshx/playwright.e2e.config.ts \
  --grep 'Run, follow up, isolate and cancel one native task'
```

## Found and fixed at real boundaries

1. The first real journey reached actual MCP discovery/health but creation was unknown: admission IDs prefixed with `gateway-` failed the SDK/native UUID codec. A fail-first service+actual SDK composition test now prevents that mismatch; IDs are raw UUIDs.
2. An adversarial regression showed that a requested but unconfirmed Session ID after a lost create acknowledgment must not be treated as ownership. Reads now remain unknown without reaching native history until creation is acknowledged.
3. Native completion is not equivalent to idle: old completions/queued follow-ups/cached inbox state are not reported as current completion. The canonical SDK normalizes only known inbox evidence; missing/late cuts remain unknown.

## Generator/dependency evidence and residuals

Pinned pnpm12.5.1 filtered offline/ignore-scripts install added the expected new app importer and reconciled peer-context snapshots (1528→1623). A structured comparison of **both** lockfile documents confirmed published package maps (versions/integrities), existing importers and resolver metadata/settings are unchanged; only the new app importer and generated peer contexts differ. No broad dependency-version/policy upgrade was made and no shared-runtime/stock installation was replaced. Keep canonical generated lock output, not a hand-spliced snapshot. Papercut `p_e3eda1a3d0` records this workspace-manager churn.

The SDK1.30.0 Node transport wrapper callback/accessor declarations conflict with strict exact-optional consumers. The production app uses its documented WebStandard transport without casts or augmentation. Public runtime MCP-client interoperability is proved by the actual E2E. Papercut `p_6c5ef44419` records the upstream declaration issue.

Maintain-verify-dsh trigger review applies to the new journey/generator input. New app has no plugin catalog; a reserved orphan plugin-scenario tag was corrected to an ordinary tag. Scoped real journey is green and owner generation is reconciled. **Global catalog hygiene still has60unrelated existing errors**, recorded in `/tmp/dsh-mcp-gateway-feature-hygiene.log`; no gateway entry remains. No shared boot/navigation helper changed, so no unrelated all-plugin smoke repetition was performed. SDK file-wide baseline lint warnings outside new code were not rewritten. No claim of a globally clean repository release gate.

## Historical cloud handoff — superseded by the current deployment guide

Cloud Yield's localhost is not this computer. The gateway can remain next to DSH on loopback; an OpenAI Secure MCP Tunnel runs here and supplies the outbound authenticated HTTPS path. This is preferred for the private first proof; public stable HTTPS is the interoperable alternative for other clients/public distribution. A separately hosted gateway still needs a secured path to this local runtime.

No tunnel client/system package has been installed, no listener exposed and no credentials configured. No secret aliases were available. Human-dependent prerequisites: provision/select a tunnel ID, a Platform **runtime** key with Read+Use, appropriate workspace connector permissions (Manage for creation), and the local operator-only DSH/gateway credential references. Follow the guide's environment/file references; do not paste keys in chat or reuse Codex account tokens. System installation belongs to the user's nixfiles project, not ad hoc installation here.

Next acceptance gate: configure a dedicated restricted tunnel/principal with health-only/read access, have **genuine Yield** call `dsh_health` and verify the server receipt, then explicitly grant/create one real authorized task, read its result and send/cancel a follow-up. Neither a normal ChatGPT call nor synthetic client success substitutes for genuine Yield proof. V1 bearer auth is not an OAuth authorization server; client-specific OAuth requirements must be addressed explicitly, not bypassed by disabling auth.
