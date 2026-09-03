import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { describe, expect, it } from "vitest";

import { resolveNpmPackagesByCatalogDependency, resolveNpmPackagesByOverrideDependency } from "./npm.js";

// Unreviewed
const buildPackage = (name: string, packageJson: Record<string, unknown> = {}): Package => ({
  dir: path.join(process.cwd(), "packages", name),
  packageJson: { name, version: "1.0.0", ...packageJson },
  relativeDir: `packages/${name}`,
});

describe(resolveNpmPackagesByCatalogDependency, () => {
  const packageList = [
    buildPackage("bare-default", { dependencies: { turbo: "catalog:" } }),
    buildPackage("named-default", { devDependencies: { turbo: "catalog:default" } }),
    buildPackage("shared-dev", { devDependencies: { turbo: "catalog:shared-dev" } }),
    buildPackage("optional", { optionalDependencies: { turbo: "catalog:shared-dev" } }),
    buildPackage("peer", { peerDependencies: { turbo: "catalog:shared-dev" } }),
    buildPackage("pinned", { dependencies: { turbo: "2.10.10" } }),
    buildPackage("unrelated", { dependencies: { other: "catalog:" } }),
  ];

  it("Matches a bare catalog: and catalog:default for the default catalog", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        catalogName: "default",
        depName: "turbo",
        packageList,
      }),
    ).toStrictEqual(["bare-default", "named-default"]);
  });

  it("Matches a named catalog in every dependency group", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        catalogName: "shared-dev",
        depName: "turbo",
        packageList,
      }),
    ).toStrictEqual(["shared-dev", "optional", "peer"]);
  });

  it("Doesn't let a named catalog claim the packages on the default one", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        catalogName: "react-19",
        depName: "turbo",
        packageList,
      }),
    ).toStrictEqual([]);
  });

  it("Ignores a package that pins the dependency itself", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByCatalogDependency({
        catalogName: "default",
        depName: "turbo",
        packageList: [buildPackage("pinned", { dependencies: { turbo: "2.10.10" } })],
      }),
    ).toStrictEqual([]);
  });
});

describe(resolveNpmPackagesByOverrideDependency, () => {
  it("Names only the packages that declare the dependency themselves", () => {
    expect.hasAssertions();

    const packageList = [
      buildPackage("declares", { dependencies: { minimatch: "^10.0.0" } }),
      buildPackage("declares-dev", { devDependencies: { minimatch: "^10.0.0" } }),
      buildPackage("unrelated", { dependencies: { ky: "^3.0.0" } }),
    ];

    expect(resolveNpmPackagesByOverrideDependency({ depName: "minimatch", packageList })).toStrictEqual([
      "declares",
      "declares-dev",
    ]);
  });

  it("Names nothing when the override pins something transitive", () => {
    expect.hasAssertions();

    expect(
      resolveNpmPackagesByOverrideDependency({
        depName: "minimatch",
        packageList: [buildPackage("app", { dependencies: { ky: "^3.0.0" } })],
      }),
    ).toStrictEqual([]);
  });
});
