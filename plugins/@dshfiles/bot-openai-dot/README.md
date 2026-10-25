# OpenAI Dot adapter (unofficial)

![Human-only Dot connection page inside DSH](<docs/screenshots/dot-connection.png>)

_Synthetic loopback-only Chromium enrollment inside the real DSH page—not a real provider sign-in or Yield account._

**Port**, not a fresh protocol implementation: pinned Beeper behavior avoids rediscovering the private protocol while staying native to the DSH Node Host (no Go or Matrix daemon). This package alone is **AGPL-3.0-only**; see [LICENSE](LICENSE) and [provenance/update policy](PROVENANCE.md).

Registers a v1 `BotAdapter` with `ctx.get('botAdapters')`; the provider-neutral Bots plugin owns UI, durable outbox, checkpoints and the three-second polling loop. Default HTTP mode performs no provider request until the user connects through Bots after accepting its explicit broad-account/unsupported-protocol warning. Optional managed-browser mode adds the **Dot connection** page for human admission inside DSH; it starts a fresh backend browser only after separate explicit consent. Conversation UI and the durable outbox remain in Bots, not in a replacement chat/model.

## Node composition

`@dshfiles/bot-openai-dot/adapter` is an intentional dshx public module exposing the existing `createDotAdapter` factory and its dependency type. It can be constructed, configured and registered with the public Bots registry in ordinary Node without starting a DSH Host or reading credentials. The caller supplies either the legacy reference resolver (and optional writable credential store) or a backend-only `DotAccountAccess` callback for an externally owned OpenAI login. These authorities cannot be combined; the protocol, identity and safety rules stay in this provider.

Without a store, both the management metadata and session reference-binding method are absent. Core refuses management grants without restarting or poisoning a healthy manual worker. Memory-only renewal remains available in legacy reference mode; external-account mode never uses cookie renewal. Nothing writes a caller's reference backend. With a store, the original explicit-consent and identity-bound write semantics remain unchanged.

Secret Catalog is a **Host-entry-only optional peer** (and build/test dependency), not a dependency of the pure adapter. The default reference-mode Host entry requires that Catalog package/API. Explicit account mode instead dynamically consumes the public AI Accounts capability and native WebServer (optional Host peers); standalone adapter/authority-client consumers need neither Host graph. The adapter declares its direct dshx API runtime dependency. AGPL/source/provenance obligations apply to applications composing it, not just to its default Host entry.

## Managed browser admission inside DSH

The declared `browser-session` and `auth` public modules compose a normal Node-owned browser transport and private human viewer. No existing browser profile/cookies are imported, no ChatGPT tab or desktop helper must remain open, and no model or Dot identity is replaced. HTTP-only mode remains the default; browser mode is explicit, never a silent response to403.

1. Open **Dot connection** in DSH, accept the browser risk notice and choose **Start browser**.
2. Complete the provider's normal check yourself in the raster viewer. No automatic challenge solving, stealth, TLS/UA impersonation or generic browser commands are provided.
3. Choose **Use this session**. The viewer clears private input/pixels, drains acknowledged I/O and revokes its controller. The Node owner retains the same browser for actual API requests.
4. Return to **Bots** and connect/reconnect the configured account. Normal adapter discovery and exact room/member checks—not the viewer's ready label—establish the remote bot identity.

The normal app still reads the explicitly selected DSH login through its private account authority. Browser mode supplies real browser networking and its own normal cookies; it does **not** silently substitute a web-session token or prove that the Codex grant is accepted. External Google/Apple/Microsoft SSO is outside the fixed first-party navigation policy. Raw input, frames, controller capabilities and credentials are excluded from agent tools, generic RPC, Query/state snapshots, DOM text, storage and logs. All connected DSH browsers share the owner's authority; the notice does not promise confidentiality from same-OS-user software or malicious DSH scripts.

The Host may keep the main DSH listener unchanged and own a separate private loopback account listener. Example trusted profile configuration:

```yaml
mode: account
accountIds: [your_existing_dsh_account_id]
acceptAccountRisks: true
authorityTransport: loopback
authorityOrigin: http://127.0.0.1:8788
authorityTokenReference: secret:DOT_ACCOUNT_AUTHORITY
enrollmentServiceOrigin: http://127.0.0.1:8787
enrollmentTokenReference: secret:BOTS_SERVICE_CONTROL
browserOrigin: http://localhost:3198
```

The two service keys must differ. Human credential/viewer access requires HTTPS or loopback HTTP, with exact native BrowserPeer plus paired Host/Origin admission. Additional origins are explicit trusted `additionalBrowserOrigins`; no wildcard is accepted. The private Node endpoints inherit the normal service bearer fence and expose no browser CORS. No running DSH rebind/restart is performed by this feature's verification.

Renderer sandboxing, bounded I/O, fixed document origins and normal TLS/CORS are enforced; these are **not OS-level provider-only egress confinement**. The browser is a trusted first-party human enrollment surface, not a general Agent browser. System Chrome155 synthetic runtime diagnostics confirm namespace/seccomp/TSYNC renderer sandboxing. Container browser provisioning/kernel compatibility remains separate from the historical no-browser Docker smoke.

