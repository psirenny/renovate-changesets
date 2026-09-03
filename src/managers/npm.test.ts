import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { describe, expect, it } from "vitest";

import { resolveNpmPackagesByCatalogDependency, resolveNpmPackagesByOverrideDependency } from "./npm.js";

// Unreviewed
const buildPackage = ({
  name,
  packageJson = {},
}: {
  name: string;
  packageJson?: Record<string, unknown>;
}): Package => ({
  dir: path.join(process.cwd(), "packages", name),
  packageJson: { name, version: "1.0.0", ...packageJson },
  relativeDir: `packages/${name}`,
});

describe(resolveNpmPackagesByCatalogDependency, () => {
  const packageList = [
    buildPackage({ name: "bare-default", packageJson: { dependencies: { turbo: "catalog:" } } }),
    buildPackage({ name: "named-default", packageJson: { devDependencies: { turbo: "catalog:default" } } }),
    buildPackage({ name: "shared-dev", packageJson: { devDependencies: { turbo: "catalog:shared-dev" } } }),
    buildPackage({ name: "optional", packageJson: { optionalDependencies: { turbo: "catalog:shared-dev" } } }),
    buildPackage({ name: "peer", packageJson: { peerDependencies: { turbo: "catalog:shared-dev" } } }),
    buildPackage({ name: "pinned", packageJson: { dependencies: { turbo: "2.10.10" } } }),
    buildPackage({ name: "unrelated", packageJson: { dependencies: { other: "catalog:" } } }),
  ];

  it("Matches a bare catalog: and catalog:default for the default catalog", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        packageList,
        upgrade: { depName: "turbo", depType: "pnpm.catalog.default", packageFile: "pnpm-workspace.yaml" },
      }),
    ).toStrictEqual(["bare-default", "named-default"]);
  });

  it("Matches a named catalog in every dependency group", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        packageList,
        upgrade: { depName: "turbo", depType: "pnpm.catalog.shared-dev", packageFile: "pnpm-workspace.yaml" },
      }),
    ).toStrictEqual(["shared-dev", "optional", "peer"]);
  });

  it("Doesn't let a named catalog claim the packages on the default one", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        packageList,
        upgrade: { depName: "turbo", depType: "pnpm.catalog.react-19", packageFile: "pnpm-workspace.yaml" },
      }),
    ).toStrictEqual([]);
  });

  it("Ignores a package that pins the dependency itself", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        packageList: [buildPackage({ name: "pinned", packageJson: { dependencies: { turbo: "2.10.10" } } })],
        upgrade: { depName: "turbo", depType: "pnpm.catalog.default", packageFile: "pnpm-workspace.yaml" },
      }),
    ).toStrictEqual([]);
  });
});

describe(resolveNpmPackagesByOverrideDependency, () => {
  it("Names only the packages that declare the dependency themselves", () => {
    expect.hasAssertions();

    const packageList = [
      buildPackage({ name: "declares", packageJson: { dependencies: { minimatch: "^10.0.0" } } }),
      buildPackage({ name: "declares-dev", packageJson: { devDependencies: { minimatch: "^10.0.0" } } }),
      buildPackage({ name: "unrelated", packageJson: { dependencies: { ky: "^3.0.0" } } }),
    ];

    expect(
      resolveNpmPackagesByOverrideDependency({
        packageList,
        upgrade: { depName: "minimatch", depType: "overrides", packageFile: "package.json" },
      }),
    ).toStrictEqual(["declares", "declares-dev"]);
  });

  it("Names nothing when the override pins something transitive", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByOverrideDependency({
        packageList: [buildPackage({ name: "app", packageJson: { dependencies: { ky: "^3.0.0" } } })],
        upgrade: { depName: "minimatch", depType: "overrides", packageFile: "package.json" },
      }),
    ).toStrictEqual([]);
  });
});
