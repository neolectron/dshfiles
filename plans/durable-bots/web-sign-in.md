# Web-GUI-only Dot sign-in: implementation gate

## Human decisions

The user requires the entire sign-in experience inside this DSH Web GUI, without a desktop helper or token hunting. They explicitly authorized broad ChatGPT-account linking and exactly **DSH connection test — please reply OK**. Existing browser/profile inspection, automated challenge bypass and additional messages are not authorized.

## Fresh evidence

- Managed Chrome **155.0.8059.79** with installed Playwright **1.56.1** connected over CDP in a newly created private profile.
- Renderer sandbox was confirmed: Seccomp=2, NoNewPrivs=1 and a user namespace distinct from the browser; no `--no-sandbox`.
- The first and only public document request to `https://chatgpt.com/auth/login` returned **403**. The page was closed immediately; there was no input, authentication/session API call, cookie/storage inspection, challenge interaction, screenshot or message. This does not establish whether a human could complete a legitimately presented challenge.
- All 15 tracked owned process identities exited and the temporary profile was removed.
- The existing GUI still returned **401** to an unauthenticated, body-discarded health request. No restart occurred. `lsof` was unavailable; no process attribution was inferred from that failed command.

**The local browser primitive works; authenticated sign-in does not yet have a working proof.** Never turn this probe into a claim that the user's account linked successfully.

## Adopt / port decision

No safe turnkey installed viewer was found. A narrow **port**, not wholesale adoption, is the current candidate:

