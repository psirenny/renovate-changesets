import type { Package } from "@manypkg/get-packages";

import type { Upgrade } from "../schema.js";

const dependencyGroupList = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export const resolveNpmPackagesByCatalogDependency = ({
  packageList,
  upgrade,
}: {
  packageList: Package[];
  upgrade: Upgrade;
}): string[] | null => {
  const packageOrDepName = upgrade.packageName ?? upgrade.depName ?? null;

  if (packageOrDepName === null) {
    return null;
  }

  const catalogName =
    /^(?:pnpm|yarn)\.catalog\.(?<catalogName>.+)$/u.exec(upgrade.depType ?? "")?.groups?.catalogName ?? null;

  return catalogName === null
    ? null
    : packageList
        .filter((_package) =>
          dependencyGroupList.some((dependencyGroup) => {
            const version = _package.packageJson[dependencyGroup]?.[packageOrDepName];
            return (version === "catalog:" ? "catalog:default" : version) === `catalog:${catalogName}`;
          }),
        )
        .map((_package) => _package.packageJson.name);
};

export const resolveNpmPackagesByOverrideDependency = ({
  packageList,
  upgrade,
}: {
  packageList: Package[];
  upgrade: Upgrade;
}): string[] | null => {
  const packageOrDepName = upgrade.packageName ?? upgrade.depName ?? null;

  if (packageOrDepName === null) {
    return null;
  }

  const isOverride = ["overrides", "pnpm-workspace.overrides", "pnpm.overrides", "resolutions"].includes(
    upgrade.depType ?? "",
  );

  return isOverride
    ? packageList
        .filter((_package) =>
          dependencyGroupList.some(
            (dependencyGroup) => _package.packageJson[dependencyGroup]?.[packageOrDepName] !== undefined,
          ),
        )
        .map((_package) => _package.packageJson.name)
    : null;
};

export const resolveNpmPackagesBySharedUpgrade = ({
  hasOwningPackage,
  packageList,
  upgrade,
}: {
  hasOwningPackage: boolean;
  packageList: Package[];
  upgrade: Upgrade;
}): string[] | null => {
  const catalogPackageNameList = resolveNpmPackagesByCatalogDependency({ packageList, upgrade });

  if (catalogPackageNameList !== null) {
    return catalogPackageNameList;
  }

  if (!hasOwningPackage) {
    return resolveNpmPackagesByOverrideDependency({ packageList, upgrade });
  }

  return null;
};
