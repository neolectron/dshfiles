# Synthetic native Dot auth verification

This is **not production onboarding**. It compiles the existing same-owner `AuthViewer`, `createAuthFetchTransport`, `AuthAttemptManager` and `registerDotAuthRoutes` source into a temporary verification-only plugin, then boots the real native DSH Web GUI in a fresh scratch home. It never opens a provider, reads a credential, calls a vault, accesses a live profile, or contacts a non-loopback browser origin.

## Run

Use the installed official-Node CLI and an explicit browser override. Neither value is inferred from a live instance.

```sh
DOT_AUTH_VERIFY_DSH_CLI=/absolute/installed/@deepseek-ai/dsh/lib/bin.js \
DSHX_E2E_CHROMIUM_EXECUTABLE=/absolute/path/to/google-chrome-stable \
node tooling/dshx/e2e/fixtures/dot-auth-run.mjs
```

The runner uses an owned temporary CLI wrapper so the scratch environment can find `dsh` without a global install. The normal E2E harness owns the Host and browser; fixture cleanup closes its Host before deleting any compiled artifact. No server replaces the live GUI.

## Public composition requirements

- `@dshfiles/dshx/tooling`: `resolveDshxConfig`, `buildHost`, `buildClient` and ordinary public `defineConfig` metadata.
- Native Host services: `connection.fetch.register`, `connection.admit`, `connection.browserPeer`, and `webServer.getOrigin()` for the canonical actual external origin. No synthetic `dsh.internal` inference.
- Native Client services: public `defineClient` plus `sidebar.panellist` and `main` registrations. Shared React/UI identities are supplied through `@dshfiles/shared-runtime` and the public `pluginUiVite` plugin.
- `bootComposedPluginProfile`: `additionalBundleIds` uses the temporary package's real ID; `seedHome` links that package only inside the fresh scratch profile. An absolute directory Cordis row is **not** a package import in Node ESM.
- The trusted fixture deployment sets `basePath: '/'` explicitly. No private Core imports, augmentations, casts, source exports, SDK changes, production entry points, or production modules are added for this test.

The fake `BrowserPort` serves known 640×320 red/green JPEGs. Only synthetic counters/coordinate facts are written to the disposable home; input strings and controller capabilities are not retained. A Node-only random error canary exercises fixed error sanitization. Network observation retains only counters and fixed operation/status labels, not bodies, header values or full URLs. Trace recording is disabled.

## Journeys and evidence

The Gherkin journey is `dot-auth-viewer.feature`; its selectors and assertions live in `dot-auth.steps.ts`. It checks native clean boot, unchecked consent/disabled Start, actual JPEG canvas decode, image-space coordinate mapping, Playwright pointer and keyboard events, trusted browser `beforeinput` from keyboard typing and Unicode text insertion, synthetic image changes, acknowledged cancellation and cleared/disabled private surfaces. A separate scenario labels expected native status/cancel refusals and checks no retry with the browser clock advanced ten seconds.

Screenshots are synthetic and deliberately labelled **SYNTHETIC DOT AUTH FIXTURE**. A screenshot is not evidence of a real sign-in. Summaries and screenshots are produced under the normal Playwright test-results/evidence directories.

The retained pre-fix reproduction is `dot-auth-native-get-repro.json`: native streaming GET was rejected before route-handler entry. The production owner fixes the wire policy; the fixture never substitutes a passing transport.

## Explicit limits

**Root-only native deployment proof.** A mounted reverse-proxy prefix is not exercised by this fixture. The transport's trusted explicit base-path contract must not be described as mounted native deployment evidence.

**Native physical IME commit unverified.** The independent ordinary-textarea probe `dot-auth-ime-probe.mjs` shows Chrome 155 CDP `Input.imeSetComposition` produces trusted start/beforeinput but its `Input.insertText` commit emits `compositionend.isTrusted=false`. The viewer correctly rejects that commit. No production trust gate was weakened. The passing GUI journey does not claim IME proof.

**No real remote login.** This proves only the raster viewer, private browser-owned HTTP channel and synthetic input/cancellation lifecycle. It does not prove provider success, account selection, credential capture/publication, vault permissions or production UI integration.
