# Bots: offline release preparation, not deployment

**Manuel deployment must wait for the user's explicit maintenance authorization.**
This runbook promotes the verified offline recipe into a versioned preparation
CLI. It does not authorize or perform profile changes, installation, profile
synchronization, authentication, server startup/shutdown, restart or live tests.
The existing Manuel GUI and its policies remain untouched.

## Chosen approach and boundary

Extend the existing verified recipe rather than invent a deployment system.
The [preparation CLI](../scripts/bots-release-prepare.mjs) uses the supported public
`@dshfiles/dshx/tooling` compiler/config/compatibility/target-check APIs. The
[offline verifier](../scripts/bots-release-verify.mjs) uses the public `oxc-parser`
and `postcss` parsers; JSON boundaries use public `JsonText.parse` from
`@dshfiles/dshx/api` with named, validating `zod` schemas. There are
no private SDK source imports, plugin-manager calls, network operations, package
installer invocations or deployment verbs.

The result is **the two Bots bundles, the updated existing Secret Catalog
owner and the existing stylesheet owner's one sheet**, built from source:

- `@dshfiles/bots`: Host/client plus the public adapter and API modules.
- `@dshfiles/bot-openai-dot`: the Dot Host adapter, resolving the same staged
  `@dshfiles/bots/adapter` file and `BotAdapterError` runtime class as the core.
- `@dshfiles/secret-catalog`: the existing owner rebuilt with its public API module
  and safe Host stdin transport. Dot must resolve this exact staged contract, not
  a historical serving or feature-tree copy. This is an update to an existing
  owner, never a second Catalog Loader row. Its public API uses the retained,
  built credential-port JavaScript library. Public Backlog/JJ/folder-picker build
  dependencies are retained explicitly; no additional owner is installed by this CLI.
- `@dshfiles/ui-styles`: one replacement artifact candidate for the existing
  stylesheet owner, not another stylesheet bundle to load alongside it.

Native Cordis **4.0.5** and byte-identical feature/serving shared-runtime artifacts
are mandatory. The CLI refuses a shared-runtime mismatch; it does not rebuild,
copy, replace or patch shared-runtime or stock DSH.

## Inputs and prerequisites

Use the official Node version pinned by [the repository](../.node-version), with
already-installed, built workspace dependencies. Preparation does not install or
repair missing dependencies. Its direct tool dependencies are declared at the
repository root; plugin runtime dependencies resolve from their owning packages,
not accidental root hoists. Run the CLI from the checkout whose source you want
to prepare. The source root needs Git metadata for its tracked-file allowlist and
revision identity; no commit or revision operation is performed.

Only `--source-root` may default: it defaults to the checkout containing the CLI.
Every other root must be explicit:

| Option | Meaning |
| --- | --- |
| `--source-root` | Feature source checkout with Bots, Dot, the stylesheet owner and built dshx. |
| `--serving-root` | Existing customized serving checkout; read-only baseline and CSS source union. |
| `--runtime-root` | Installed stock runtime with native `@deepseek-ai` packages. |
| `--output` | New or empty, disjoint candidate directory. No default and no destructive replacement. |
| `--profile-root` | Optional baseline metadata directory; only its package manifest is hashed, never copied. No other live profile file is read. |

Paths are checked through realpaths, including symlinked ancestors of nonexistent
outputs. Output cannot equal, contain or sit inside source, serving, runtime,
explicit profile or known DSH-home trees. Private/dependency components such as
`local-state`, `browser`, `accounts`, `node_modules`, `profiles`, `.dsh` and `.git`
are forbidden in its path. An output-directory symlink is refused. Choose a
persistent dedicated directory outside all those trees for a candidate you intend
to retain; temporary proof directories are not deployment storage.

**Never point the new CLI at the earlier ignored staging directory inside the
feature checkout.** It is protected by the source-root overlap rule. The earlier
recipe and its compiled evidence remain untouched.

## Prepare a new candidate

Substitute the absolute paths for the machine being prepared. This is an offline
build, not a launcher; the same commands must not be repurposed into an automatic
apply pipeline.

