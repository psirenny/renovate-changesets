import type { Package } from "@manypkg/get-packages";

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
