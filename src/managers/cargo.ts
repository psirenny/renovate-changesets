import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { parse as parseToml } from "smol-toml";

const cargoDependencySectionList = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

// A partial Cargo.toml file based on https://www.schemastore.org/cargo.json.
type CargoDependency = string | { workspace?: boolean };
type CargoDependencyTable = Record<string, CargoDependency>;
type CargoPlatform = Partial<Record<(typeof cargoDependencySectionList)[number], CargoDependencyTable>>;
type CargoManifest = CargoPlatform & { target?: Record<string, CargoPlatform> };

const readCargoDependencyTableList = (manifest: CargoManifest): (CargoDependencyTable | undefined)[] => [
  ...cargoDependencySectionList.map((sectionName) => manifest[sectionName]),
  ...Object.values(manifest.target ?? {}).flatMap((platformSection) =>
    cargoDependencySectionList.map((sectionName) => platformSection[sectionName]),
  ),
];

export const resolveCargoPackagesByWorkspaceDependency = async ({
  depName,
  packageList,
}: {
  depName: string;
  packageList: Package[];
}): Promise<string[]> => {
  const packageNameList = await Promise.all(
    packageList.map(async (_package) => {
      const manifestFilePath = path.join(_package.dir, "Cargo.toml");
      const manifestContent = await readFile(manifestFilePath, "utf8").catch(() => null);

      if (manifestContent === null) {
        return null;
      }

      try {
        const manifest: CargoManifest = parseToml(manifestContent);

        const inheritsWorkspaceDependency = readCargoDependencyTableList(manifest).some((table) => {
          const entry = table?.[depName];
          return typeof entry === "object" && entry.workspace === true;
        });

        return inheritsWorkspaceDependency ? _package.packageJson.name : null;
      } catch (error) {
        throw new Error(`Couldn't parse ${manifestFilePath}.`, { cause: error });
      }
    }),
  );

  return packageNameList.filter((packageName) => packageName !== null);
};
