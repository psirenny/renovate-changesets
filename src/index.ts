import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readConfig } from "@changesets/config";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { configure, getLogger } from "@logtape/logtape";
import { getPackages, type Package } from "@manypkg/get-packages";
import { parse as parseToml } from "smol-toml";
import yargs from "yargs";

import ownPackageJson from "../package.json" with { type: "json" };
import { isRecord, readErrorMessage, renderTemplate, shortenDigest } from "./helpers.js";

/**
 * This package's logger. Records go nowhere until an entry point configures a sink, so importing the package as a
 * library leaves the consuming application in charge of where they land.
 *
 * Messages are logged as tagged templates. LogTape parses `{…}` in a plain string as a placeholder and would blank
 * anything braced — a `JSON.stringify` of an upgrade, for one — while a template's substituted values are left alone.
 * The callback form wraps the template in a call, which is also what keeps it from reading as an unused expression.
 */
const logger = getLogger(["renovate-changesets"]);

export { shortenDigest } from "./helpers.js";

/* ────────────────────────────── Types ────────────────────────────── */

/**
 * Every update type Renovate can produce, from `UpdateType` in Renovate's `config/types.d.ts`. Renovate's own template
 * documentation lists only eight of these and is stale.
 */
export type RenovateUpdateType =
  | "bump"
  | "digest"
  | "lockFileMaintenance"
  | "lockfileUpdate"
  | "major"
  | "minor"
  | "patch"
  | "pin"
  | "pinDigest"
  | "replacement"
  | "rollback";

/**
 * One entry of the `upgrades` array Renovate exposes to `postUpgradeTasks` templates.
 *
 * Renovate is an application, not a library: it ships 91 `.d.ts` files but declares no `types` or `exports` field, so
 * deep-importing its internal `BranchUpgradeConfig` breaks on any version bump. This type is hand-written instead, and
 * deliberately describes the payload rather than Renovate's internals — `compile()` wraps the template input in a proxy
 * whose `get` trap returns `undefined` for anything outside `allowedFields`, and `JSON.stringify` drops `undefined`, so
 * the JSON that reaches this tool is already filtered down to the fields below.
 *
 * That filtering is also why `replacementApproach` can never be recovered here. It is a config option rather than a
 * runtime field, so the proxy strips it and a `replacement` update cannot say whether Renovate wrote `"some-fork":
 * "3.0.0"` or `"ky": "npm:some-fork@3.0.0"` into the manifest.
 *
 * Every field is optional. Renovate populates each one only when the manager that found the dependency extracted it,
 * and `newDigest` is additionally nullable.
 */
export type RenovateUpgrade = {
  currentDigest?: string | null;
  currentValue?: string | null;
  currentVersion?: string | null;
  datasource?: string | null;
  depName?: string | null;
  depType?: string | null;
  isReplacement?: boolean | null;
  manager?: string | null;
  newDigest?: string | null;
  newName?: string | null;
  newValue?: string | null;
  newVersion?: string | null;
  packageFile?: string | null;
  packageName?: string | null;
  updateType?: RenovateUpdateType | null;
};

/**
 * A Renovate upgrade that survived parsing, normalized so that the version a changeset needs is on one field regardless
 * of whether the dependency is pinned by version, by digest, or replaced outright.
 */
export type Update = {
  currentDigest: string | null;
  currentValue: string | null;
  currentVersion: string | null;
  datasource: string | null;
  dependencyName: string;
  dependencyType: string | null;
  /** `currentVersion`, or the shortened `currentDigest` when the tag being tracked isn't a version. */
  fromVersion: string | null;
  manager: string | null;
  manifestFilePath: string;
  newDigest: string | null;
  newName: string | null;
  newValue: string | null;
  newVersion: string | null;
  /** `newVersion`, or the shortened `newDigest`, or — for a replacement, which carries neither — `newValue`. */
  toVersion: string;
  updateType: RenovateUpdateType | null;
};

/** An {@link Update} paired with one workspace package whose changelog should record it. */
export type ResolvedUpdate = Update & {
  packageName: string;
};

/* ───────────────────── Reading Renovate's payload ───────────────────── */

/**
 * Renovate reports override and security-range keys under names that are really version ranges, such as
 * `minimatch@>=10.0.0 <10.2.3`. None of them name a dependency a changeset can talk about.
 */
