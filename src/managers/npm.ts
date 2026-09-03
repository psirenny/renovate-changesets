import type { Package } from "@manypkg/get-packages";

const dependencyGroupList = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export const resolveNpmPackagesByCatalogDependency = ({
  catalogName,
  depName,
  packageList,
}: {
  catalogName: string;
  depName: string;
  packageList: Package[];
}): string[] =>
  packageList
    .filter((_package) =>
      dependencyGroupList.some((dependencyGroup) => {
        const version = _package.packageJson[dependencyGroup]?.[depName];
        return (version === "catalog:" ? "catalog:default" : version) === `catalog:${catalogName}`;
      }),
    )
    .map((_package) => _package.packageJson.name);

export const resolveNpmPackagesByOverrideDependency = ({
  depName,
  packageList,
}: {
  depName: string;
  packageList: Package[];
}): string[] =>
  packageList
    .filter((_package) =>
      dependencyGroupList.some((dependencyGroup) => _package.packageJson[dependencyGroup]?.[depName] !== undefined),
    )
    .map((_package) => _package.packageJson.name);
