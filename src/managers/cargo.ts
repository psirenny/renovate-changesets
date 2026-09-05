import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { parse as parseToml } from "smol-toml";

import type { Upgrade } from "../schema.js";
import { resolvePackageByFilePath } from "../workspace.js";

const cargoDependencySectionList = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

// A partial Cargo.toml file based on https://www.schemastore.org/cargo.json.
type CargoDependency = string | { workspace?: boolean };
type CargoDependencyTable = Record<string, CargoDependency>;
type CargoPlatform = Partial<Record<(typeof cargoDependencySectionList)[number], CargoDependencyTable>>;
export type CargoManifest = CargoPlatform & { target?: Record<string, CargoPlatform> };

export type WorkspacePackage = Package & { cargoManifestList: CargoManifest[] };

export const readCargoManifests = async ({
  cwd,
  packageList,
}: {
  cwd: string;
  packageList: Package[];
}): Promise<WorkspacePackage[]> => {
  const manifestFilePathList = await Array.fromAsync(
    glob("**/Cargo.toml", { cwd, exclude: ["**/node_modules/**", "**/target/**"] }),
  );

  return Promise.all(
    packageList.map(async (_package) => ({
      ..._package,
      cargoManifestList: await Promise.all(
        manifestFilePathList
          .filter(
            (manifestFilePath) =>
              resolvePackageByFilePath({ cwd, filePath: manifestFilePath, packageList }) === _package,
          )
          .map(async (manifestFilePath): Promise<CargoManifest> => {
            const manifestContent = await readFile(path.resolve(cwd, manifestFilePath), "utf8");

            try {
              return parseToml(manifestContent);
            } catch (error) {
              throw new Error(`Couldn't parse ${manifestFilePath}.`, { cause: error });
            }
          }),
      ),
    })),
  );
};

export const resolveCargoPackagesByWorkspaceDependency = ({
  packageList,
  upgrade,
}: {
  packageList: WorkspacePackage[];
  upgrade: Upgrade;
}): string[] | null => {
  const depName = upgrade.depName ?? null;

  if (depName === null || upgrade.depType !== "workspace.dependencies") {
    return null;
  }

  return packageList
    .filter((_package) =>
      _package.cargoManifestList.some((manifest) =>
        [manifest, ...Object.values(manifest.target ?? {})].some((platform) =>
          cargoDependencySectionList.some((sectionName) => {
            const entry = platform[sectionName]?.[depName];
            return typeof entry === "object" && entry.workspace === true;
          }),
        ),
      ),
    )
    .map((_package) => _package.packageJson.name);
};

export const resolveCargoPackagesBySharedUpgrade = ({
  packageList,
  upgrade,
}: {
  packageList: WorkspacePackage[];
  upgrade: Upgrade;
}): string[] | null =>
  upgrade.manager === "cargo" ? resolveCargoPackagesByWorkspaceDependency({ packageList, upgrade }) : null;