const RANGE_DEPENDENCY_NAME_PATTERN = /[\s<>]/u;

// Unreviewed
const readDigest = (digest: string | null): string | null => (digest === null ? null : shortenDigest(digest));

// Unreviewed
/**
 * Picks the side of an upgrade a changeset should name.
 *
 * A version normally wins over a digest: an image pinned by both a tag and a digest reads better as `1.0.0-rc.2 →
 * 1.0.0-rc.3` than as two hashes. Digest updates are the exception. Renovate builds them as `{ updateType: "digest",
 * newValue: currentValue }` with the tag left untouched and no `newVersion` at all, so the digest is the only part that
 * moved and naming the tag would claim an update that didn't happen.
 */
const readVersion = (version: string | null, digest: string | null, isDigestUpdate: boolean): string | null =>
  isDigestUpdate ? (readDigest(digest) ?? version) : (version ?? readDigest(digest));

type UpdateKind = { isDigestUpdate: boolean; updateType: RenovateUpdateType | null };

// Unreviewed
/**
 * Settles what kind of update this is.
 *
 * Renovate sets `isReplacement` on some code paths and `updateType` on others, so normalizing the two here is what lets
 * a template trust `{{#if isReplacement}}`.
 */
const readUpdateKind = (upgrade: RenovateUpgrade): UpdateKind => {
  const reportedUpdateType = upgrade.updateType ?? null;
  const updateType =
    reportedUpdateType === "replacement" || upgrade.isReplacement === true ? "replacement" : reportedUpdateType;

  return { isDigestUpdate: updateType === "digest" || updateType === "pinDigest", updateType };
};

// Unreviewed
const readUpdate = (upgrade: RenovateUpgrade): Update[] => {
  // Read the two fields an upgrade cannot be placed without first, so everything below has them as plain strings.
  // `lockFileMaintenance` carries no dependency name, and a manager that extracted neither can't be placed.
  const dependencyName = upgrade.depName ?? null;
  const manifestFilePath = upgrade.packageFile ?? null;

  if (dependencyName === null || manifestFilePath === null) {
    const payload = JSON.stringify(upgrade);

    logger.warning((format) => format`Skipping an upgrade with no dependency name or manifest path: ${payload}.`);

    return [];
  }

  if (RANGE_DEPENDENCY_NAME_PATTERN.test(dependencyName)) {
    logger.warning(
      (format) => format`Skipping "${dependencyName}", which is a version range rather than a dependency name.`,
    );

    return [];
  }

  const currentDigest = upgrade.currentDigest ?? null;
  const currentVersion = upgrade.currentVersion ?? null;
  const newDigest = upgrade.newDigest ?? null;
  const newValue = upgrade.newValue ?? null;
  const newVersion = upgrade.newVersion ?? null;
  const { isDigestUpdate, updateType } = readUpdateKind(upgrade);

  // A replacement carries `newName` and `newValue` and nothing else — both of Renovate's construction sites build it
  // as `{ updateType: "replacement", newName, newValue }` — so `newValue` is the only version it can be named by.
  const toVersion =
    readVersion(newVersion, newDigest, isDigestUpdate) ?? (updateType === "replacement" ? newValue : null);

  if (toVersion === null) {
    logger.warning(
      (format) => format`Skipping "${dependencyName}", which Renovate reported with no version and no digest.`,
    );
    return [];
  }

  return [
    {
      currentDigest,
      currentValue: upgrade.currentValue ?? null,
      currentVersion,
      datasource: upgrade.datasource ?? null,
      dependencyName,
      dependencyType: upgrade.depType ?? null,
      fromVersion: readVersion(currentVersion, currentDigest, isDigestUpdate),
      manager: upgrade.manager ?? null,
      manifestFilePath,
      newDigest,
      newName: upgrade.newName ?? null,
      newValue,
      newVersion,
      toVersion,
      updateType,
    },
  ];
};

// Unreviewed
/**
 * Decodes the payload Renovate passes as `{{{encodeBase64 (toJSON upgrades)}}}`.
 *
 * A payload that isn't base64-encoded JSON array throws rather than degrading: it comes from the consumer's own
 * `renovate.json` template, so a malformed one means that template broke and should fail the branch loudly. Individual
 * upgrades that name no package are a different matter — `lockFileMaintenance` legitimately carries no dependency name
 * — so those are skipped with a warning.
 */
