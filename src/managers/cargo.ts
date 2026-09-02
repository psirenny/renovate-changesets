import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { parse as parseToml } from "smol-toml";

const cargoDependencySectionList = ["build-dependencies", "dependencies", "dev-dependencies"] as const;

// A partial Cargo.toml manifest definition based on https://www.schemastore.org/cargo.json.
type CargoDependency = string | { workspace?: boolean };
type CargoDependencyTable = Record<string, CargoDependency>;
type CargoPlatform = Partial<Record<(typeof cargoDependencySectionList)[number], CargoDependencyTable>>;
type CargoManifest = CargoPlatform & { target?: Record<string, CargoPlatform> };

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