```sh
SOURCE_ROOT=/absolute/feature-checkout
SERVING_ROOT=/absolute/customized-serving-checkout
RUNTIME_ROOT=/absolute/installed-stock-runtime
CANDIDATE=/absolute/disjoint-empty-candidate

node scripts/bots-release-prepare.mjs prepare \
  --source-root "${SOURCE_ROOT:?}" \
  --serving-root "${SERVING_ROOT:?}" \
  --runtime-root "${RUNTIME_ROOT:?}" \
  --output "${CANDIDATE:?}"
```

When baseline hashes for a specific profile are desired, additionally pass
`--profile-root /absolute/existing-profile`. No profile discovery, patch reading,
credential inspection or account lookup occurs.

Before its first write, the CLI validates roots, tracked inputs and retained
installed dependency targets. It copies only allowlisted tracked package source,
build configuration, public package metadata and owned bundle registration
patches, plus LICENSE/provenance/README, source fixtures and committed synthetic
PNG documentation assets. Those legal notices and source docs are preserved
verbatim, with an explicit retained-source-root documentation link for
repository-wide links. It never copies existing `dist`, `node_modules`, local
state, account files, live profile patches, browser data or untracked package
source. Current tracked source bytes (including dirty edits) are hashed, not
substituted with old HEAD artifacts. The manifest records **dirty status,
changed tracked paths and untracked names**; HEAD is not presented as a clean
source claim. Untracked package source is omitted; the executing recipe remains
an explicit hashed tool input during uncommitted development. Source file
symlinks are refused.

The stylesheet candidate imports the **serving** plugin-ui CSS source unchanged,
preserving that source's imports, theme, custom variants and existing Tailwind
`@source` union. It adds an explicit Tailwind `@source` for staged Bots source.
After compilation, parsed individual selectors from the serving artifact must all
exist in the new single sheet. Missing selectors stop preparation; merely adding
Bots selectors is not sufficient. This is selector preservation, not proof that
every property's cascade or browser appearance is identical.

### Existing outputs and failures

There is no `--force`, cleanup, repair, replace or delete option:

- Nonempty **unowned** output is refused before source copying or compilation.
- A complete owned candidate is checked read-only, never rebuilt in place.
- An incomplete, changed, corrupt or stale owned candidate is refused. Choose a
  **new empty output**, retaining the old one for inspection or rollback.
- A failure after initial creation may leave an owned incomplete candidate.
  The CLI does not delete it or any earlier candidate.

## Frozen inventory and repeatable checks

A successful candidate contains copied sources, generated package artifacts,
compiler/import/selector evidence, an ownership marker, a manifest and checksums.
The manifest records the source revision, exact source bytes, baseline metadata,
artifact hashes, dirty/untracked source state and direct dependency targets'
**scoped code/metadata** hashes. Owned source is Git-tracked; runtime code is
selected from declared published locations. Arbitrary logs, databases, unknown
JSON and state files are not opened or hashed. Legitimate nested source directories
such as `src/accounts` or `src/browser` remain code, not blanket exclusions.

The manifest explicitly reports residuals: transitive package stores and non-code
runtime assets must be retained unchanged, but are **not a complete
content-verified dependency closure**. These are immutable snapshots: checking
does not regenerate evidence, silently widen its scope or bless changed files.

```sh
node scripts/bots-release-prepare.mjs check \
  --source-root "${SOURCE_ROOT:?}" \
  --serving-root "${SERVING_ROOT:?}" \
  --runtime-root "${RUNTIME_ROOT:?}" \
  --output "${CANDIDATE:?}"
```

Use exactly the same roots, including optional profile root, as preparation.
Checking validates scoped inventories, dirty/untracked source state, unexpected
candidate files and symlinks, all captured input/direct-code/metadata hashes,
native Cordis identity, public API/Host imports, canonical
adapter/error-class identity, unchanged shared-runtime and selector retention.
It does **not** invoke a compiler, import a Vite config, rewrite a manifest,
refresh timestamps or mutate the candidate. Hash checks are local integrity/drift
checks, not a cryptographic publisher signature. They are **pre-maintenance**
baseline checks: a later authorized deployment that changes the serving sheet or
profile metadata intentionally invalidates those baseline hashes. Do not rewrite
the preparation manifest to hide that change; preserve it with the protected
maintenance/rollback record.

