import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readConfig as readChangesetConfig } from "@changesets/config";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { configure, getLogger } from "@logtape/logtape";
import { getPackages, type Package } from "@manypkg/get-packages";
import Handlebars from "handlebars";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import packageJson from "../package.json" with { type: "json" };
import { resolveCargoPackagesByWorkspaceDependency } from "./managers/cargo.js";
import { resolveNpmPackagesByCatalogDependency, resolveNpmPackagesByOverrideDependency } from "./managers/npm.js";
import { renovateUpgradeSchema, type RenovateUpgrade } from "./schema.js";

export type { RenovateUpdateType, RenovateUpgrade } from "./schema.js";

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
{{#*inline "packageLink"}}{{#if sourceUrl}}[{{packageName}}]({{sourceUrl}}){{else}}\`{{packageName}}\`{{/if}}{{/inline}}
{{#*inline "securityTag"}}{{#if isVulnerabilityAlert}} [Security{{#if vulnerabilitySeverity}}: {{vulnerabilitySeverity}}{{/if}}]{{/if}}{{/inline}}
---
"{{changesetPackageName}}": patch
---

{{#if isReplacement}}
Replaced \`{{packageName}}\` with \`{{newName}}\` \`{{displayTo}}\`.{{> securityTag}}
{{else if isRollback}}
Rolled back {{> packageLink}} to \`{{displayTo}}\`.{{> securityTag}}
{{else if isPin}}
Pinned {{> packageLink}} to \`{{displayTo}}\`.{{> securityTag}}
{{else if isPinDigest}}
Pinned {{> packageLink}} to \`{{displayTo}}\`.{{> securityTag}}
{{else}}
Updated {{> packageLink}}{{#if displayFrom}} from \`{{displayFrom}}\`{{/if}} to \`{{displayTo}}\`.{{> securityTag}}
{{/if}}
`;

/** A {@link RenovateUpgrade} paired with one workspace package whose changelog should record it. */
export type ResolvedRenovateUpgrade = RenovateUpgrade & { changesetPackageName: string };

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

    // Renovate pads `packageName` with `depName`, so the two only differ when the extractor parsed a cleaner name out
    // of an override selector like "minimatch@>=10.0.0 <10.2.3". An upgrade is only junk when even that name is a
    // version range rather than a dependency name.
    if (/[\s<>]/u.test(upgrade.packageName ?? depName)) {
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

export const getPackageList = async ({ cwd }: { cwd: string }): Promise<Package[]> => {
  const workspace = await getPackages(cwd);
  const changesetConfig = await readChangesetConfig(cwd, workspace);

  if (changesetConfig.errors !== undefined) {
    throw new Error(`.changeset/config.json is invalid: ${changesetConfig.errors.join(", ")}`);
  }

  return workspace.packages.filter(
    (_package) =>
      !shouldSkipPackage(_package, {
        allowPrivatePackages: changesetConfig.config.privatePackages.version,
        ignore: changesetConfig.config.ignore,
      }),
  );
};

export const resolveDependency = ({
  cwd,
  packageList,
  upgrade,
}: {
  cwd: string;
  packageList: Package[];
  upgrade: RenovateUpgrade;
}): string | null => {
  const packageFile = upgrade.packageFile ?? null;

  if (packageFile === null) {
    return null;
  }

  const resolvedManifestFilePath = path.resolve(cwd, packageFile);

  return (
    packageList
      // ✓ Includes — manifests inside the workspace package.
      //   - "/packages/foo", "/packages/foo/manifest.json"     => "manifest.json"
      //   - "/packages/foo", "/packages/foo/bar/manifest.json" => "bar/manifest.json"
      //
      // ✗ Rejects — manifests outside it, including a sibling whose name shares a prefix.
      //   - "/packages/foo", "/packages/bar/manifest.json"    => "../bar/manifest.json"
      //   - "/packages/foo", "/packages/foobar/manifest.json" => "../foobar/manifest.json"
      .filter((_package) => {
        const relativeFilePath = path.relative(path.resolve(_package.dir), resolvedManifestFilePath);
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

/**
 * Expands an upgrade whose declaration states one version on behalf of other packages — a catalog entry or a Cargo
 * `[workspace.dependencies]` — to every package that consumes it. Returns `null` when the upgrade names no shared
 * declaration this understands, leaving it to ownership.
 */
export const getSharedDeclarationPackageNameList = async ({
  isOwned,
  packageList,
  upgrade,
}: {
  isOwned: boolean;
  packageList: Package[];
  upgrade: RenovateUpgrade;
}): Promise<string[] | null> => {
  const { depName = null, depType = null } = upgrade;
  const { packageName = depName ?? null } = upgrade;

  if (depName === null || depType === null || packageName === null) {
    return null;
  }

  const npmCatalogName = /^(?:pnpm|yarn)\.catalog\.(?<catalogName>.+)$/u.exec(depType)?.groups?.catalogName;
  if (npmCatalogName !== undefined) {
    return resolveNpmPackagesByCatalogDependency({
      catalogName: npmCatalogName,
      depName: packageName,
      packageList,
    });
  }

  if (upgrade.manager === "cargo" && depType === "workspace.dependencies") {
    return resolveCargoPackagesByWorkspaceDependency({ depName: packageName, packageList });
  }

  // A single-package repository keeps overrides in the one `package.json` it has, where ownership already gives the
  // right answer, so they only expand once no package owns the manifest.
  if (!isOwned && ["overrides", "pnpm-workspace.overrides", "pnpm.overrides", "resolutions"].includes(depType)) {
    return resolveNpmPackagesByOverrideDependency({ depName: packageName, packageList });
  }

  return null;
};

export const resolveDependencies = async ({
  cwd,
  packageList,
  upgradeList,
}: {
  cwd: string;
  packageList: Package[];
  upgradeList: RenovateUpgrade[];
}): Promise<ResolvedRenovateUpgrade[]> => {
  const resolvedUpgradeList = await Promise.all(
    upgradeList.map(async (upgrade) => {
      const owningPackageName = resolveDependency({ cwd, packageList, upgrade });
      const sharedPackageNameList = await getSharedDeclarationPackageNameList({
        isOwned: owningPackageName !== null,
        packageList,
        upgrade,
      });
      const packageNameList = sharedPackageNameList ?? (owningPackageName === null ? [] : [owningPackageName]);

      return [...new Set(packageNameList)].map((changesetPackageName) => ({ ...upgrade, changesetPackageName }));
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
}): Promise<void> => {
  await Promise.all(
    resolvedUpgradeList.map(async (resolvedUpgrade) => {
      let content = Handlebars.compile(template, { noEscape: true, strict: true })(resolvedUpgrade);
      content = `${content.replaceAll(/\n{3,}/gu, "\n\n").trim()}\n`;
      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 8);
      await writeFile(path.join(cwd, ".changeset", `renovate-${contentHash}.md`), content);
    }),
  );
};

export const run = async ({
  cwd,
  templateFilePath,
  upgradeListString,
}: {
  cwd: string;
  templateFilePath: string | undefined;
  upgradeListString: string;
}): Promise<void> => {
  const upgradeList = z
    .array(renovateUpgradeSchema)
    .parse(JSON.parse(Buffer.from(upgradeListString, "base64").toString("utf8")));

  const template =
    templateFilePath === undefined ? defaultTemplate : await readFile(path.resolve(cwd, templateFilePath), "utf8");
  const packageList = await getPackageList({ cwd });

  const resolvedUpgradeList = await resolveDependencies({
    cwd,
    packageList,
    upgradeList: getUpgradeList(upgradeList),
  });

  await writeChangesets({ cwd, resolvedUpgradeList, template });
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