- [dsh-browser-cdp 1.6.0](https://github.com/drscrewdriver/dsh-browser-cdp), MIT, pinned `da9891b9c8ee64b6c4da16d3ae654d0f1166cccd`: reuse only reviewed pixel/input/IME mechanics. Keep license, exact source/hash provenance, exclusions and update policy.
- Do **not** reuse its cookie-name-only admission, unauthenticated control listener, persisted browser discovery/profile import, raw CDP/JS/HTTP tools, inherited environment or fire-and-forget teardown.
- [Browserless LiveURL](https://docs.browserless.io/baas/monitor-sessions/embedding-live-url) needs separately verified deployment/licensing and would introduce another credential/frame operator if hosted. No cloud service is authorized.
- [noVNC](https://novnc.com/info.html) is maintained but requires currently absent display/VNC/bridge infrastructure. It is not an installed zero-dependency alternative.

This is conditional design, not permission to skip the security or provider gates below.

## Supported seams, not a core patch

Installed DSH 0.2.1-rc.2 exposes authenticated exact plugin routes through `connection.fetch.register`, native Host/Origin admission, byte responses, managed subprocess pipes/control, abort/terminate/wait and an authenticated client connection. A plugin-level implementation is possible; there is no demonstrated missing core binary-transport operation.

Native `browserPeer` is shared by all authenticated browsers, not a per-person identity. An originating-tab capability can prevent accidental cross-tab takeover but cannot create tenant isolation or protect from trusted same-UID Host code. Keep the existing shared-owner disclosure.

The existing adapter is reference-only, not an onboarding API. Any new enrollment seam must remain owned/provider-neutral and preserve Core account/bot/room validation and explicit vault permission. Do not expose a general browser API in Bots to implement one concrete authentication flow.

## Required implementation boundaries

1. One bounded attempt, one controlling tab, a fresh empty profile and fixed provider login entry. No profile reuse/import, arbitrary target/address selection, desktop access, file chooser/upload/download, clipboard export, extension or developer-console control.
2. Native owner + Host/Origin admission, an ephemeral high-entropy attempt capability kept only in originating UI memory, bounded/ordered input, stale-generation rejection and immediate capability revocation on cancel. No bearer URL/query, global frame list or replay/fanout.
3. Pixels and human keyboard/text input travel only over a private authenticated UI transport. Never make them Agent tools, conversation events, telemetry, HAR/video/traces, logs or browser persistence. Status/start/cancel may expose sanitized state; never cookies, session JSON or raw token pairs.
4. Managed worker owns all browser descendants. Minimal environment, sandbox enabled, no stealth/UA impersonation/proxy rotation/challenge solving. Temporary isolation is not proof of network/file confinement: prove provider navigation/request/popup/worker/WebSocket/internal-scheme and egress restrictions before accepting real login input.
5. Stop or surface a legitimate provider denial/challenge without bypass. The observed public 403 remains unresolved; do not retry it by disguising automation or claim it proves every human path impossible.
6. Collect a pair only from this freshly owned authenticated context after explicit human completion. Validate identity, account and intended Dot, write through the Host-only owned vault contract, and publish references only. No unsupported claims about atomic provider/vault transactions or rollback.
7. Cancel, viewer disappearance, TTL, crash, mismatch, relink and Host disposal revoke the attempt before bounded full-process teardown. Wait for quiescence and remove only verified owned temporary paths. Late values cannot publish; accepted write ambiguity must be honest.

## Proof before real input

- Synthetic login fixture proves display, click/keyboard/IME/paste, scaling/focus and zero canary leakage into tools/logs/storage.
- Missing/forged auth, foreign Origin, non-owner peer, cross-attempt replay and stale generation fail.
- Private/internal/file navigation, popups, worker/socket paths and general CDP access are denied; browser sandbox stays enabled.
- Cancel/disconnect/TTL/crash/disposal close input/frames and reap the entire owned range.
- Fake-pair commit, ownership/account mismatch and ambiguous publication preserve the existing guarantees.
- Only then may the user enter real credentials in the GUI and complete the separately authorized real-Dot test. A public-page probe or fixture pass is never the final acceptance evidence.

## Source/fixture milestone

Implemented but **not wired to production**: a bounded ephemeral attempt manager, browser-only exact Fetch routes, a private raster/input viewer with a native Fetch adapter, and a fixture-only managed browser factory. Root and mounted paths use explicit trusted deployment origin/basePath, not private bootstrap/path guesses. The UI receives only private raster/status; no general browser/CDP/JS/address/profile tool was added.

The complete Dot package passed **203 tests**, strict typecheck, build, plain Node Host import and source AST rules. The new tests use synthetic browser/runtime/admission boundaries, not a real authenticated carrier or real browser rendering. Scoped lint corrections are part of this milestone, not evidence of live authentication.

A review caught and repaired cleanup failure allowing replacement while old browser quiescence was unconfirmed: cancellation now revokes immediately, returns a fixed failure and prevents a second attempt. Text bounds are shared, including UTF-8 bytes; input is serialized without retries; frame rate/size and streamed bodies are bounded.

The generic RPC alternative was **rejected**, not patched: installed native predispatch buffering and invalid-envelope echo cannot satisfy private input limits. Exact Fetch streaming already supports the required narrower contract; see the Host-gap decision register. No RPC credentials/frames path was implemented.

## Native proof and actual deployment stop boundary

- Genuine native signed-browser-cookie admission now passes in an isolated credentials store through public `connection.apply`/`HostConnectionService`. Forged/missing/wrong-value cookies, Host/Origin violations, genuine API-owner peer, cross-attempt/stale capability and streamed oversize/zero-echo cases are covered. This is not the physical HTTP bridge or provider sign-in.
- A real root-only scratch GUI now verifies default-off consent, in-canvas JPEG decode, trusted pointer/keyboard/text events and mapping, synthetic pixel changes, acknowledged cancellation/cleared input, and a separate status-failure/no-retry path. This uses a synthetic page-I/O port, not an actual remote login browser or provider. CDP's IME commit emitted an untrusted compositionend even in an ordinary textarea; genuine physical IME commit remains unverified and the production trust gate was not weakened.
- The real scratch GUI exposed a native bridge incompatibility: streaming GET constructs a Fetch Request with a body and fails **before the route handler**. All five private operations now use bounded JSON POST; status/frame use strict `{}` and exact Origin checks. Do not weaken into 300 MiB buffered GET or patch core.
- The real local browser proof positively established the same execution world using a fresh nonce file, owned helper PID ancestry and loopback reachability, and captured a genuine in-memory JPEG from managed Chrome155 with fresh profile/raw pipes.
- Correct all-thread descendant inspection then observed **seven non-loopback TCP sockets** owned by the Chrome tree despite browser/page restrictions. The earlier main-thread-only zero count was incomplete and is withdrawn. Browser flags and Playwright routing are not OS network containment. Further login-browser probes were stopped.
- Installed `dsh-sandbox` expressly excludes network/process visibility from its file-policy vocabulary. Production login activation must stop until an independently reviewed deployment-level egress policy is provisioned and proved. See Host-gap decision77; no core patch or bypass is permitted.
- Actual input/form submission and factory cleanup have **not** passed. Cleanup sometimes remained unconfirmed; the proof owner waited for its entire fresh Host/native range to exit, identity-checked and reaped its own retained profile separately. That is not a successful factory cleanup acknowledgment.

## Loopback-only isolation investigation

A fresh unprivileged `unshare --user --map-current-user --keep-caps --net` namespace can be created on this host. Bringing up `lo` inside that new namespace exposes one interface and does not modify host routes. This permits a bounded synthetic-only browser proof without Internet reachability; it is **not** yet a provider authentication network policy. The two bounded isolated runs passed nonce/file/loopback/PID continuity and real JPEG capture, with zero observed non-loopback TCP/UDP sockets. The proof parser was corrected for Chrome's whitespace-rewritten process titles (exact argv-only matching found zero incorrectly). The final run confirmed seven owned renderers with seccomp filtering, no-new-privileges and distinct sandbox user namespaces. The cleanup correction passed against the actual native range and removed its owned scratch without outer profile reaping. **Input still fails**: pointer-down completes in13 ms; pointer-up times out at3001 ms. No text, form submission or provider success is proved. Do not generalize a loopback-only namespace into a working Internet-enabled ChatGPT sign-in environment.

## Resume

Review the smallest viewer port and enrollment seam against these constraints. If the required confidentiality/egress/lifecycle policy cannot be expressed with supported plugin APIs or provisioned isolation, record the concrete unmet boundary in `plans/dsh-host-gaps.md` and stop there—never patch core or relax the policy. Keep the main completion plan open until actual authorized account use is verified.
