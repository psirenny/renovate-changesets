import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readConfig as readChangesetConfig } from "@changesets/config";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { configure, getLogger } from "@logtape/logtape";
import { getPackages, type Package } from "@manypkg/get-packages";
import Handlebars from "handlebars";
import { parse as parseToml } from "smol-toml";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import packageJson from "../package.json" with { type: "json" };
import type { RenovateUpgrade } from "./typedefs.js";

export type { RenovateUpdateType, RenovateUpgrade } from "./typedefs.js";

const logger = getLogger(["renovate-changesets"]);

export const configureLogger = async (): Promise<void> => {
  await configure({
    loggers: [
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

export const defaultTemplate = `
---
"{{packageName}}": patch
---

{{#if isReplacement}}Replaced {{depName}}{{#if displayFrom}} {{displayFrom}}{{/if}} with {{newName}} {{displayTo}}
{{else}}{{#if isRollback}}Rolled {{depName}} back to {{displayTo}}
{{else}}Updated {{depName}}{{#if displayFrom}} from {{displayFrom}}{{/if}} to {{displayTo}}{{/if}}{{/if}}
`;

/** A {@link RenovateUpgrade} paired with one workspace package whose changelog should record it. */
export type ResolvedRenovateUpgrade = RenovateUpgrade & { packageName: string };

// Unreviewed
/** Skips the upgrades a changeset can't name, with a log record saying why. */
export const getUpgradeList = (rawUpgradeList: RenovateUpgrade[]): RenovateUpgrade[] =>
  rawUpgradeList.flatMap((upgrade) => {
    const depName = upgrade.depName ?? null;

    // `lockFileMaintenance` carries no dependency name, and an upgrade with no manifest path can't be placed.
    if (depName === null || (upgrade.packageFile ?? null) === null) {
      const payload = JSON.stringify(upgrade);

      logger.warning((format) => format`Skipping an upgrade with no dependency name or manifest path: ${payload}.`);

      return [];
    }

    // Skip junk version ranges. For example, "minimatch@>=10.0.0 <10.2.3".
    if (/[\s<>]/u.test(depName)) {
      logger.info((format) => format`Skipping "${depName}", which is a version range rather than a dependency name.`);

      return [];
    }

    // Renovate names what every upgrade moved to on `displayTo`, so an empty one means there is nothing to say.
    if ((upgrade.displayTo ?? "") === "") {
      logger.warning((format) => format`Skipping "${depName}", which Renovate reported with an empty displayTo.`);

      return [];
    }

    return [upgrade];
  });

export const getWorkspacePackageList = async (cwd: string): Promise<Package[]> => {
  const workspace = await getPackages(cwd);
  const changesetConfig = await readChangesetConfig(cwd, workspace);

  if (changesetConfig.errors !== undefined) {
    throw new Error(`.changeset/config.json is invalid: ${changesetConfig.errors.join(", ")}`);
  }

  return workspace.packages.filter(
    (package_) =>
      !shouldSkipPackage(package_, {
        allowPrivatePackages: changesetConfig.config.privatePackages.version,
        ignore: changesetConfig.config.ignore,
      }),
  );
};

// Unreviewed
/**
 * Finds the workspace package that owns a manifest file. A manifest outside every package — `mise.toml` at the
 * repository root, a GitHub Actions workflow — belongs to no package and resolves to `null` on purpose, which is what
 * keeps those updates out of every changelog. Renovate reports `packageFile` relative to the repository root, so it is
 * resolved against `cwd` rather than where the process runs.
 */
export const resolvePackageName = ({
  cwd,
  upgrade,
  workspacePackageList,
}: {
  cwd: string;
  upgrade: RenovateUpgrade;
  workspacePackageList: Package[];
}): string | null => {
  const packageFile = upgrade.packageFile ?? null;

  if (packageFile === null) {
    return null;
  }

  const resolvedManifestFilePath = path.resolve(cwd, packageFile);

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

const cargoDependencySectionList = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

// A partial Cargo.toml manifest definition based on https://www.schemastore.org/cargo.json.
type CargoDependency = string | { workspace?: boolean };
type CargoDependencyTable = Record<string, CargoDependency>;
type CargoPlatform = Partial<Record<(typeof cargoDependencySectionList)[number], CargoDependencyTable>>;
type CargoManifest = CargoPlatform & { target?: Record<string, CargoPlatform> };

// Unreviewed
const readDependencyValue = (workspacePackage: Package, depName: string): string | null => {
  for (const dependencyGroup of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencyValue = workspacePackage.packageJson[dependencyGroup]?.[depName];

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
  depName: string,
): string[] =>
  workspacePackageList
    .filter((workspacePackage) => referencesCatalog(readDependencyValue(workspacePackage, depName), catalogName))
    .map((workspacePackage) => workspacePackage.packageJson.name);

// Unreviewed
/**
 * Finds every package that declares the overridden dependency directly. An override usually pins something transitive
 * that no package names, in which case this is empty and nothing is written.
 */
export const getOverridePackageNameList = (workspacePackageList: Package[], depName: string): string[] =>
  workspacePackageList
    .filter((workspacePackage) => readDependencyValue(workspacePackage, depName) !== null)
    .map((workspacePackage) => workspacePackage.packageJson.name);

// Unreviewed
/** Reads and parses a package's crate manifest, or `null` when the package isn't a crate at all. */
const readCargoManifest = async (manifestFilePath: string): Promise<CargoManifest | null> => {
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
/** Collects a Cargo manifest's dependency tables, including the per-platform `[target.'cfg(…)'.dependencies]` ones. */
const readCargoDependencyTableList = (manifest: CargoManifest): (CargoDependencyTable | undefined)[] => [
  ...cargoDependencySectionList.map((sectionName) => manifest[sectionName]),
  ...Object.values(manifest.target ?? {}).flatMap((platformSection) =>
    cargoDependencySectionList.map((sectionName) => platformSection[sectionName]),
  ),
];

// Unreviewed
const inheritsCargoWorkspaceDependency = (manifest: CargoManifest, depName: string): boolean =>
  readCargoDependencyTableList(manifest).some((table) => {
    const entry = table?.[depName];

    return typeof entry === "object" && entry.workspace === true;
  });

// Unreviewed
/**
 * Finds every package whose crate inherits the dependency from the workspace root — a member writes `serde.workspace =
 * true` and the version lives in the root `Cargo.toml`. A crate is matched to a changeset-able package by looking for
 * `Cargo.toml` beside each package's `package.json`.
 */
export const getCargoWorkspacePackageNameList = async (
  workspacePackageList: Package[],
  depName: string,
): Promise<string[]> => {
  const packageNameList = await Promise.all(
    workspacePackageList.map(async (workspacePackage) => {
      const manifestFilePath = path.join(workspacePackage.dir, "Cargo.toml");
      const manifest = await readCargoManifest(manifestFilePath);

      if (manifest === null || !inheritsCargoWorkspaceDependency(manifest, depName)) {
        return null;
      }

      return workspacePackage.packageJson.name;
    }),
  );

  return packageNameList.filter((packageName) => packageName !== null);
};

/**
 * Expands an upgrade whose declaration states one version on behalf of other packages — a catalog entry or a Cargo
 * `[workspace.dependencies]` — to every package that consumes it. Returns `null` when the upgrade names no shared
 * declaration this understands, leaving it to ownership.
 */
export const getSharedDeclarationPackageNameList = async ({
  isOwned,
  upgrade,
  workspacePackageList,
}: {
  isOwned: boolean;
  upgrade: RenovateUpgrade;
  workspacePackageList: Package[];
}): Promise<string[] | null> => {
  const depName = upgrade.depName ?? null;
  const depType = upgrade.depType ?? null;

  if (depName === null || depType === null) {
    return null;
  }

  const catalogName = /^(?:pnpm|yarn)\.catalog\.(?<catalogName>.+)$/u.exec(depType)?.groups?.catalogName;

  if (catalogName !== undefined) {
    return getCatalogPackageNameList(workspacePackageList, catalogName, depName);
  }

  if (depType === "workspace.dependencies") {
    return getCargoWorkspacePackageNameList(workspacePackageList, depName);
  }

  // A single-package repository keeps overrides in the one `package.json` it has, where ownership already gives the
  // right answer, so they only expand once no package owns the manifest.
  if (!isOwned && ["overrides", "pnpm-workspace.overrides", "pnpm.overrides", "resolutions"].includes(depType)) {
    return getOverridePackageNameList(workspacePackageList, depName);
  }

  return null;
};

/**
 * Pairs each upgrade with the packages whose changelogs should record it. Most upgrades are one-to-one through
 * ownership; a shared declaration expands to every consumer; an upgrade that matches neither expands to nothing.
 */
export const resolveUpgrades = async ({
  cwd,
  upgradeList,
  workspacePackageList,
}: {
  cwd: string;
  upgradeList: RenovateUpgrade[];
  workspacePackageList: Package[];
}): Promise<ResolvedRenovateUpgrade[]> => {
  const resolvedUpgradeList = await Promise.all(
    upgradeList.map(async (upgrade) => {
      const owningPackageName = resolvePackageName({ cwd, upgrade, workspacePackageList });
      const sharedPackageNameList = await getSharedDeclarationPackageNameList({
        isOwned: owningPackageName !== null,
        upgrade,
        workspacePackageList,
      });
      const packageNameList = sharedPackageNameList ?? (owningPackageName === null ? [] : [owningPackageName]);

      return [...new Set(packageNameList)].map((packageName) => ({ ...upgrade, packageName }));
    }),
  );

  return resolvedUpgradeList.flat();
};

export const writeChangesets = async ({
  cwd,
  resolvedUpgradeList,
  template,
}: {
  cwd: string;
  resolvedUpgradeList: ResolvedRenovateUpgrade[];
  template: string;
}): Promise<string[]> => {
  const filePathList = await Promise.all(
    resolvedUpgradeList.map(async (resolvedUpgrade) => {
      let content = Handlebars.compile(template, { noEscape: true, strict: true })(resolvedUpgrade);
      content = `${content.replaceAll(/\n{3,}/gu, "\n\n").trim()}\n`;
      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 8);
      const filePath = path.join(cwd, ".changeset", `renovate-${contentHash}.md`);
      await writeFile(filePath, content);
      return filePath;
    }),
  );

  return [...new Set(filePathList)].toSorted();
};

export const run = async ({
  cwd,
  templateFilePath,
  upgradeListString,
}: {
  cwd: string;
  templateFilePath: string | undefined;
  upgradeListString: string;
}): Promise<string[]> => {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const upgradeList = JSON.parse(Buffer.from(upgradeListString, "base64").toString("utf8")) as RenovateUpgrade[];
  const template =
    templateFilePath === undefined ? defaultTemplate : await readFile(path.resolve(cwd, templateFilePath), "utf8");
  const workspacePackageList = await getWorkspacePackageList(cwd);

  const resolvedUpgradeList = await resolveUpgrades({
    cwd,
    upgradeList: getUpgradeList(upgradeList),
    workspacePackageList,
  });

  return writeChangesets({ cwd, resolvedUpgradeList, template });
};

export const main = async (argumentList: string[] = hideBin(process.argv)): Promise<number> => {
  try {
    const argv = await yargs(argumentList)
      .scriptName("renovate-changesets")
      .command("$0 [upgradeListString]", "Create changesets for Renovate dependency updates.", (command) =>
        command.positional("upgradeListString", {
          describe: "Renovate's `upgrades` array, as base64-encoded JSON",
          type: "string",
        }),
      )
      .option("cwd", {
        default: process.cwd(),
        describe: "The repository root, when it isn't where the command runs.",
        normalize: true,
        type: "string",
      })
      .option("template-file-path", {
        describe: "The file path to a template that modifies how changesets are written.",
        normalize: true,
        type: "string",
      })
      .env("RENOVATE_CHANGESETS")
      .version(packageJson.version)
      .strict()
      .exitProcess(false)
      .fail(false)
      .parseAsync();

    if (argv.help === true || argv.version === true) {
      return 0;
    }

    await run({
      cwd: argv.cwd,
      templateFilePath: argv["template-file-path"],
      upgradeListString: typeof argv.upgradeListString === "string" ? argv.upgradeListString : "",
    });

    return 0;
  } catch (error) {
    /* v8 ignore next */
    logger.error(error instanceof Error ? error : new Error(String(error)));

    return 1;
  }
};
