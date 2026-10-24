# Service-account deployment review — not authorized for activation

The software channel is verified with synthetic accounts, but the current live deployment does **not** satisfy its transport or provider-acceptance gates. Do not apply the historical local-mode release recipe or restart the shared DSH.

## Observed current target

Read-only assessment on24October2026:

| Item | Observed evidence |
| --- | --- |
| GUI/native listener | `http://192.168.1.94:3198`; native bind `192.168.1.94`, localhost forwarding enabled, no pending network restart |
| Profile | `/home/neolectron/.dsh/profiles/manuel` |
| Native implementation | `/home/neolectron/.local/share/dsh-install/runtime`, inspect-only |
| Native DSH / Cordis | `0.2.1-rc.2` / `4.0.5` |
| Existing owned bundle links | AI Accounts and Secret Catalog resolve under `/home/neolectron/dev/dshfiles`; their package contexts resolve Cordis `4.0.4` |
| New Bots/Dot packages | Not resolved from the serving profile; not installed by this work |
| Profile baseline | [Metadata and hashes](</tmp/bots-deployment-review-qrqRcV/baseline.json>); no profile text, credential or token was copied |
| Provider acceptance | One authorized read-only request with selected existing `codex_manuel` access was known unexpired but returned403 HTML; body cancelled unread, no retry/cookie/refresh/other account/send |

The existing native/owned Cordis identity split is a **baseline**, not a change introduced here. Do not upgrade a global override, replace the shared runtime or assume a tested separate Node process proves every existing Host peer identity. Preserve all current account links, customizations and disabled account seeding. A coherent staged Host boot/import check is required before package promotion.

## Why current localhost forwarding is insufficient

The private authority handler accepts plaintext only when **both actual socket endpoints** are loopback; HTTPS requires actual native TLS. The running listener binds a LAN address, so forwarding a local URL to that listener does not make its local socket address loopback. The handler intentionally does not trust Host rewriting, `Forwarded`, `X-Forwarded-*` or a browser owner cookie as proof of secure transport.

A future operator must choose a supported secure topology: actual native TLS with normal certificate verification, or a genuinely loopback native listener reachable from the intended service namespace. Rebinding/enabling TLS on the running GUI is user-controlled maintenance; it was not performed or implied by this task. Do not bypass verification, weaken the transport fence, add a challenge workaround or expose a real access token over LAN HTTP.

## Activation gates — all required

1. Review the selected DSH account explicitly; never expand the allowlist to other pooled accounts. Native Host `mode: account` requires the exact account ID, risk acceptance, a pinned authority origin and a purpose-key reference.
2. Provision a separate backend authority key through the supported operator/Host reference workflow. It is not the Node control key, DSH launch cookie or upstream OpenAI login. No raw key belongs in the manifest, CLI arguments, Bot configuration/history or Client/tool responses.
3. Verify secure Host↔container reachability and certificate trust without disabling TLS. No DSH home, browser profile, cookie database or refresh-token storage may be mounted into the service.
4. **Verified in isolated GUI:** the remote account-mode owner exposes one nonsecret ID, initially unchecked risks, no token inputs or advertised credential writes; actual acceptance followed by synthetic authority refusal is sanitized. No local Host Bots data or private browser bytes. This is not a successful real-account link or current-GUI activation.
5. Resolve actual provider acceptance through an authorized normal path. The previous403 is a denied request, not proof of its WAF/entitlement/session-binding cause. No further live variants or sends are authorized by this checklist.
6. Freeze a **new** source/bundle/app artifact after all implementation changes. Include AGPL corresponding source/notices and the original MIT notice. Historical Node/container artifacts are proof records, not activated release candidates.
7. Compare the serving profile/package/bundle/style hashes against reviewed baselines immediately before any authorized change. Review source differences in existing owners; do not blindly overwrite AI Accounts, Catalog, shared SDK or styles with this branch.
8. Review a manifest showing exact old/new package links, source/export/module files and bytes. Keep the existing shared stylesheet owner and class identity; do not add duplicate Catalog/API owners or another bot engine.
9. User-controlled activation only. No agent restart/kill, background profile reconciler, global override, push or publication is authorized here.

## Rollback shape

Before authorized installation, retain the original profile package/patch bytes and exact links plus affected public bundle and stylesheet bytes in a private, independently owned backup. Record SHA256 and resolved paths. Do not back up or inspect login/vault/browser values as part of this package rollback.

If activation fails, restore only the reviewed changed links/profile fields/bundle/style bytes. Leave Node data and exclusive ownership lease intact; never steal a stale lease or delete cached conversations to force startup. Stop only the exact service instance that was introduced, preserve its independent data and let the user control Host activation. Recheck the original baseline and all other running work before declaring rollback successful.

This review neither installs nor claims rollback execution. The goal remains open while real account use and current GUI activation are unverified.