export const parseUpdates = (encodedUpdates: string): Update[] => {
  if (encodedUpdates === "") {
    return [];
  }

  // The payload is whatever the consumer's `postUpgradeTasks` template produced. Trusting its shape is deliberate:
  // every field is read defensively below, and a payload that isn't an array throws on `flatMap` and is reported by
  // `main` rather than silently producing nothing.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Renovate's documented payload shape.
  const upgradeList = JSON.parse(Buffer.from(encodedUpdates, "base64").toString("utf8")) as RenovateUpgrade[];

  return upgradeList.flatMap((upgrade) => readUpdate(upgrade));
};

/* ─────────────────────── Finding the packages ─────────────────────── */

// Unreviewed
/**
 * Loads the workspace packages that Changesets would actually version.
 *
 * `@manypkg/get-packages` probes for every workspace layout it knows — pnpm, npm, Yarn, Bun, Lerna, Rush, and a
 * single-package repository — so ownership works the same way in all of them. Packages that Changesets skips (ignored
 * by config, or private when `privatePackages.version` is off) are dropped here rather than later, so a changeset is
 * never written naming a package `changeset version` refuses to bump.
 */
export const getWorkspacePackageList = async (directory: string): Promise<Package[]> => {
  const workspace = await getPackages(directory);

  // A repository writing for a tool other than Changesets has no `.changeset/config.json` to read, so a missing one
  // falls back rather than failing. A malformed one still fails: it was written on purpose and is wrong.
  const parseResult = await readConfig(directory, workspace).catch((error: unknown) => {
    // `instanceof` and `in` narrow on their own, so the errno shape is read without asserting it.
    const isFileMissing = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (!isFileMissing) {
      throw error;
    }

    logger.warning((format) => format`No .changeset/config.json, so only packages without a version are skipped.`);

    return null;
  });

  // `readConfig` leaves `errors` undefined on success, not null. A `!== null` guard here would throw on every valid
  // config.
  if (parseResult?.errors !== undefined) {
    throw new Error(`.changeset/config.json is invalid: ${parseResult.errors.join(", ")}`);
  }

  const skipOptions =
    parseResult === null
      ? { allowPrivatePackages: true, ignore: [] }
      : { allowPrivatePackages: parseResult.config.privatePackages.version, ignore: parseResult.config.ignore };

  return workspace.packages.filter((workspacePackage) => !shouldSkipPackage(workspacePackage, skipOptions));
};

// Unreviewed
/**
 * Finds the workspace package that owns a manifest file.
 *
 * A manifest that sits outside every workspace package — `mise.toml` at the repository root, a GitHub Actions workflow,
 * `pnpm-workspace.yaml` — belongs to no package and returns `null`. That is what keeps a workflow's pinned Action SHAs
 * out of every changelog, and it is deliberate rather than an oversight.
 *
 * Renovate reports `packageFile` relative to the repository root, so paths are resolved against `directory` rather than
 * the process's working directory — the two are the same when Renovate runs the command itself, but not when the caller
 * points the tool somewhere else.
 */
export const getOwningPackageName = (
  workspacePackageList: Package[],
  manifestFilePath: string,
  directory: string,
): string | null => {
  const resolvedManifestFilePath = path.resolve(directory, manifestFilePath);

  return (
    workspacePackageList
      // ✓ Includes — manifests inside the workspace package.
      //   - "/packages/foo", "/packages/foo/manifest.json"     => "manifest.json"
      //   - "/packages/foo", "/packages/foo/bar/manifest.json" => "bar/manifest.json"
      //
      // ✗ Rejects — manifests outside it, including a sibling whose name shares a prefix.
      //   - "/packages/foo", "/packages/bar/manifest.json"    => "../bar/manifest.json"
      //   - "/packages/foo", "/packages/foobar/manifest.json" => "../foobar/manifest.json"
      .filter((workspacePackage) => {
        const relativeFilePath = path.relative(path.resolve(workspacePackage.dir), resolvedManifestFilePath);
        return !relativeFilePath.startsWith("..");
      })
      // Deepest match wins, so a package nested inside another claims its own manifests:
      //   - "/packages/parent-package/child-package" ⇐ selected
      //   - "/packages/parent-package"
      //
      // Comparing directory lengths is only sound because the containment filter already ran — among directories
      // that all contain the same file, the longest is necessarily the deepest.
      .toSorted((left, right) => right.dir.length - left.dir.length)
      .at(0)?.packageJson.name ?? null
  );
};

