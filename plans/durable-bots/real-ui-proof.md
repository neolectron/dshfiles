# Real Dot UI proof — 2026-10-24

## Verified

The user asked to use the tools available on their computer to try the real Dot. Ordinary application/browser interaction, not credential extraction, established:

- The existing desktop ChatGPT/Codex application has the user's named Dot **Yield**, with a real conversation and visible incoming messages.
- Exactly one previously approved message was entered, visually checked before submission, and sent: **DSH connection test — please reply OK**.
- The application displayed the outgoing message as read at16:37 Europe/Paris and Yield replied **OK**. The single-message test authorization has therefore been **used**; do not send it again automatically.
- The normal ChatGPT browser UI in the Business workspace exposes a **Yield** button. Clicking it navigated to `https://chatgpt.com/dots/home`; no guessed private endpoint was called.
- The web UI showed the same test and reply, and an additional incoming Dot message. No unrelated conversation was opened or acted on.
- Reloading that web page retained the test/reply. A read-only DOM summary returned `route=/dots/home`, `title=Yield`, `testOccurrences=1`, `replyOKVisibleAfterTest=true`, `composerPresent=true`.
- No cookies, tokens, browser profile files, private application stores, authorization headers or session API responses were inspected/copied. No vault, container, proxy, credential migration, backend deployment or DSH restart was used.

This is genuine existing-Dot read/send/reply/incoming and UI-reload proof. It is **not** proof of the owned adapter, its protocol account/room verification, its reconnect/checkpoint/renewal, or DSH receiving the messages.

## Evidence and privacy

The desktop result was directly inspected with Computer Use and a private compositor window capture. The Computer Use niri backend had unknown x/y for the window, so its targeted crop failed; the compositor's supported `screenshot-window --id` captured only the requested window. Screenshots are private local evidence, not checked-in assets or PR attachments; they contain unrelated visible conversation context and must not be published. The public plan records only the harmless test, reply and bounded verification facts.

The browser was already signed in. Its workspace selection was temporarily changed while looking for Dot, then restored to the original Business workspace. The original conversation tab's observed route was restored. A newly opened Dot tab remains available for the user. No other message was sent and no task/update visible in Dot was treated as an instruction to this agent.

## Architecture and remaining work

The user corrected the earlier architecture proposal: use a normal reusable **Node.js Bots service with HTTP/streaming interfaces and provider adapters**, deployable in Docker—not a Dot-specific collection of authentication/proxy containers. That correction supersedes treating the old container-permission question as the next decision. The earlier failed fresh-browser public-login probe does not mean ordinary authenticated browser Dot access is unavailable; today's real UI proof demonstrates the opposite.

Do not convert this manual Computer Use path into a required desktop helper. Product onboarding must remain usable from the web GUI. No automated import of the existing signed-in browser session is authorized or implemented. A legitimate supported session handoff/authentication path for the Node backend, real DSH wiring, durable delivery/reconnect and lifecycle checks still require implementation and verification. Preserve the no-live-restart rule and the existing user's configuration.

## Backend authentication check

A subsequent read-only compatibility probe inside the normal Dot web page called only the adapter's fixed `/backend-api/tbo/primary` GET, using normal same-origin browser credentials but **without reading or supplying an Authorization token**. It returned401; its response body was discarded without inspection. This establishes that the visible browser login alone does not authenticate that standalone adapter request. It does **not** establish that a legitimately authenticated backend request would be denied or that the whole protocol remains compatible.

Passive resource timing showed messaging-room live and Dot-thread request families used by the normal page. Only redacted path shapes/counts were inspected; query strings, private IDs, headers and response bodies were omitted. Do not infer response schemas from these paths, add alternate endpoints as a bypass, or extract credentials to make this probe pass.

## Resume

Do not repeat the consumed test or spend another round proving the same visible UI. Use the real `/dots/home` observation and the normal Node-service architecture correction to reassess the missing backend authentication/transport seam. The overall goal stays open; neither fixtures nor this successful manual UI exchange constitute a completed DSH integration.
