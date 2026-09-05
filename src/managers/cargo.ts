import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { parse as parseToml } from "smol-toml";

import type { Upgrade } from "../schema.js";

const cargoDependencySectionList = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

// A partial Cargo.toml file based on https://www.schemastore.org/cargo.json.
type CargoDependency = string | { workspace?: boolean };
type CargoDependencyTable = Record<string, CargoDependency>;
type CargoPlatform = Partial<Record<(typeof cargoDependencySectionList)[number], CargoDependencyTable>>;
type CargoManifest = CargoPlatform & { target?: Record<string, CargoPlatform> };

const findCargoManifestFilePathList = async ({
  fileDirectory,
  packageFileDirectories,
}: {
  fileDirectory: string;
  packageFileDirectories: Set<string>;
}): Promise<string[]> => {
  const entryList = await readdir(fileDirectory, { withFileTypes: true });

  const nestedFilePathList = await Promise.all(
    entryList.map(async (entry) => {
      const filePath = path.join(fileDirectory, entry.name);

      if (!entry.isDirectory()) {
        return entry.name === "Cargo.toml" ? [filePath] : [];
      }

      return ["node_modules", "target"].includes(entry.name) || packageFileDirectories.has(path.resolve(filePath))
        ? []
        : findCargoManifestFilePathList({ fileDirectory: filePath, packageFileDirectories });
    }),
  );

  return nestedFilePathList.flat();
};

export const resolveCargoPackagesByWorkspaceDependency = async ({
  packageList,
  upgrade,
}: {
  packageList: Package[];
  upgrade: Upgrade;
}): Promise<string[] | null> => {
  const depName = upgrade.depName ?? null;

  if (depName === null || upgrade.depType !== "workspace.dependencies") {
    return null;
  }

  const packageFileDirectories = new Set(packageList.map((_package) => path.resolve(_package.dir)));

  const packageNameList = await Promise.all(
    packageList.map(async (_package) => {
      const manifestFilePathList = await findCargoManifestFilePathList({
        fileDirectory: _package.dir,
        packageFileDirectories: new Set(
          [...packageFileDirectories].filter((_fileDirectory) => _fileDirectory !== path.resolve(_package.dir)),
        ),
      });

      const inheritsWorkspaceDependencyList = await Promise.all(
        manifestFilePathList.map(async (manifestFilePath) => {
          const manifestContent = await readFile(manifestFilePath, "utf8");

          try {
            const manifest: CargoManifest = parseToml(manifestContent);

            const dependencyTableList = [
              ...cargoDependencySectionList.map((sectionName) => manifest[sectionName]),
              ...Object.values(manifest.target ?? {}).flatMap((platformSection) =>
                cargoDependencySectionList.map((sectionName) => platformSection[sectionName]),
              ),
            ];

            return dependencyTableList.some((table) => {
              const entry = table?.[depName];
              return typeof entry === "object" && entry.workspace === true;
            });
          } catch (error) {
            throw new Error(`Couldn't parse ${manifestFilePath}.`, { cause: error });
          }
        }),
      );

      return inheritsWorkspaceDependencyList.some(Boolean) ? _package.packageJson.name : null;
    }),
  );

  return packageNameList.filter((_packageName) => _packageName !== null);
};

export const resolveCargoPackagesBySharedUpgrade = async ({
  packageList,
  upgrade,
}: {
  packageList: Package[];
  upgrade: Upgrade;
}): Promise<string[] | null> =>
  upgrade.manager === "cargo" ? resolveCargoPackagesByWorkspaceDependency({ packageList, upgrade }) : null;