/* ────────────────────── Shared version declarations ────────────────────── */

/**
 * Renovate structures a catalog's `depType` as `<manager>.catalog.<name>`, with `default` standing in for the unnamed
 * catalog. Both pnpm and Yarn produce them.
 */
const CATALOG_DEPENDENCY_TYPE_PATTERN = /^(?:pnpm|yarn)\.catalog\.(?<catalogName>.+)$/u;

/** The `depType` Renovate gives a dependency declared in a workspace root `Cargo.toml`'s `[workspace.dependencies]`. */
const CARGO_WORKSPACE_DEPENDENCY_TYPE = "workspace.dependencies";

const CARGO_DEPENDENCY_SECTION_LIST = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

const NPM_DEPENDENCY_GROUP_LIST = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Every `depType` under which a manifest can pin a version for dependencies it doesn't declare itself. */
const OVERRIDE_DEPENDENCY_TYPE_LIST = new Set([
  "overrides",
  "pnpm-workspace.overrides",
  "pnpm.overrides",
  "resolutions",
]);

// Unreviewed
const readDependencyValue = (workspacePackage: Package, dependencyName: string): string | null => {
  for (const dependencyGroup of NPM_DEPENDENCY_GROUP_LIST) {
    const dependencyValue = workspacePackage.packageJson[dependencyGroup]?.[dependencyName];

    if (typeof dependencyValue === "string") {
      return dependencyValue;
    }
  }

  return null;
};

// Unreviewed
/**
 * A package consumes a catalog entry when it points at that catalog by name. The default catalog answers to a bare
 * `catalog:` as well as to `catalog:default`, and a named catalog answers to neither.
 */
const referencesCatalog = (dependencyValue: string | null, catalogName: string): boolean => {
  if (dependencyValue === null) {
    return false;
  }

  if (catalogName === "default") {
    return dependencyValue === "catalog:" || dependencyValue === "catalog:default";
  }

  return dependencyValue === `catalog:${catalogName}`;
};

// Unreviewed
/** Finds every package that draws the given dependency from the given catalog. */
export const getCatalogPackageNameList = (
  workspacePackageList: Package[],
  catalogName: string,
  dependencyName: string,
): string[] =>
  workspacePackageList
    .filter((workspacePackage) => referencesCatalog(readDependencyValue(workspacePackage, dependencyName), catalogName))
    .map((workspacePackage) => workspacePackage.packageJson.name);

// Unreviewed
/**
 * Finds every package that declares the overridden dependency directly.
 *
 * An override usually pins something transitive that no package names, in which case this is empty and nothing is
 * written. Claiming the update for every package in the workspace would put dependencies in changelogs that the package
 * never asked for.
 */
export const getOverridePackageNameList = (workspacePackageList: Package[], dependencyName: string): string[] =>
  workspacePackageList
    .filter((workspacePackage) => readDependencyValue(workspacePackage, dependencyName) !== null)
    .map((workspacePackage) => workspacePackage.packageJson.name);

// Unreviewed
/** Reads and parses a package's crate manifest, or `null` when the package isn't a crate at all. */
const readCargoManifest = async (manifestFilePath: string): Promise<Record<string, unknown> | null> => {
  const content = await readFile(manifestFilePath, "utf8").catch(() => null);

  if (content === null) {
    return null;
  }

  try {
    return parseToml(content);
  } catch (error) {
    throw new Error(`Couldn't parse ${manifestFilePath}.`, { cause: error });
  }
};

// Unreviewed
const isWorkspaceInheritedEntry = (entry: unknown): boolean => isRecord(entry) && entry.workspace === true;

