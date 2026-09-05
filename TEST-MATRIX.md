# Handoff: hierarchical upgrade-shape test matrix

Task: extend the property-based test in `src/index.test.ts` from a workspace-shape generator into a
hierarchical matrix over **upgrade shapes**. All research below is already verified against the installed
Renovate (`node_modules/renovate` @ 44.46.3) — do not re-derive it, and do not trust general knowledge of
Renovate over the file references given here.

## Where things stand

- 109 tests, 3 files, 100% on all four coverage thresholds. `pnpm run test` fails on any uncovered branch.
- Production: `src/index.ts` (235 lines), `src/schema.ts`, `src/managers/npm.ts`, `src/managers/cargo.ts`.
- Resolution pipeline: `run` → `mapUpgradesToPackages` → `resolvePackageByUpgrade` (ownership) +
  `resolvePackagesBySharedUpgrade` → `resolveNpmPackagesBySharedUpgrade` / `resolveCargoPackagesBySharedUpgrade`.
- Property test lives at `src/index.test.ts:2250`, `describe("Generated workspaces")`, `WORKSPACE_COUNT = 120`
  (line 1858), 30s timeout.

Key generator symbols:

| symbol | line | role |
| --- | --- | --- |
| `FixturePackagePlan` / `FixturePlan` | 1835 / 1842 | what a generated workspace varies |
| `fixturePlanArbitrary` | 1916 | the fast-check arbitrary |
| `createFixtureWorkspace` | 1958 | materializes a plan on disk |
| `buildUpgradeList` | 2055 | **builds the upgrades — this is what needs new dimensions** |
| `buildExpectedPairList` | 2103 | expected package↔dependency pairs |
| `assertWorkspaceChangesets` | 2173 | the 12 invariants |
| `CHANGESET_PATTERN` / `BODY_PATTERN` / `FILE_NAME_PATTERN` | 2024–2027 | parsing what got written |

## Step 1 is a blocker — do it first

`BODY_PATTERN` (line 2025) hard-codes the default template's `{{else}}` branch:

