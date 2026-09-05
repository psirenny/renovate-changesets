import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readConfig as readChangesetConfig } from "@changesets/config";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { configure, getLogger } from "@logtape/logtape";
import { getPackages } from "@manypkg/get-packages";
import Handlebars from "handlebars";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import packageJson from "../package.json" with { type: "json" };
import { readCargoManifests, resolveCargoPackagesBySharedUpgrade, type WorkspacePackage } from "./managers/cargo.js";
import { resolveNpmPackagesBySharedUpgrade } from "./managers/npm.js";
import { upgradeSchema, type Upgrade } from "./schema.js";
import { resolvePackageByFilePath } from "./workspace.js";

export type { WorkspacePackage } from "./managers/cargo.js";
export type { UpdateType, Upgrade } from "./schema.js";

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
{{#*inline "dependencyName"}}{{#if packageName}}{{packageName}}{{else}}{{depName}}{{/if}}{{/inline}}
{{#*inline "packageLink"}}{{#if sourceUrl}}[{{> dependencyName}}]({{sourceUrl}}){{else}}\`{{> dependencyName}}\`{{/if}}{{/inline}}
{{#*inline "securityTag"}}{{#if isVulnerabilityAlert}} [Security{{#if vulnerabilitySeverity}}: {{vulnerabilitySeverity}}{{/if}}]{{/if}}{{/inline}}
---
"{{changesetPackageName}}": patch
---

{{#if isLockFileMaintenance}}
Updated the \`{{manager}}\` lockfile.{{> securityTag}}
{{else if isReplacement}}
Replaced \`{{> dependencyName}}\` with \`{{newName}}\` \`{{displayTo}}\`.{{> securityTag}}
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

/** A {@link Upgrade} paired with a workspace package. */
export type PackageUpgrade = Upgrade & { changesetPackageName: string };

export const findWorkspacePackages = async ({ cwd }: { cwd: string }): Promise<WorkspacePackage[]> => {
  const workspace = await getPackages(cwd);
  const readChangesetConfigResult = await readChangesetConfig(cwd, workspace);

  if (readChangesetConfigResult.errors !== undefined) {
    throw new Error(`.changeset/config.json is invalid: ${readChangesetConfigResult.errors.join(", ")}`);
  }

  const { config: changesetConfig } = readChangesetConfigResult;

  return readCargoManifests({
    cwd,
    packageList: workspace.packages.filter(
      (_package) =>
        !shouldSkipPackage(_package, {
          allowPrivatePackages: changesetConfig.privatePackages.version,
          ignore: changesetConfig.ignore,
        }),
    ),
  });
};

export const resolvePackagesBySharedUpgrade = ({
  hasOwningPackage,
  packageList,
  upgrade,
}: {
  hasOwningPackage: boolean;
  packageList: WorkspacePackage[];
  upgrade: Upgrade;
}): string[] | null =>
  resolveNpmPackagesBySharedUpgrade({ hasOwningPackage, packageList, upgrade }) ??
  resolveCargoPackagesBySharedUpgrade({ packageList, upgrade });

export const mapUpgradesToPackages = async ({
  cwd,
  upgradeList,
}: {
  cwd: string;
  upgradeList: Upgrade[];
}): Promise<PackageUpgrade[]> => {
  const packageList = await findWorkspacePackages({ cwd });

  return upgradeList.flatMap((upgrade) => {
    const owningPackageName =
      resolvePackageByFilePath({ cwd, filePath: upgrade.packageFile, packageList })?.packageJson.name ?? null;

    const sharedPackageNameList = resolvePackagesBySharedUpgrade({
      hasOwningPackage: owningPackageName !== null,
      packageList,
      upgrade,
    });

    let packageNameList = sharedPackageNameList;

    if (packageNameList === null && owningPackageName !== null) {
      packageNameList = [owningPackageName];
    }

    return [...new Set(packageNameList)].map((changesetPackageName) => ({ ...upgrade, changesetPackageName }));
  });
};

export const writeChangesets = async ({
  cwd,
  resolvedUpgradeList,
  template,
}: {
  cwd: string;
  resolvedUpgradeList: PackageUpgrade[];
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
    .array(upgradeSchema)
    .parse(JSON.parse(Buffer.from(upgradeListString, "base64").toString("utf8")));

  const template =
    templateFilePath === undefined ? defaultTemplate : await readFile(path.resolve(cwd, templateFilePath), "utf8");

  const resolvedUpgradeList = await mapUpgradesToPackages({ cwd, upgradeList });

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