// Unreviewed
/** Collects a Cargo manifest's dependency tables, including the per-platform `[target.'cfg(…)'.dependencies]` ones. */
const readCargoDependencyTableList = (manifest: Record<string, unknown>): unknown[] => {
  const tableList: unknown[] = CARGO_DEPENDENCY_SECTION_LIST.map((sectionName) => manifest[sectionName]);
  const targetTable = manifest.target;

  if (isRecord(targetTable)) {
    for (const platformTable of Object.values(targetTable)) {
      if (isRecord(platformTable)) {
        for (const sectionName of CARGO_DEPENDENCY_SECTION_LIST) {
          tableList.push(platformTable[sectionName]);
        }
      }
    }
  }

  return tableList;
};

// Unreviewed
const inheritsCargoWorkspaceDependency = (manifest: Record<string, unknown>, dependencyName: string): boolean =>
  readCargoDependencyTableList(manifest).some((table) => {
    if (!isRecord(table)) {
      return false;
    }

    return isWorkspaceInheritedEntry(table[dependencyName]);
  });

// Unreviewed
/**
 * Finds every package whose crate inherits the dependency from the workspace root.
 *
 * Cargo's inheritance is the same shape as a pnpm catalog: a member writes `serde.workspace = true` and the version
 * lives in the root `Cargo.toml`, which is why Renovate marks the member's copy `inherited-dependency` and skips it. A
 * crate is matched to a changeset-able package by directory, so this looks for `Cargo.toml` beside each package's
 * `package.json` — the layout an `infrastructure-extras`-shaped repository already uses to give a non-JavaScript
 * artifact a version Changesets can bump.
 */
export const getCargoWorkspacePackageNameList = async (
  workspacePackageList: Package[],
  dependencyName: string,
): Promise<string[]> => {
  const packageNameList = await Promise.all(
    workspacePackageList.map(async (workspacePackage) => {
      const manifestFilePath = path.join(workspacePackage.dir, "Cargo.toml");
      const manifest = await readCargoManifest(manifestFilePath);

      if (manifest === null || !inheritsCargoWorkspaceDependency(manifest, dependencyName)) {
        return null;
      }

      return workspacePackage.packageJson.name;
    }),
  );

  return packageNameList.filter((packageName) => packageName !== null);
};

// Unreviewed
/**
 * Expands an update that lives in a manifest belonging to no single package.
 *
 * A shared version declaration — Renovate's own name for the idea is `sharedVariableName` — states one version on
 * behalf of packages that don't state it themselves, so the update belongs to every package that consumes it rather
 * than to the manifest it was written in.
 *
 * Catalog entries and Cargo's `[workspace.dependencies]` are structurally root-only — a member declaring one gets
 * skipped by Renovate as inherited — so they always expand. Overrides are not: a single-package repository keeps them
 * in the one `package.json` it has, where ownership already gives the right answer, so they only expand once no package
 * owns the manifest.
 *
 * Returns `null` when the update names no shared declaration this understands.
 */
export const getSharedDeclarationPackageNameList = async (
  update: Update,
  workspacePackageList: Package[],
  { isOwned }: { isOwned: boolean },
): Promise<string[] | null> => {
  const { dependencyName, dependencyType } = update;

  if (dependencyType === null) {
    return null;
  }

  const catalogName = CATALOG_DEPENDENCY_TYPE_PATTERN.exec(dependencyType)?.groups?.catalogName;

  if (catalogName !== undefined) {
    return getCatalogPackageNameList(workspacePackageList, catalogName, dependencyName);
  }

  if (dependencyType === CARGO_WORKSPACE_DEPENDENCY_TYPE) {
    return getCargoWorkspacePackageNameList(workspacePackageList, dependencyName);
  }

  if (!isOwned && OVERRIDE_DEPENDENCY_TYPE_LIST.has(dependencyType)) {
    return getOverridePackageNameList(workspacePackageList, dependencyName);
  }

  return null;
};

// Unreviewed
/**
 * Pairs each update with the packages whose changelogs should record it.
 *
 * Most updates are one-to-one: the manifest sits inside exactly one package, and that package gets the changeset.
 * Shared declarations are the one-to-many case — a catalog entry or an inherited Cargo dependency lives in a manifest
 * that belongs to no package, so it expands to every package that consumes it. An update that matches neither expands
 * to nothing, which is how a repository-root `mise.toml` or a workflow's pinned Action SHAs stay out of every
 * changelog.
 */
