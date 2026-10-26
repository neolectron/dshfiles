# Genuine Yield connection: observed acceptance

26October2026. The user explicitly changed the earlier keep-private decision: **"workspace it is then."** This authorized the dedicated tunnel's Incentive association and a personal plugin test, not workspace-wide plugin publication or a new public endpoint.

## Configuration applied

- Updated only the existing dedicated DSH tunnel through the supported Platform UI. Preserved its Platform organization association and added the exact Incentive workspace selected from the live workspace picker.
- Re-read the saved table: the DSH tunnel now shows Incentive; the separate Discord tunnel's identity, description and associations are unchanged. No Discord service/config/key was modified.
- Created and connected **DSH Tasks** through the normal ChatGPT custom-MCP UI. Personal settings show connected, development version and review status `DEVELOPMENT`; the separate **Publish to workspace** action was not used.
- The discovered app exposes exactly three reads (`dsh_health`, `dsh_list_tasks`, `dsh_read_task`) and three writes (`dsh_create_task`, `dsh_send_message`, `dsh_cancel_task`). This is not a native all-tools export.
- The connector uses no end-user OAuth; the existing tunnel daemon still injects the distinct private local gateway credential. Gateway authentication was not disabled, and DSH's owner credential was not exposed to ChatGPT.

## Genuine Yield proof

Used the existing Yield at its normal `dots/home` UI, not a replacement assistant or a synthetic model. Submitted one explicitly read-only health request, separate from its ongoing work, forbidding Codex launches, new task operations and file changes.

Yield returned:

```text
ready: true
Allowed project identifiers: dshfiles
Protocol: dsh-task-gateway-v1
```

Then submitted one read-only call for the existing harmless native connection-probe task. Yield returned:

```text
State: completed
Visible reply: DSH_MCP_LIVE_READY
Exact match: yes
Error: null
```

The same probe had just been re-read locally through the authenticated real MCP client, confirming its actual native completion at sequence18. No new DSH model request, task, follow-up or cancellation was created for these cloud checks.

## Transport evidence and caveat

- Before installation: zero dispatched/accepted commands.
- After app discovery/connection: five completed/accepted commands.
- After Yield's health check: ten completed/accepted commands.
- After Yield's existing-task read: fourteen completed/accepted commands, no active dispatch, response delivery HTTP200, zero retries and zero terminal delivery failures. `/readyz` remained200 and control-plane health `ok`.

These are cumulative transport counters, **not fourteen tool calls**: initialization, discovery and notifications are included. With the current SDK1.30 transport, the audit records an HTTP400 `server/discover` attempt followed by successful discovery and actual tool results. This establishes working fallback behavior, not the exact underlying cause of the modern-probe rejection. Do not report zero dispatcher failures or fabricate a per-tool success log: successful audit entries retain request correlation, not the tool payload/name. The evidence combines actual product results, fresh local probe verification and accepted tunnel delivery during each check.

## Limits and next use

- This proves genuine Yield health and a read of real native DSH output. Cloud create/send/cancel were discovered but not exercised in this acceptance. Their native/local source tests and prior real scratch journey remain separate evidence.
- The only current project alias is `dshfiles`. Additional projects need explicit operator grants.
- A personal plugin installation does not add individual-user authentication to the shared static gateway principal. The user knowingly approved the workspace transport association; other authorized tunnel users remain within that same configured principal's grants.
- No public HTTPS OAuth proxy was created. The [private-access research](private-access-options.md) remains historical analysis under the earlier no-workspace-association constraint, not the deployed architecture.
- DSH and Discord were not restarted; no serving-checkout/profile/core mutation, Codex mirror or backend browser was introduced.

For normal use, ask Yield to use **DSH Tasks**, identify the allowed project and task brief, and return the native DSH task link. Follow-ups should use the same returned task identity; uncertain admissions must keep the same idempotency key rather than create replacement work. A completed native turn is not proof that a broader user objective was verified.