```js
/^Updated `(?<dependencyName>[^`]+)` (?:from `(?<fromVersion>[^`]+)` )?to `(?<toVersion>[^`]+)`\.$/u
```

That is why `buildUpgradeList` pins `updateType: "minor"` — any other value renders a different sentence and
invariant #4 fails. Split it:

- **matrix asserts structure**: the body names the dependency (`` /`(?<dependencyName>[^`]+)`/ ``). That is all
  invariant #7 needs, since it only extracts `dependencyName` to build the pair list.
- **examples assert wording**: the exact sentence per template branch already lives in the 37 tests under
  `describe(writeChangesets)` and `describe("Default template")`. Leave those alone.

Do **not** branch `BODY_PATTERN` per `updateType`. That reimplements the template inside the assertion, and then
the test only proves two copies of the template agree.

## The hierarchy

`manager` selects the manifest format, the legal depTypes, and the consumer-side declaration syntax. Those three
are not independently choosable. Three levels: **manager → shared-declaration kind → variant**.

```text
npm · bun · deno                       (there is NO "pnpm" manager — see Verified facts)
├─ catalog       matched by VALUE; ignores hasOwningPackage
│  ├─ spelling   pnpm.catalog.<name> | yarn.catalog.<name>
│  └─ name       default | named
├─ override      matched by PRESENCE; gated on hasOwningPackage
│  └─ spelling   overrides | pnpm.overrides | pnpm-workspace.overrides | resolutions
└─ none          ordinary dependency groups → ownership

cargo
├─ workspace inheritance
│  ├─ table      dependencies | dev-dependencies | build-dependencies | target.'cfg(…)'.dependencies
│  ├─ syntax     x.workspace = true | x = { workspace = true } | [dependencies.x] workspace = true
│  └─ crate site beside package.json | nested under the package | inside a nested package
└─ none          ordinary tables → ownership

everything else — docker family, github-actions, gomod, pep621, mise, pyenv, custom.*
└─ none
```

**The two middle nodes differ in behavior; most leaves do not.** Catalog vs override is a real fork — value
matching versus presence matching, and only overrides consult `hasOwningPackage`. But the four override
*spellings* go through one `includes()` and behave identically, as do the two catalog spellings and Cargo's three
consumer syntaxes (all reduce to `typeof entry === "object" && entry.workspace === true`).

So **spellings are a sample-one level, not a cross-product level.** Draw one uniformly and move on. Crossing all
four override spellings against workspace kind × updateType × topology quadruples runtime for zero new behavior.

The exception is Cargo's **crate site**, which looks like a spelling but is not — the three values take different
paths through the subtree walk and its pruning, and it is where a live bug hid (see below).

## Dimension inventory

Tier 0 — **batch**, wraps everything. One `run` receives N upgrades. Values: single · many-same-shape ·
many-mixed-shape. Currently many-same-shape only. Only reachable in batches: the `new Set` dedupe in
`mapUpgradesToPackages` when two upgrades resolve to the same package, and content-hash collision when two render
identical bodies. Production is always batched — `renovate.json` uses a catch-all group plus
`executionMode: "branch"`.

Tier 1 — **workspace shape** (orthogonal):

| dimension | values | status |
| --- | --- | --- |
| workspace kind | solo · mono · mono-with-root-as-member | **PINNED to mono** |
| topology | package count, nesting depth | covered |
| versionability | private × ignored × versionless × `privatePackages.version` | covered |
| manifest location | in a package · in a nested package · outside every package | covered |

Workspace kind matters most and is entirely absent. `createFixtureWorkspace` always writes a
`pnpm-workspace.yaml` listing every package plus a private root that is never a member, so `hasOwningPackage` is
`false` for every root manifest in all 120 runs — the override branch has never been generated in either state.

Tier 2 — **manager hierarchy**, above. Generated today: `npm` only, 2 of 4 dependency groups, pnpm catalogs only.
Never generated: any override depType, Yarn catalogs, `bun`/`deno`, all of Cargo, all ownership-only managers.

Tier 3 — **upgrade attributes** (orthogonal to tier 2):

| dimension | values | status |
| --- | --- | --- |
| `updateType` | 11, incl. `lockFileMaintenance`, `digest`, `pinDigest` | **PINNED to `minor`** |
| name shape | `packageName === depName` · differs (npm alias, override selector) | **PINNED to equal** |
| presentation | `sourceUrl` ± · `isVulnerabilityAlert` + `vulnerabilitySeverity` | **PINNED to absent** |
| template | default · custom file | **PINNED to default** |

`datasource` is a separate axis and irrelevant to resolution — 36 managers use `docker`. It reaches the changeset
only via `sourceUrl`.

## Illegal vs interesting cells

A flat cross-product gets these wrong; the hierarchy is what avoids them.

Illegal — the generator must not emit:

- `cargo` × `pnpm.catalog.*`
- `lockFileMaintenance` × any `depName` (it carries none; also contributes no pair, so exclude it from
  `buildExpectedPairList`)
- any ownership-only manager × a shared depType it does not emit

Interesting negatives — assert the shared path **declines**:

- `npm` × `workspace.dependencies` → nothing (the Cargo manager veto)
- `custom.regex` × an npm-looking depType → currently **is** fanned out; see the open decision below
- manifest outside every package × anything → nothing, silently

The only genuine two-dimension interaction: **workspace kind × npm override depType**. That is the one cell where
`hasOwningPackage` changes the answer. Everywhere else tier 1 and tier 2 are independent.

## Build order

1. **Split `BODY_PATTERN`.** Prerequisite for step 4. No new dimension, no behavior change.
2. **Workspace kind.** Add solo and root-as-member to `FixturePlan` / `createFixtureWorkspace`. Biggest gap; it is
   the `hasOwningPackage` flip. Acceptance: an override upgrade against the root manifest expands to consumers in
   mono and resolves to the root package in solo.
3. **Cargo into the generator.** Crates at varying depths, with and without a sibling `package.json`. Acceptance:
   a `[workspace.dependencies]` upgrade names every package containing an inheriting crate, once each. This is the
   shape that hid the live bug.
4. **`updateType`.** Cheap after step 1. Include `lockFileMaintenance` (no `depName`, no pair, own template
   branch). Would have caught a crash that shipped.
5. **Ownership-only representatives.** One manager each from `dockerfile`, `docker-compose` (emits *no* depType),
   `github-actions`, `gomod`, `pep621`, `custom.regex`. Acceptance: a changeset is written by ownership and the
   shared path returned `null`.
6. **Batch heterogeneity.** Mix managers and updateTypes in one payload.

Steps 2 and 3 have live bugs behind them. Step 1 is a prerequisite. Steps 4–6 are cheap once the plumbing exists.

### Sampling

The tree is large — roughly 3 workspace kinds × 11 updateTypes × ~14 depTypes × 4 manifest locations before
topology. 120 unweighted runs will oversample the middle and may never hit `override × solo`. Stratify: draw the
manager subtree first, then the declaration kind from that manager's legal set (including `none`), then one
variant. Consider a small exhaustive pass over the high-value pairs separately from the random one.

## Verified Renovate facts — do not re-derive

All references are relative to `node_modules/renovate/dist`.

**There is no `pnpm` manager.** `npm` owns `package.json`, `pnpm-workspace.yaml`, and `.yarnrc.yml`
(`modules/manager/npm/index.js`). pnpm catalogs, Yarn catalogs, and npm overrides all arrive as `manager: "npm"`.

**npm depTypes** are enumerated in `modules/manager/npm/dep-types.js`: `dependencies`, `devDependencies`,
`optionalDependencies`, `peerDependencies`, `engines`, `volta`, `resolutions`, `packageManager`, `overrides`,
`pnpm`, `pnpm.overrides`, `pnpm-workspace.overrides`, plus dynamic `pnpm.catalog.<name>` and `yarn.catalog.<name>`
built by `extractCatalogDeps` (`modules/manager/npm/extract/common/catalogs.js:12`).

**`bun` and `deno` emit npm depTypes.** Both import `extractPackageJson` from
`modules/manager/npm/extract/common/package-file.js` (`modules/manager/bun/extract.js:4`,
`modules/manager/deno/compat.js:6`). This is why the npm resolvers gate on depType and *not* on manager — an
`["npm","bun","deno"]` allowlist would silently break the moment Renovate adds a fourth.

**Catalogs come only from `npm`.** `extractCatalogDeps` is reached only from `npm/extract/pnpm.js` (for
`pnpm-workspace.yaml`) and `npm/extract/yarn.js` (for `.yarnrc.yml`), neither of which `bun`/`deno` import.

**`workspace.dependencies` is Cargo-only.** Emitted at `modules/manager/cargo/schema.js:65` via
`withDepType(CargoDeps, "workspace.dependencies")`. Nothing else under `modules/manager` produces it. Because the
string is generic, the Cargo path keys on `manager === "cargo"` — this is deliberate, unlike the npm side.

**`packageName` is always set on an upgrade.** `workers/repository/process/fetch.js:21` does
`dep.packageName ??= dep.depName`, and line 102 writes the normalized deps back (`pFile.deps = await all(queue)`).
If it is still empty, lines 23–26 set `skipReason: "invalid-name"` and no updates are generated. It is unset only
at *extract* time. The `packageName ?? depName` fallbacks in the resolvers are therefore defensive, exercised only
by hand-built fixtures.

**`depName` is absent only for `lockFileMaintenance`.** Built from `packageFileConfig` at
`workers/repository/updates/flatten.js:96-106` with no dep merged in. Remediations carry `depName`
(`workers/repository/process/vulnerabilities.js:152`).

**`packageFile` is never absent.** Required on Renovate's own type
(`modules/manager/types.d.ts:73`: `interface PackageFile { packageFile: string }`), and every upgrade descends
from `mergeChildConfig(managerConfig, packageFile)` at `flatten.js:53`. `src/schema.ts` enforces this with
`z.string()`, so a malformed payload is rejected at the boundary.

**`displayTo` is empty only for `lockFileMaintenance`.** `workers/repository/updates/generate.js:140-151` assigns
it in three branches and explicitly excludes `isLockFileMaintenance` from the third, then defaults to `""`. Every
other upgrade gets a value from `newDigestShort`, `newVersion`, or `newValue`.

**Invalid names never reach us.** `extractDependency`
(`modules/manager/npm/extract/common/dependency.js`) rejects anything failing
`validateNpmPackageName(depName).validForOldPackages` with `skipReason: "invalid-name"`, and `fetch.js:22` returns
before generating updates. `parseDepName` strips a version from the key only when `depType === "resolutions"`.

**Only `pnpm.overrides` gets a parsed clean `packageName`.** `extract/common/package-file.js:59-62` uses
`parsePkgAndParentSelector(overridesKey).targetPkg.name`. Plain `overrides` keys pass through verbatim.

**Custom managers are prefixed.** `modules/manager/index.js:64` strips `custom.`, so ids are `custom.regex` and
`custom.jsonata`. Their depTypes come from a user-supplied `depTypeTemplate` and are therefore **arbitrary text** —
the only manager class where depType cannot be enumerated.

**uv has no shared declaration.** `pep621` depTypes are `project.dependencies`,
`project.optional-dependencies`, `dependency-groups`, `build-system.requires`, `requires-python`,
`tool.uv.dev-dependencies`, `tool.uv.sources`, `tool.pdm.dev-dependencies`. A member's
`[tool.uv.sources] x = { workspace = true }` gets `skipReason: "inherited-dependency"`
(`modules/manager/pep621/processors/uv.js:43`) and never becomes an upgrade. Unlike Cargo, there is no root-level
version table producing one. No `override-dependencies` / `constraint-dependencies` extraction either. Note
`"uv"` is *not* a manager id in this version.

**Go has no shared declaration.** `gomod` depTypes: `require`, `indirect`, `replace`, `golang`, `toolchain`,
`tool`. It matches only `/(^|/)go\.mod$/` — there is no `go.work` manager, and a `replace` in a non-main module is
ignored by Go itself.

**Docker is a datasource, not a manager.** 36 managers use it. `dockerfile` emits `final`, `stage`, `syntax`;
**`docker-compose` emits no depType at all**; both set `packageName: depName`
(`modules/manager/dockerfile/extract.js:64`), so Docker is not a source of name divergence.

**The `local` platform is permanently dry-run.** `modules/platform/local/index.js` forces
`dryRun: "extract" | "lookup"` and stubs every platform operation, so `postUpgradeTasks` never fire — you cannot
capture a production payload with it. Recorded payload fixtures would have to be scraped from Renovate's debug
log.

## Live bug context

`resolveCargoPackagesByWorkspaceDependency` used to read `<package>/Cargo.toml` and give up on ENOENT. Against
`spear-ai/horizon` that silently missed `@horizon/horizon-sdk`, whose crates live at
`packages/horizon-sdk/crates/horizon-sdk` and `packages/horizon-sdk/crates/horizon-ffi-python` — `Cargo.toml` but
no sibling `package.json`. Fixed by walking each package's subtree, pruning at `node_modules`, `target`, and any
directory that is itself another package in `packageList` (deepest-wins). Step 3 of the build order is what would
have caught it.

Note that **ownership is directory containment, not `package.json` adjacency** — a `pyproject.toml` inside
`packages/horizon-sdk/crates/…` resolves to `@horizon/horizon-sdk` correctly. The bug was specific to the
shared-declaration path.

## Open decisions — do not silently encode either way

1. **Root-level manifests produce nothing.** `.github/workflows/*`, `mise.toml`, `.python-version`,
   `.node-version`, `rust-toolchain.toml`, root `pyproject.toml` are outside every package, so no changeset and no
   release. Deliberate for CI config; arguable for toolchain pins, which do change built artifacts. Ask before
   asserting it as an invariant.
2. **`custom.*` with an npm-looking depType is fanned out.** The npm path does not gate on manager. A candidate
   fix is `!(upgrade.manager ?? "").startsWith("custom.")`, which excludes only the arbitrary-depType class without
   an allowlist that goes stale. Undecided.
3. **A summary line for unmatched upgrades** was recommended but not built — a batch can write 4 changesets and
   say nothing about the other 8. The tool currently has one `logger.error` and no other output.

## House rules

- **No comments in code.** Explain in the reply instead. Existing comments the user wrote stay.
- **Options objects, not positional arguments**, for anything taking more than one argument, and for single-argument
  functions too — `encodeJson(json)` is the deliberate exception. Keys sorted alphabetically (`sort-keys` is
  enforced on literals but *not* on destructuring or type members — sort those by hand).
- **Literal test fixtures.** Repeat them; do not build helpers that derive them.
- **Directory and path identifiers carry `File`**: `fileDirectory`, `relativeFilePath`, `manifestFilePath`.
- **100% coverage is a gate.** `pnpm run test` fails on an uncovered branch, which is how unreachable defensive
  code surfaces. Prefer deleting unreachable guards over adding tests for impossible states — several were removed
  for exactly this reason.
- **Verify before asserting Renovate behavior.** Read `node_modules/renovate/dist`. Several confident claims in
  this project's history turned out to describe extract-time behavior rather than what reaches the `upgrades`
  array.
- Run `pnpm run typescript:check`, `pnpm run test`, `pnpm run oxlint:check`, `pnpm run oxfmt:check`.