export const resolveUpdates = async (
  updateList: Update[],
  workspacePackageList: Package[],
  { directory }: { directory: string },
): Promise<ResolvedUpdate[]> => {
  const resolvedUpdateListList = await Promise.all(
    updateList.map(async (update) => {
      const owningPackageName = getOwningPackageName(workspacePackageList, update.manifestFilePath, directory);
      const sharedPackageNameList = await getSharedDeclarationPackageNameList(update, workspacePackageList, {
        isOwned: owningPackageName !== null,
      });
      const packageNameList = sharedPackageNameList ?? (owningPackageName === null ? [] : [owningPackageName]);

      return [...new Set(packageNameList)].map((packageName) => ({ ...update, packageName }));
    }),
  );

  return resolvedUpdateListList.flat();
};

/* ─────────────────────────── The changeset ─────────────────────────── */

/**
 * The wording used when a repository ships no template of its own.
 *
 * Rollback reads oddly under the plain phrasing — `Updated turbo from 2.10.11 to 2.10.10` — so it gets its own branch.
 * Replacement gets one too, because it is the only update that changes the dependency's name, and reusing the plain
 * phrasing would name the departing dependency while hiding the rename.
 */
export const DEFAULT_TEMPLATE = `---
"{{packageName}}": patch
---

{{#if isReplacement}}Replaced {{depName}}{{#if fromVersion}} {{fromVersion}}{{/if}} with {{newName}} {{newValue}}
{{else}}{{#if isRollback}}Rolled {{depName}} back to {{toVersion}}
{{else}}Updated {{depName}}{{#if fromVersion}} from {{fromVersion}}{{/if}} to {{toVersion}}{{/if}}{{/if}}
`;

/**
 * Where changesets are written, and where a repository's own template is looked for.
 *
 * Changesets fixes this directory and reads its own `config.json` out of it, so nothing here makes it configurable.
 */
export const CHANGESETS_DIRECTORY = ".changeset";

/**
 * What a repository's own template is called, inside the changesets directory.
 *
 * The name starts with a dot on purpose. `@changesets/read` treats every `.md` file in `.changeset` as a real changeset
 * — only `README.md`, the agent files, and dotfiles are skipped — so a template named without the dot would be parsed
 * as a changeset and break `changeset version`.
 */
export const DEFAULT_TEMPLATE_FILE_NAME = ".renovate-changesets.md";

/** Every name a template may reference, with the values it renders for one resolved update. */
export type TemplateContext = {
  currentDigest: string | null;
  currentValue: string | null;
  currentVersion: string | null;
  datasource: string | null;
  depName: string;
  depType: string | null;
  fromVersion: string | null;
  isBump: boolean;
  isDigest: boolean;
  isMajor: boolean;
  isMinor: boolean;
  isPatch: boolean;
  isPin: boolean;
  isPinDigest: boolean;
  isReplacement: boolean;
  isRollback: boolean;
  manager: string | null;
  newDigest: string | null;
  newName: string | null;
  newValue: string | null;
  newVersion: string | null;
  packageFile: string;
  packageName: string;
  toVersion: string;
  updateType: string | null;
};

// Unreviewed
/**
 * Reads the changeset template, falling back to the built-in wording.
 *
 * A template that was asked for by name and isn't there is a mistake worth failing on; the default path simply not
 * existing is the normal case for a repository that hasn't customized anything.
 */
export const readTemplate = async (
  directory: string,
  { templateFilePath }: { templateFilePath?: string } = {},
): Promise<string> => {
  const isConfigured = templateFilePath !== undefined && templateFilePath !== "";
  const resolvedFilePath = path.resolve(
    directory,
    isConfigured ? templateFilePath : path.join(CHANGESETS_DIRECTORY, DEFAULT_TEMPLATE_FILE_NAME),
  );

  try {
    return await readFile(resolvedFilePath, "utf8");
  } catch (error) {
    // `instanceof` and `in` narrow on their own, so the errno shape is read without asserting it.
    const isFileMissing = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (isConfigured || !isFileMissing) {
      throw new Error(`Couldn't read the changeset template at ${resolvedFilePath}.`, { cause: error });
    }

    return DEFAULT_TEMPLATE;
  }
};