**Verified locally:** real scratch DSH → private native proxy → authenticated normal Node service → real isolated Chromium → manual synthetic completion → retained cookie-backed browser → actual Dot adapter synthetic connect/send/reply, with one Node outbox and no Host Bots domain. The full journey passed twice and positively cleaned all browser/Host/service/profile/lease resources. This is not live OpenAI authorization or installed-GUI acceptance.

## Credentials and linking

Legacy reference-mode configuration has exactly two required reference fields: `accessTokenRef` and `sessionTokenRef`, each `secret:ALIAS` or `secret:ALIAS@env`. No raw tokens, browser/cookie extraction or implicit process-environment fallback. Existing credentials must already be stored by the user through their supported vault workflow. The canonical credential-port Host resolver reads the values; clients, tools and local history receive references only.

Credentials are broad ChatGPT account authority, **not** provider-enforced Dot-only scope. This unsupported protocol can break or be denied at any time. Access JWT decoding is a binding hint, **not signature validation or authorization**. Successful provider discovery plus exact two-member room verification authorizes the Dot messaging room.

### Externally owned OpenAI account

`createDotAdapter({ accountAccess: { readAccessToken(accountId, signal) } })` accepts exactly `{ accountId }` connection configuration. The bounded account ID is a plaintext reference, not a token or credential path. The backend account owner must authorize that exact account and return its current access token only inside the backend callback. No token enters a Client/API/tool result, connection configuration or Bots history. A static resolver/store cannot be supplied alongside this mode; no management metadata or reference-binding method is offered.

Initial access and every provider HTTP operation re-read the selected account through that capability. JWT expiry must be known and unexpired; account, user and account-user binding hints must remain unchanged. These checks are not signature verification or proof of Dot entitlement. Missing, expired, switched or denied credentials fail closed without another account, cookie, refresh token, credential write or `/api/auth/session` request. A 401/403 stops the session until explicit reconnect. No auth retry repeats a POST; uncertain delivery still requires reconciliation of the original request UUID.

Owner resolution and each HTTP operation have a 15-second cancellation boundary, including callbacks or fetch implementations that ignore cancellation. Close/cancel prevents late credentials from authorizing provider I/O and cancels response reads. The public AI Accounts owner broker and private authority channel now compose this seam, but synthetic success is not proof that Codex OAuth can access Dot. It does not modify the pinned private provider protocol.

### Private DSH → Node account authority

The declared `@dshfiles/bot-openai-dot/account-authority` module supplies a backend-only handler/client and one versioned private contract. It is **not** a native API, Client or agent get-token method. The normal Node app can use the client without importing AI Accounts or mounting a DSH home. Only short-lived access crosses this authenticated backend channel in memory; no cookie, refresh token, persistent credential copy or value in normal Bot configuration/history.

The Host remains in legacy `mode: references` when configuration is omitted. Profile-owned account mode requires every admission explicitly:

```yaml
mode: account
accountIds: [your_existing_dsh_account_id]
acceptAccountRisks: true
authorityOrigin: https://your-native-dsh-host.example
# Separate purpose key, NOT the Bots control key, OpenAI login or DSH browser cookie.
authorityTokenReference: secret:DOT_ACCOUNT_AUTHORITY
```

The key resolves fresh through the canonical Host reference port. An empty reference alone permits explicit `DSH_DOT_ACCOUNT_AUTHORITY_TOKEN` fallback. No unlisted account or pool fallback is allowed. Host setup registers one owned exact route through the installed public WebServer API, with no new listener or bot engine; unloading removes the route, registration and broker capabilities. Native listener protocol must match the pinned origin. Malformed/mixed/implicit admission is refused.

The handler owns its independent purpose authentication, exact Host/path/method, no browser Origin/Cookie/Referer/fetch-site/CORS, no forwarded-header trust, 8 active request races, 2KiB input and10s deadline. Node's legitimate `sec-fetch-mode` alone is not browser admission. All handler failures are sanitized before native logging. A canceled request cannot use a late credential; this does not kill arbitrary underlying noncooperative I/O or recall an access token already delivered. The client uses a fixed HTTPS root or literal-loopback HTTP origin, no redirects/retries, fresh keys, 64KiB bounded strict UTF-8 output, exact account binding and15s cancel/close deadline. This purpose key must differ from the normal service control key; the app checks startup and rotation.

**Deployment is not yet proved:** HTTPS must reach actual native TLS; HTTP requires both actual socket endpoints to be loopback. A LAN HTTP GUI URL, proxy/forwarded headers or a container's unrelated loopback do not satisfy this fence. Do not transfer a real account token until the secure topology is verified. Prior selected-login discovery returned403 HTML and was not retried. Real account authorization and GUI activation remain unverified; synthetic public broker → real private loopback HTTP → client → Dot factory tests do not establish provider entitlement.

### Web-only sign-in work is not activated

The source tree also contains a narrowly ported human raster viewer and a managed synthetic browser worker. They are **not** wired into this Host entry or advertised as completed onboarding. Genuine native authentication and a fake-page real-GUI journey pass; a loopback-only namespace independently proves renderer sandboxing and cleanup. That does not establish provider egress, actual ChatGPT login or a real Dot reply. The earlier public provider entry returned403; no challenge bypass, profile import or manual token-hunting fallback is implemented. Track remaining input and isolation gates in the [completion plan](../../../plans/durable-bots/web-sign-in.md); the MIT viewer/input notice is retained in [NOTICE.md](NOTICE.md).

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
