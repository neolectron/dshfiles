# Private access for the existing Yield

**Historical constraint, superseded:** the user later explicitly approved the Incentive workspace association. The existing tunnel was connected and genuine Yield health/read calls succeeded; see [current cloud acceptance](cloud-acceptance.md). No public HTTPS OAuth alternative was built. The findings below remain valid analysis of the earlier no-workspace-association requirement, not a current instruction to undo the authorized connection.

Read-only findings,26October2026. The user chose **keep private**: no Incentive workspace grant and no Yield activation. The later request to continue was treated as investigation within that constraint, not permission to reverse it. The deployed gateway/tunnel and their permissions were left unchanged.

## Result

There is **no verified supported tunnel path for the existing workspace-bound Yield under the current no-workspace-association constraint**. There is a documented alternative: an HTTPS MCP endpoint protected by individual-user OAuth. That changes network exposure and requires a new authentication layer, so it has not been implemented or enabled.

"Private network endpoint" and "only my account can access the data" are different requirements. The current OpenAI tunnel provides the first, but the present workspace cannot attach it without satisfying OpenAI's context eligibility. Owner-only OAuth on an HTTPS endpoint can enforce the second; the HTTPS URL itself remains publicly reachable.

## What is verified

1. OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels.md) says organization/workspace associations "define every OpenAI context that should be allowed to find or use the tunnel." For ChatGPT testing it instructs operators to associate the target workspace, not only a Platform organization. Association is therefore not documented as merely a directory/picker setting.
2. The installed client is0.0.18. Its [versioned permissions guide](https://github.com/openai/tunnel-client/blob/v0.0.18/docs/permissions.md) separately documents Read/Manage/Use and a predefined per-tunnel User role for Read+Use. It requires Use on the principal whose runtime key or ChatGPT connector uses the tunnel. This does not document a named-user exception to workspace eligibility.
3. The [public RBAC guide](https://developers.openai.com/api/docs/guides/rbac.md) describes permissions as a union of assigned roles. Giving one user a role is not evidence that every other user's inherited permissions have been denied. Public role-assignment documentation examined here does not establish a tunnel-ID-scoped exclusive user allowlist or the complete interaction with ChatGPT workspace membership.
4. The normal account UI exposes organization Owner/Reader role presets. No role, assignment, organization/workspace association, key or plugin was changed during this investigation. UI absence is not proof that no other supported control exists; it is simply not a verified solution here.
5. The earlier ChatGPT connector attempt was denied before a command reached the local tunnel dispatcher. The local gateway's real native task proof,50tests and successful polling do not substitute for genuine Yield access.

## Supported alternative to investigate after approval

The [ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt.md) supports a public HTTPS MCP endpoint as an alternative to Secure MCP Tunnel. The [authentication guide](https://developers.openai.com/plugins/build/auth.md) specifies OAuth2.1 resource-server authentication on behalf of individual users.

An owner-only design would have:

```text
Existing Yield → HTTPS MCP authentication boundary → existing private gateway → native DSH
                    OAuth identity + exact owner allowlist
```

- A maintained OAuth2.1/MCP implementation and an approved identity provider, rather than a hand-written login or bearer-secret URL.
- Verification of issuer, resource/audience, token validity/expiry and scopes, plus an exact approved user identity. All other identities fail closed.
- Correct protected-resource/authorization-server discovery, PKCE and client registration/identification as required by the supported OpenAI client.
- A distinct resource and permission grant; Discord access tokens/permissions are not automatically DSH authorization.
- A protected final hop to the existing loopback gateway. Its local credential and DSH owner connection remain private; caller-supplied identity headers cannot grant authority.
- Personal plugin installation only, not workspace publication. Account/workspace custom-MCP policies still apply and must be tested; this is a supported architecture, not an observed working Yield connection.

A public URL with OAuth does **not** mean anonymous or team-wide task access, but it does mean a publicly reachable authentication endpoint. No domain, reverse proxy, public route, OAuth provider/client, credential or code change for this alternative has been authorized or created.

## Not acceptable as substitutes

- Binding the declined workspace merely to test whether access is harmless.
- Assuming a personally installed plugin isolates transport authorization.
- Granting a named role and assuming it overrides every inherited grant.
- Using another token, account, raw hosted URL or private API to bypass the denied connector.
- Cloning/moving Yield into a different workspace without proof that its existing identity/memory is preserved.
- Adding a Codex conversation relay, a backend browser, or an unauthenticated public MCP endpoint.

## Next decision

Would the user accept **a publicly reachable HTTPS endpoint whose task access is restricted to their own authenticated account**? If yes, obtain approval for the authentication layer and deployment/identity-provider choices before building it. If both public reachability and workspace association remain disallowed, stop at the documented tunnel eligibility gap; do not claim the current Yield can connect.