// Unreviewed
/**
 * Builds the values a template can reference. The names mirror Renovate's own, so a template reads the way the
 * `renovate.json` that produced it does, and the `is…` flags are derived from `updateType` rather than trusted from the
 * payload — Renovate only sets its own booleans on some code paths.
 */
export const buildTemplateContext = (resolvedUpdate: ResolvedUpdate): TemplateContext => ({
  currentDigest: resolvedUpdate.currentDigest,
  currentValue: resolvedUpdate.currentValue,
  currentVersion: resolvedUpdate.currentVersion,
  datasource: resolvedUpdate.datasource,
  depName: resolvedUpdate.dependencyName,
  depType: resolvedUpdate.dependencyType,
  fromVersion: resolvedUpdate.fromVersion,
  isBump: resolvedUpdate.updateType === "bump",
  isDigest: resolvedUpdate.updateType === "digest",
  isMajor: resolvedUpdate.updateType === "major",
  isMinor: resolvedUpdate.updateType === "minor",
  isPatch: resolvedUpdate.updateType === "patch",
  isPin: resolvedUpdate.updateType === "pin",
  isPinDigest: resolvedUpdate.updateType === "pinDigest",
  isReplacement: resolvedUpdate.updateType === "replacement",
  isRollback: resolvedUpdate.updateType === "rollback",
  manager: resolvedUpdate.manager,
  newDigest: resolvedUpdate.newDigest,
  newName: resolvedUpdate.newName,
  newValue: resolvedUpdate.newValue,
  newVersion: resolvedUpdate.newVersion,
  packageFile: resolvedUpdate.manifestFilePath,
  packageName: resolvedUpdate.packageName,
  toVersion: resolvedUpdate.toVersion,
  updateType: resolvedUpdate.updateType,
});

// Unreviewed
/**
 * Renders one changeset. Branches that aren't taken leave the newlines that surrounded them behind, so runs of blank
 * lines are collapsed and the file is left with exactly one trailing newline.
 */
