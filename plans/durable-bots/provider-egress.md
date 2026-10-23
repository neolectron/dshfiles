# Provider login egress: deployment decision gate

## Status

Local synthetic browser input, form POST, sandbox and full cleanup pass in a new loopback-only user/network namespace. That namespace has no Internet route and cannot authenticate ChatGPT. No production login policy or working account link is implied.

The user has authorized broad-account linking and one exact harmless test, and requires web-GUI-only sign-in. A separate question asks permission to download/build pinned local browser/proxy images and create dedicated Docker networks. **That question remains unanswered; no provisioning is authorized by timeout.** Docker network creation may alter Docker-managed host bridge/firewall state even though we never manually change host routes. No existing browser profile, host desktop, Docker socket or broad host filesystem may be mounted into a login container.

## Adopt decision

Adopt a maintained **OpenSSL-enabled Squid** transport with a restricted browser deployment, rather than inventing a CONNECT proxy or patching DSH core. Installed `@deepseek-ai/dsh-http-proxy` only selects process-global outbound proxy routing; it supplies no listener, ACL, DNS pinning or confinement. Do not install its global dispatcher merely for this attempt.

The Docker server answers version29.8.1. Squid, tinyproxy, socat, slirp4netns and pasta are absent. No image digest, OpenSSL feature set or complete runtime policy has been selected or proved.

### Verified image caveat

Canonical's inspected [Squid rock definition](https://raw.githubusercontent.com/canonical/squid-rock/main/squid/7.2-26.04/rockcraft.yaml) describes GnuTLS and stages `squid_standard`; its [distro slice](https://raw.githubusercontent.com/canonical/chisel-releases/ubuntu-26.04/slices/squid.yaml) uses `squid-gnutls`. Squid's [peek/splice directive](https://www.squid-cache.org/Doc/config/ssl_bump/) requires an OpenSSL-enabled build. Do not assume `ubuntu/squid:latest` provides that feature. Select a maintained distro OpenSSL build only after permission, provenance, version and digest checks; do not silently build a custom security stack.

## Candidate topology, not implemented

- Disposable sandboxed browser container on a dedicated internal network; dedicated proxy on that network plus an outbound network.
- No published ports, host networking, privileged mode, host namespaces, Docker socket or existing profile mounts. Control stays authenticated and private to the owning attempt.
- **Internal Docker networking is not enough.** Docker documents host-gateway access and same-network connectivity: [internal network semantics](https://raw.githubusercontent.com/docker/cli/master/docs/reference/commandline/network_create.md), [DNS services](https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/network/_index.md). Configure and verify browser-namespace default-deny output except the exact proxy/control paths; deny embedded DNS, UDP/QUIC and IPv6 unless an equivalent complete policy is proved. Drop browser network-administration/raw-socket capabilities before it starts. Do not weaken the Chromium sandbox to make containers work.
- The proxy must not act as a general packet router. Proxy failure or cancellation must never switch the browser to direct access.

## Policy prerequisites

1. Review exact required authentication hostnames; do not permit blanket OpenAI/CDN/cloud wildcards. No extra provider endpoint, proxy rotation, automation disguise or challenge bypass.
2. CONNECT only to approved names on443; reject malformed names, IP literals, userinfo and other methods/ports. Resolve trusted A records at setup, reject non-global/private/reserved/mapped/ambiguous answers, pin accepted public IPs for a short attempt, and prevent runtime DNS fallback/rebinding. IPv4-only is acceptable if IPv6 is actually denied, not merely ignored. Relevant Squid contracts: [hosts_file](https://www.squid-cache.org/Doc/config/hosts_file/), [ACLs](https://www.squid-cache.org/Doc/config/acl/).
3. Ordinary CONNECT authority is not proof of inner TLS identity. A reviewed OpenSSL build can peek visible ClientHello and splice without decrypting application data. Missing/mismatched SNI must deny, not fall back silently to the CONNECT host. Squid `ssl::server_name --client-requested` alone can fall back; verify actual SNI presence/equality and helper failure behavior if an [external ACL](https://www.squid-cache.org/Doc/config/external_acl_type/) is required.
4. No installed interception CA, certificate-error suppression or TLS MITM. ECH and encrypted HTTP authority limit what a non-decrypting proxy can assert; do not claim full application-origin equality. Resolve that policy limitation explicitly before production activation.
5. Disable stock access/request logs, cache/profile persistence, packet traces and protocol diagnostics. No URLs, query strings, headers, credentials or ClientHello dumps in agent tools/history. [Squid logging contract](https://www.squid-cache.org/Doc/config/access_log/).
6. Container CLI exit is not proof the container stopped. Cancellation must revoke the attempt first, stop/wait/remove only its owned containers and scoped networks, and verify profile/process cleanup. No broad Docker prune or unrelated daemon/container changes.

## Acceptance before a real login

Synthetic checks must deny direct public/private/host-gateway IPv4/IPv6 TCP, UDP and DNS; allow only the approved proxy route; reject unknown names, private/mapped/rebinding answers, forbidden ports and missing/mismatched SNI; fail closed if the proxy stops; and prove deadline/cancel cleanup. Preserve the existing native owner/capability/Origin and input privacy checks.

Only after infrastructure authorization and these checks may the user complete a fresh ordinary sign-in in the GUI. The earlier first public login document returned403; no account/session data was read. A visible normal challenge may be completed by the human, but a provider denial remains a stop, never a reason to evade controls.

## Resume

Wait for the pending local-container permission decision. If declined, retain the verified local components and report the exact missing production infrastructure instead of asking for desktop helpers or raw tokens. If approved, select and verify the maintained images and enforcement policy before any provider request. Do not promote the source-only viewer or claim the overall project complete while authenticated account use remains unverified.