**This is a local-links candidate, not a portable release archive.** Retain:

1. The entire candidate at its original absolute path.
2. Every manifest-listed real dependency target, with recorded code/metadata
   hashes unchanged. Also retain its transitive package stores and non-code
   runtime assets; those are explicit retention requirements, not fully
   content-verified artifacts.
3. The source, serving and native runtime roots used to build it.

Dependency directories are linked read-only by convention, not copied or made
self-contained. Do not install inside a candidate, retarget Dot to feature-tree
Bots, clean its referenced package stores, move it or treat it as a tarball.
Package-manager changes, source edits or dependency updates invalidate its checks
and require a fresh candidate. Preparation never changes a dependency target.

## Verification evidence and limits

Focused regression checks:

```sh
node --test scripts/bots-release-prepare.test.mjs
node scripts/bots-release-prepare.mjs --help
```

The [regression suite](../scripts/bots-release-prepare.test.mjs) covers realpath and
overlap refusals, symlinked ancestors, private paths, preexisting-output
preservation, meaningful tracked TS/TSX fixture sources, stale/private/untracked
exclusion, verbatim license/provenance/README/committed synthetic image
preservation, private-state read refusals and parsed CSS selector retention/refusals.

The earlier ignored offline candidate already demonstrated **1,774 existing
selectors retained, 14 added**, native Cordis 4.0.5 imports and shared adapter
identity. That evidence is offline only and is not a new live test or a claim
that Bots is deployed. A fresh invocation prints its own counts and import
results; retain those with its immutable manifest.

Unverified by this CLI: Host activation, browser rendering/computed styles,
real-account authentication, real private-protocol send/receive/reconnect, and
actual Manuel deployment. No browser, account, credential or protocol operation
is needed to prepare or check a candidate. The maintain-verify-dsh trigger review
is clean for this source-only CLI: it changes no scratch launcher, profile seed,
feature catalog or UI path, so it does not authorize a live pass.

## Future human-controlled maintenance — not performed now

The current customized Manuel runtime has Host HMR/profile synchronization
intentionally disabled. Preserve those policies and customizations; enabling
HMR, applying a web seed or replacing the serving checkout wholesale is not an
offline preparation step. See [profile installation constraints](profile-installs.md)
and [reload boundaries](plugin-reload.md).

Only after explicit user authorization:

1. Recheck the candidate and current baseline; arrange a maintenance window and
   quiesce active work. A human stops the existing runtime through its normal
   controls, not this CLI.
2. Preserve protected rollback copies of only the affected profile
   manifest/lock/workspace and existing stylesheet artifacts. No credential,
   account, browser or live patch backups are created by preparation.
3. Review an **additive-only** change: add the candidate Bots and Dot `link:`
   dependencies and bundle names, retaining every existing row, dependency,
   order, profile customization, disabled sync policy and patch. Replace only
   the existing stylesheet owner's built artifacts, never add another sheet.
   Keep shared-runtime and native core unchanged.
4. Have a human perform the narrowly reviewed profile reconciliation/install
   using its existing matching package-manager version, then start the **same**
   existing launcher and refresh the **same** GUI. No broad profile sync or
   arbitrary local-path `pnpm add` workaround is implied.
5. Read activation diagnostics, confirm both Bots rows and API ownership, the
   one shared sheet and preserved existing UI before claiming deployment.
6. A separate, explicit user authorization is required for real linking using
   vault **references**, acceptance of broad-account/private-protocol risks,
   and a real send/receive/reconnect proof. Never put credential values in a
   candidate, form snapshot, command, manifest or documentation.

Rollback is also human-controlled maintenance: stop the same runtime, reconcile
any concurrent edits, restore only the affected protected files/artifacts and
original installation, then start the same launcher. If linking later happened,
disconnect local workers first; retain cache/outbox/ledger and vault references
unless the user separately authorizes local removal. Remote bot work is not
removed by restoring local deployment files.