export const renderChangeset = (template: string, resolvedUpdate: ResolvedUpdate): string => {
  const content = renderTemplate(template, buildTemplateContext(resolvedUpdate));

  return `${content.replaceAll(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
};

// Unreviewed
/**
 * Names a changeset after a hash of its own content.
 *
 * Renovate re-runs `postUpgradeTasks` every time it rebases the branch. Hashing means a re-run overwrites the files it
 * wrote last time instead of piling up a second set beside them. `@changesets/write` can't be used for this — its
 * `humanId()` names are random, so every rebase would accumulate — though its frontmatter shape is worth matching, and
 * the default template does.
 */
export const getChangesetFileName = (content: string): string =>
  `renovate-${createHash("sha256").update(content).digest("hex").slice(0, 8)}.md`;

// Unreviewed
/** Renders and writes one changeset per resolved update, returning the paths written, sorted and deduplicated. */
export const writeChangesets = async (
  resolvedUpdateList: ResolvedUpdate[],
  { directory, template }: { directory: string; template: string },
): Promise<string[]> => {
  const filePathList = await Promise.all(
    resolvedUpdateList.map(async (resolvedUpdate) => {
      const content = renderChangeset(template, resolvedUpdate);
      const filePath = path.join(directory, CHANGESETS_DIRECTORY, getChangesetFileName(content));

      await writeFile(filePath, content);

      return filePath;
    }),
  );

  return [...new Set(filePathList)].toSorted();
};

/* ─────────────────────────── The command line ─────────────────────────── */

/** The command line and the environment, folded together into everything the run needs. */
export type Arguments = {
  /** Renovate's payload, as base64-encoded JSON — empty when there was none. */
  encodedUpdates: string;
  /** A template outside the changesets directory, when one was named. */
  templateFilePath: string | undefined;
  /** The repository root to read and write. */
  workingDirectory: string;
};

export type RunOptions = {
  /** The command's arguments, less the executable and script — Renovate's payload is the first of them. */
  argumentList: string[];
  /** The repository root. Renovate runs post-upgrade commands from the root of its own clone. */
  directory: string;
  /**
   * The process environment, which stands in for the flags below.
   *
   * Renovate does not pass the host's environment to a post-upgrade command: `getChildProcessEnv` copies an allow-list
   * of about thirty names and nothing else. Options therefore have to be set in the repository's own `renovate.json`,
   * under the repository-level `env` object, which Renovate hands to child processes verbatim.
   */
  environment: Record<string, string | undefined>;
};

// Unreviewed
/**
 * Parses the command line, falling back to the environment, and returns what the run needs — or `undefined` when yargs
 * has already answered on its own, as `--help` and `--version` do.
 *
 * Every option has both a flag and a variable, paired in the README rather than derived from each other. The
 * environment is read from `RunOptions` rather than through yargs' own `.env()`, which reaches for `process.env`
 * directly and so can't be given the environment Renovate actually handed over.
 */
export const parseArguments = async ({
  argumentList,
  directory,
  environment,
}: RunOptions): Promise<Arguments | undefined> => {
  const argv = await yargs(argumentList)
    .scriptName("renovate-changesets")
    .command(
      "$0 [updates]",
      "Write one changeset per package and dependency in Renovate's upgrade payload.",
      (command) =>
        command.positional("updates", {
          describe: "Renovate's `upgrades` array, as base64-encoded JSON",
          type: "string",
        }),
    )
    .option("cwd", {
      default: environment.RENOVATE_CHANGESETS_CWD,
      defaultDescription: "the working directory",
      describe: "The repository root, when it isn't where the command runs",
      type: "string",
    })
    .option("template-file", {
      default: environment.RENOVATE_CHANGESETS_TEMPLATE_FILE,
      defaultDescription: `${CHANGESETS_DIRECTORY}/${DEFAULT_TEMPLATE_FILE_NAME}`,
      describe: "A template elsewhere. Named explicitly and missing is an error",
      type: "string",
    })
    .alias("h", "help")
    .alias("v", "version")
    .version(ownPackageJson.version)
    .strict()
    // Answer for ourselves rather than writing to the console and exiting, so this stays callable as a library.
    .exitProcess(false)
    .fail(false)
    .parseAsync();

  if (argv.help === true || argv.version === true) {
    return undefined;
  }

  return {
    encodedUpdates: typeof argv.updates === "string" ? argv.updates : "",
    templateFilePath: argv.templateFile,
    workingDirectory: argv.cwd === undefined || argv.cwd === "" ? directory : argv.cwd,
  };
};

/* ─────────────────────────── The entry point ─────────────────────────── */

// Unreviewed
/**
 * Sends this package's records to standard error, the stream Renovate captures for a post-upgrade command.
 *
 * Only an entry point calls this. Importing the package as a library leaves LogTape alone, so the consuming application
 * decides where records go.
 */
export const configureLogging = async (): Promise<void> => {
  await configure({
    loggers: [
      // Without an entry, the meta logger prints a configuration notice on every run.
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["stderr"] },
      { category: "renovate-changesets", lowestLevel: "warning", sinks: ["stderr"] },
    ],
    reset: true,
    sinks: {
      stderr: (record) => {
        process.stderr.write(`renovate-changesets: ${record.message.join("")}\n`);
      },
    },
  });
};

// Unreviewed
/**
 * Reads Renovate's payload and writes the changesets it implies, returning the paths written — none of them when the
 * command line asked for something yargs answers itself, like `--help`.
 */
export const run = async (options: RunOptions): Promise<string[]> => {
  const parsedArguments = await parseArguments(options);

  if (parsedArguments === undefined) {
    return [];
  }

  const { encodedUpdates, templateFilePath, workingDirectory } = parsedArguments;
  const [template, workspacePackageList] = await Promise.all([
    readTemplate(workingDirectory, { templateFilePath }),
    getWorkspacePackageList(workingDirectory),
  ]);
  const resolvedUpdateList = await resolveUpdates(parseUpdates(encodedUpdates), workspacePackageList, {
    directory: workingDirectory,
  });

  return writeChangesets(resolvedUpdateList, { directory: workingDirectory, template });
};

// Unreviewed
/**
 * Runs one invocation and reports the exit code it earned.
 *
 * A failure is reported through the logger rather than rethrown, because the caller is a shell: Renovate reads the
 * message off standard error and the exit code off the process.
 */
export const main = async (options: RunOptions): Promise<number> => {
  try {
    await run(options);

    return 0;
  } catch (error) {
    const message = readErrorMessage(error);

    logger.error((format) => format`${message}`);

    return 1;
  }
};
