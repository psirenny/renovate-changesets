import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fc, test as propertyTest } from "@fast-check/vitest";
import { configure, getLogger, reset } from "@logtape/logtape";
import { createLogRecorder } from "@logtape/testing/recorder";
import type { Package } from "@manypkg/get-packages";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  DEFAULT_TEMPLATE,
  getCargoWorkspacePackageNameList,
  getCatalogPackageNameList,
  getOverridePackageNameList,
  getOwningPackageName,
  getSharedDeclarationPackageNameList,
  configureLogging,
  getWorkspacePackageList,
  main,
  parseArguments,
  parseUpdates,
  renderChangeset,
  run,
  type RenovateUpdateType,
  type RenovateUpgrade,
  type ResolvedUpdate,
  type Update,
} from "./index.js";

// Unreviewed
/** Encodes upgrades the way Renovate's `{{{encodeBase64 (toJSON upgrades)}}}` does. */
const encodeUpgradeList = (upgradeList: RenovateUpgrade[]): string =>
  Buffer.from(JSON.stringify(upgradeList), "utf8").toString("base64");

// Unreviewed
const removeWorkspace = async (directory: string): Promise<void> => {
  await rm(directory, { force: true, recursive: true });
};

// Unreviewed
/** Writes a minimal single-package or multi-package workspace with exactly the shape a test asks for. */
const createWorkspace = async (fileMap: Record<string, string>): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "renovate-changesets-"));

  onTestFinished(async () => {
    await removeWorkspace(directory);
  });

  await Promise.all(
    Object.entries(fileMap).map(async ([relativePath, content]) => {
      const filePath = path.join(directory, relativePath);

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }),
  );

  return directory;
};

// Unreviewed
/** Reads the changesets this tool wrote, sorted by file name and ignoring anything else in the directory. */
const readChangesetList = async (directory: string): Promise<{ content: string; fileName: string }[]> => {
  const changesetsDirectory = path.join(directory, ".changeset");
  const fileNameList = await readdir(changesetsDirectory);

  return Promise.all(
    fileNameList
      .filter((fileName) => fileName.startsWith("renovate-") && fileName.endsWith(".md"))
      .toSorted()
      .map(async (fileName) => ({
        content: await readFile(path.join(changesetsDirectory, fileName), "utf8"),
        fileName,
      })),
  );
};

// Unreviewed
const buildPackage = (name: string, packageJson: Record<string, unknown> = {}): Package => ({
  dir: path.join(process.cwd(), "packages", name),
  packageJson: { name, version: "1.0.0", ...packageJson },
  relativeDir: `packages/${name}`,
});

// Unreviewed
const parseOne = (upgrade: RenovateUpgrade): Update[] => parseUpdates(encodeUpgradeList([upgrade]));

// This package's records go nowhere until something configures a sink, so the suite points the category at a recorder
// and reads what a real run would have written to standard error.
const recorder = createLogRecorder();

describe(parseUpdates, () => {
  beforeAll(async () => {
    await configure({
      loggers: [
        // LogTape's own diagnostics get the recorder too, so a misconfigured suite surfaces instead of vanishing.
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["recorder"] },
        { category: "renovate-changesets", lowestLevel: "warning", sinks: ["recorder"] },
      ],
      reset: true,
      sinks: { recorder: recorder.sink },
    });
  });

  beforeEach(() => {
    recorder.clear();
  });

  afterAll(async () => {
    await reset();
  });

  it("Reads an empty payload as no updates", () => {
    expect.hasAssertions();

    expect(parseUpdates("")).toStrictEqual([]);
  });

  it("Throws when the payload isn't an array, because that means the consumer's template broke", () => {
    expect.hasAssertions();

    // `e30=` is base64 for `{}` — decodable JSON, but not the array Renovate is supposed to send. The shape is
    // trusted rather than checked, so this surfaces as the array method being missing.
    expect(() => parseUpdates("e30=")).toThrow(TypeError);
    expect(() => parseUpdates("e30=")).toThrow(/is not a function/u);
  });

  it("Throws when the payload isn't decodable JSON", () => {
    expect.hasAssertions();

    expect(() => parseUpdates("not base64 encoded json")).toThrow(/JSON/u);
  });

  it("Carries every field a template might name", () => {
    expect.hasAssertions();

    expect(
      parseOne({
        currentValue: "^1.10.10",
        currentVersion: "1.10.10",
        datasource: "npm",
        depName: "oxlint",
        depType: "devDependencies",
        manager: "npm",
        newValue: "^2.10.11",
        newVersion: "2.10.11",
        packageFile: "packages/example/package.json",
        updateType: "minor",
      }),
    ).toStrictEqual([
      {
        currentDigest: null,
        currentValue: "^1.10.10",
        currentVersion: "1.10.10",
        datasource: "npm",
        dependencyName: "oxlint",
        dependencyType: "devDependencies",
        fromVersion: "1.10.10",
        manager: "npm",
        manifestFilePath: "packages/example/package.json",
        newDigest: null,
        newName: null,
        newValue: "^2.10.11",
        newVersion: "2.10.11",
        toVersion: "2.10.11",
        updateType: "minor",
      },
    ]);
  });

  it("Skips an upgrade with no dependency name, which is what lockFileMaintenance sends", () => {
    expect.hasAssertions();

    const upgrade = { packageFile: "pnpm-lock.yaml", updateType: "lockFileMaintenance" } as const;

    expect(parseOne(upgrade)).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no dependency name or manifest path/u });
  });

  it("Skips an upgrade with no manifest path", () => {
    expect.hasAssertions();

    expect(parseOne({ depName: "ky", newVersion: "3.0.0" })).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no dependency name or manifest path/u });
  });

  it.each([
    ["minimatch@>=10.0.0 <10.2.3", "a security-range override key"],
    ["foo>bar", "a nested override path"],
    ["some package", "a name with a space"],
  ])("Skips %s, which is %s rather than a dependency name", (depName) => {
    expect.hasAssertions();

    const upgrade = { depName, newVersion: "1.0.0", packageFile: "package.json" } as const;

    expect(parseOne(upgrade)).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /version range rather than a dependency name/u });
  });

  it("Skips an upgrade Renovate reported with no version and no digest", () => {
    expect.hasAssertions();

    const upgrade = { depName: "ky", newValue: "^3.0.0", packageFile: "package.json", updateType: "patch" } as const;

    expect(parseOne(upgrade)).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no version and no digest/u });
  });

  it("Names a replacement by its newValue, since Renovate sends it no newVersion", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      currentValue: "^2.0.2",
      currentVersion: "2.0.2",
      depName: "ky",
      newName: "some-fork",
      newValue: "3.0.0",
      packageFile: "packages/app/package.json",
      updateType: "replacement",
    });

    expect(update).toMatchObject({
      dependencyName: "ky",
      fromVersion: "2.0.2",
      newName: "some-fork",
      newValue: "3.0.0",
      newVersion: null,
      toVersion: "3.0.0",
      updateType: "replacement",
    });
  });

  it("Normalizes an isReplacement flag that arrived without an updateType", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      depName: "ky",
      isReplacement: true,
      newName: "some-fork",
      newValue: "3.0.0",
      packageFile: "packages/app/package.json",
    });

    expect(update?.updateType).toBe("replacement");
    expect(update?.toVersion).toBe("3.0.0");
  });

  it("Never falls back to newValue outside a replacement, which would claim an update to the current version", () => {
    expect.hasAssertions();

    const upgrade = {
      currentValue: "^2.0.2",
      currentVersion: "2.0.2",
      depName: "ky",
      newValue: "^2.0.2",
      packageFile: "packages/app/package.json",
      updateType: "patch",
    } as const;

    expect(parseOne(upgrade)).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no version and no digest/u });
  });

  it("Lets a tag win over a digest when a version update changed both", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      currentDigest: "sha256:aaaaaaaaaaaaaaaa",
      currentVersion: "1.0.0-rc.2",
      depName: "rustfs/rustfs",
      newDigest: "sha256:bbbbbbbbbbbbbbbb",
      newVersion: "1.0.0-rc.3",
      packageFile: "packages/rustfs/Dockerfile.musl",
      updateType: "patch",
    });

    expect(update).toMatchObject({ fromVersion: "1.0.0-rc.2", toVersion: "1.0.0-rc.3" });
  });

  it("Lets the digest win on a digest update, where Renovate leaves the tag untouched", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      currentDigest: "sha256:032b412aaaaaaaaa",
      currentVersion: "1.0.0",
      depName: "timescaledb",
      newDigest: "sha256:cf49c5dbbbbbbbbb",
      newValue: "1.0.0",
      newVersion: "1.0.0",
      packageFile: "packages/martin/docker-compose.seed.yaml",
      updateType: "digest",
    });

    expect(update).toMatchObject({ fromVersion: "sha256:032b412", toVersion: "sha256:cf49c5d" });
  });

  it("Names the tag it came from when pinning a digest for the first time", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      currentValue: "v7.0.1",
      currentVersion: "7.0.1",
      depName: "actions/checkout",
      newDigest: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      newValue: "v7.0.1",
      packageFile: ".github/workflows/ci.yaml",
      updateType: "pinDigest",
    });

    expect(update).toMatchObject({ fromVersion: "7.0.1", toVersion: "3d3c42e" });
  });

  it("Keeps a rollback's update type so a template can phrase it differently", () => {
    expect.hasAssertions();

    const [update] = parseOne({
      currentVersion: "2.10.11",
      depName: "turbo",
      newVersion: "2.10.10",
      packageFile: "packages/app/package.json",
      updateType: "rollback",
    });

    expect(update).toMatchObject({ fromVersion: "2.10.11", toVersion: "2.10.10", updateType: "rollback" });
  });

  it("Reads every upgrade in the payload", () => {
    expect.hasAssertions();

    const updateList = parseUpdates(
      encodeUpgradeList([
        { depName: "a", newVersion: "1.0.0", packageFile: "packages/a/package.json" },
        { depName: "b", newVersion: "2.0.0", packageFile: "packages/b/package.json" },
      ]),
    );

    expect(updateList.map((update) => update.dependencyName)).toStrictEqual(["a", "b"]);
  });
});

type DigestCase = { digest: string | null; label: string; shortened: string | null };

const FROM_DIGEST_CASE_LIST: DigestCase[] = [
  { digest: "sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f9", label: "sha256", shortened: "sha256:0a1b2c3" },
  { digest: "sha512:0a1b2c3d4e5f60718293a4b5c6d7e8f9", label: "sha512", shortened: "sha512:0a1b2c3" },
  { digest: "0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3", label: "bare", shortened: "0a1b2c3" },
  { digest: null, label: "none", shortened: null },
];

const TO_DIGEST_CASE_LIST: DigestCase[] = [
  { digest: "sha256:9f8e7d6c5b4a30291817263544536271", label: "sha256", shortened: "sha256:9f8e7d6" },
  { digest: "sha512:9f8e7d6c5b4a30291817263544536271", label: "sha512", shortened: "sha512:9f8e7d6" },
  { digest: "9f8e7d6c5b4a302918172635445362719a8b7c6d", label: "bare", shortened: "9f8e7d6" },
  { digest: null, label: "none", shortened: null },
];

const FROM_VERSION_CASE_LIST = [
  { label: "version", version: "1.2.3" },
  { label: "none", version: null },
];

const TO_VERSION_CASE_LIST = [
  { label: "version", version: "4.5.6" },
  { label: "none", version: null },
];

const UPDATE_TYPE_CASE_LIST: { isDigestUpdate: boolean; updateType: RenovateUpdateType }[] = [
  { isDigestUpdate: false, updateType: "patch" },
  { isDigestUpdate: true, updateType: "digest" },
];

// Unreviewed
// Written as an explicit decision on the case labels rather than as a coalescing chain, so a change to the
// implementation's precedence has to be justified against this rather than mirrored by it.
const expectSide = (version: string | null, digest: DigestCase, isDigestUpdate: boolean): string | null => {
  if (isDigestUpdate) {
    if (digest.shortened !== null) {
      return digest.shortened;
    }

    return version;
  }

  if (version !== null) {
    return version;
  }

  return digest.shortened;
};

type SelectionCase = {
  expectedFromVersion: string | null;
  expectedToVersion: string | null;
  label: string;
  upgrade: RenovateUpgrade;
};

// Unreviewed
/** The `{ fromVersion, toVersion }` pairs a case expects — none at all when the case selects no version. */
const buildExpectedVersionPairList = (
  selectionCase: SelectionCase,
): { fromVersion: string | null; toVersion: string | null }[] =>
  selectionCase.expectedToVersion === null
    ? []
    : [{ fromVersion: selectionCase.expectedFromVersion, toVersion: selectionCase.expectedToVersion }];

// Unreviewed
const buildCaseList = (): SelectionCase[] => {
  const caseList: SelectionCase[] = [];

  for (const { isDigestUpdate, updateType } of UPDATE_TYPE_CASE_LIST) {
    for (const fromVersionCase of FROM_VERSION_CASE_LIST) {
      for (const fromDigestCase of FROM_DIGEST_CASE_LIST) {
        for (const toVersionCase of TO_VERSION_CASE_LIST) {
          for (const toDigestCase of TO_DIGEST_CASE_LIST) {
            caseList.push({
              expectedFromVersion: expectSide(fromVersionCase.version, fromDigestCase, isDigestUpdate),
              expectedToVersion: expectSide(toVersionCase.version, toDigestCase, isDigestUpdate),
              label: [
                updateType,
                `from ${fromVersionCase.label}/${fromDigestCase.label}`,
                `to ${toVersionCase.label}/${toDigestCase.label}`,
              ].join(" "),
              upgrade: {
                currentDigest: fromDigestCase.digest,
                currentVersion: fromVersionCase.version,
                depName: "example",
                newDigest: toDigestCase.digest,
                newVersion: toVersionCase.version,
                packageFile: "packages/example/package.json",
                updateType,
              },
            });
          }
        }
      }
    }
  }

  return caseList;
};

const CASE_LIST = buildCaseList();

describe("Version selection", () => {
  it("Covers every combination of from side, to side, digest algorithm, and update type", () => {
    expect.hasAssertions();

    expect(CASE_LIST).toHaveLength(128);
  });

  it.each(CASE_LIST.map((selectionCase) => [selectionCase.label, selectionCase] as const))(
    "Selects %s",
    (_label, selectionCase) => {
      expect.hasAssertions();

      const updateList = parseUpdates(encodeUpgradeList([selectionCase.upgrade]));

      expect(updateList.map(({ fromVersion, toVersion }) => ({ fromVersion, toVersion }))).toStrictEqual(
        buildExpectedVersionPairList(selectionCase),
      );
    },
  );
});

// Renovate reports `packageFile` relative to the repository root, which is what `ROOT_DIRECTORY` stands in for.
const ROOT_DIRECTORY = path.resolve("/workspace");

// Unreviewed
const buildOwnedPackage = (relativeDir: string, name: string): Package => ({
  dir: path.join(ROOT_DIRECTORY, relativeDir),
  packageJson: { name, version: "1.0.0" },
  relativeDir,
});

const PACKAGE_LIST = [
  buildOwnedPackage("packages/app", "@fixture/app"),
  buildOwnedPackage("packages/parent", "@fixture/parent"),
  buildOwnedPackage("packages/parent/child", "@fixture/child"),
  buildOwnedPackage("packages/app-extras", "@fixture/app-extras"),
];

describe(getWorkspacePackageList, () => {
  // The missing-config path logs, and a lazy log callback only runs when a sink is listening.
  const configRecorder = createLogRecorder();

  beforeAll(async () => {
    await configure({
      loggers: [
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["recorder"] },
        { category: "renovate-changesets", lowestLevel: "warning", sinks: ["recorder"] },
      ],
      reset: true,
      sinks: { recorder: configRecorder.sink },
    });
  });

  beforeEach(() => {
    configRecorder.clear();
  });

  afterAll(async () => {
    await reset();
  });

  it("Falls back and says so when the repository has no Changesets config", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "package.json": '{ "name": "root", "private": true, "version": "0.0.0" }\n',
      "packages/app/package.json": '{ "name": "@fixture/app", "version": "1.0.0" }\n',
      "pnpm-workspace.yaml": "packages:\n  - packages/app\n",
    });
    const packageList = await getWorkspacePackageList(directory);

    expect(packageList.map((workspacePackage) => workspacePackage.packageJson.name)).toStrictEqual(["@fixture/app"]);
    configRecorder.assertLogged({ level: "warning", message: /No \.changeset\/config\.json/u });
  });

  it("Rethrows when the config could not be read for any other reason", async () => {
    expect.hasAssertions();

    // A directory where the config file belongs rejects with EISDIR rather than ENOENT.
    const directory = await createWorkspace({
      ".changeset/config.json/placeholder": "",
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });

    await expect(getWorkspacePackageList(directory)).rejects.toThrow(/EISDIR|illegal operation on a directory/u);
  });
});

describe(getOwningPackageName, () => {
  it("Gives a package its own manifest", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/app/package.json", ROOT_DIRECTORY)).toBe("@fixture/app");
  });

  it("Gives a package a manifest nested inside it", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/app/docker/docker-compose.yaml", ROOT_DIRECTORY)).toBe(
      "@fixture/app",
    );
  });

  it("Gives a nested package its own manifests rather than the parent's", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/parent/child/package.json", ROOT_DIRECTORY)).toBe(
      "@fixture/child",
    );
  });

  it("Still gives the parent the manifests that aren't inside the nested package", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/parent/Dockerfile", ROOT_DIRECTORY)).toBe("@fixture/parent");
  });

  it("Doesn't let a sibling whose name shares a prefix claim the manifest", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/app-extras/package.json", ROOT_DIRECTORY)).toBe(
      "@fixture/app-extras",
    );
  });

  it("Gives a repository-root manifest to nobody", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "mise.toml", ROOT_DIRECTORY)).toBeNull();
    expect(getOwningPackageName(PACKAGE_LIST, "pnpm-workspace.yaml", ROOT_DIRECTORY)).toBeNull();
    expect(getOwningPackageName(PACKAGE_LIST, ".github/workflows/ci.yaml", ROOT_DIRECTORY)).toBeNull();
  });

  it("Gives a manifest in an unrelated directory to nobody", () => {
    expect.hasAssertions();

    expect(getOwningPackageName(PACKAGE_LIST, "packages/not-a-package/package.json", ROOT_DIRECTORY)).toBeNull();
  });

  it("Gives everything to the one package in a single-package repository", () => {
    expect.hasAssertions();

    const singlePackageList = [buildOwnedPackage(".", "solo")];

    expect(getOwningPackageName(singlePackageList, "package.json", ROOT_DIRECTORY)).toBe("solo");
    expect(getOwningPackageName(singlePackageList, "mise.toml", ROOT_DIRECTORY)).toBe("solo");
    expect(getOwningPackageName(singlePackageList, "docker/Dockerfile", ROOT_DIRECTORY)).toBe("solo");
  });
});

describe(getCatalogPackageNameList, () => {
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

    expect(getCatalogPackageNameList(packageList, "default", "turbo")).toStrictEqual(["bare-default", "named-default"]);
  });

  it("Matches a named catalog in every dependency group", () => {
    expect.hasAssertions();

    expect(getCatalogPackageNameList(packageList, "shared-dev", "turbo")).toStrictEqual([
      "shared-dev",
      "optional",
      "peer",
    ]);
  });

  it("Doesn't let a named catalog claim the packages on the default one", () => {
    expect.hasAssertions();

    expect(getCatalogPackageNameList(packageList, "react-19", "turbo")).toStrictEqual([]);
  });

  it("Ignores a package that pins the dependency itself", () => {
    expect.hasAssertions();

    expect(
      getCatalogPackageNameList([buildPackage("pinned", { dependencies: { turbo: "2.10.10" } })], "default", "turbo"),
    ).toStrictEqual([]);
  });
});

describe(getOverridePackageNameList, () => {
  it("Names only the packages that declare the dependency themselves", () => {
    expect.hasAssertions();

    const packageList = [
      buildPackage("declares", { dependencies: { minimatch: "^10.0.0" } }),
      buildPackage("declares-dev", { devDependencies: { minimatch: "^10.0.0" } }),
      buildPackage("unrelated", { dependencies: { ky: "^3.0.0" } }),
    ];

    expect(getOverridePackageNameList(packageList, "minimatch")).toStrictEqual(["declares", "declares-dev"]);
  });

  it("Names nothing when the override pins something transitive", () => {
    expect.hasAssertions();

    expect(
      getOverridePackageNameList([buildPackage("app", { dependencies: { ky: "^3.0.0" } })], "minimatch"),
    ).toStrictEqual([]);
  });
});

// Unreviewed
const buildCargoWorkspacePackage = (directory: string, name: string): Package => ({
  dir: path.join(directory, "packages", name),
  packageJson: { name, version: "1.0.0" },
  relativeDir: `packages/${name}`,
});

describe(getCargoWorkspacePackageNameList, () => {
  it("Names the packages whose crate inherits the dependency from the workspace root", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/dotted/Cargo.toml": '[package]\nname = "dotted"\n\n[dependencies]\nserde.workspace = true\n',
      "packages/featured/Cargo.toml":
        '[package]\nname = "featured"\n\n[dependencies]\nserde = { workspace = true, features = ["derive"] }\n',
      "packages/inline/Cargo.toml": '[package]\nname = "inline"\n\n[dependencies]\nserde = { workspace = true }\n',
      "packages/no-crate/package.json": '{ "name": "no-crate" }',
      "packages/other-dep/Cargo.toml": '[package]\nname = "other-dep"\n\n[dependencies]\nclap.workspace = true\n',
      "packages/pinned/Cargo.toml": '[package]\nname = "pinned"\n\n[dependencies]\nserde = "1.0.0"\n',
      "packages/table/Cargo.toml": '[package]\nname = "table"\n\n[dependencies.serde]\nworkspace = true\n',
    });

    const packageList = ["inline", "dotted", "featured", "table", "pinned", "other-dep", "no-crate"].map((name) =>
      buildCargoWorkspacePackage(directory, name),
    );

    await expect(getCargoWorkspacePackageNameList(packageList, "serde")).resolves.toStrictEqual([
      "inline",
      "dotted",
      "featured",
      "table",
    ]);
  });

  it("Finds an inherited dependency in a dev, build, or per-platform table", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/build/Cargo.toml": "[build-dependencies]\nserde.workspace = true\n",
      "packages/dev/Cargo.toml": "[dev-dependencies]\nserde.workspace = true\n",
      "packages/platform/Cargo.toml": "[target.'cfg(unix)'.dependencies]\nserde.workspace = true\n",
    });

    const packageList = ["dev", "build", "platform"].map((name) => buildCargoWorkspacePackage(directory, name));

    await expect(getCargoWorkspacePackageNameList(packageList, "serde")).resolves.toStrictEqual([
      "dev",
      "build",
      "platform",
    ]);
  });

  it("Ignores a target table whose entry isn't a table at all", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/heir/Cargo.toml":
        "[package]\nname = \"heir\"\n\n[target.'cfg(unix)'.dependencies]\nserde.workspace = true\n",
      // `[target]` holding a scalar is not a per-platform table, so there is nothing to read a dependency from.
      "packages/scalar/Cargo.toml": '[package]\nname = "scalar"\n\n[target]\nnot-a-table = "x"\n',
    });
    const cargoPackageList = ["scalar", "heir"].map((name) => buildCargoWorkspacePackage(directory, name));

    await expect(getCargoWorkspacePackageNameList(cargoPackageList, "serde")).resolves.toStrictEqual(["heir"]);
  });

  it("Reports which Cargo manifest failed to parse", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({ "packages/broken/Cargo.toml": "[dependencies\nserde = " });
    const packageList = [buildCargoWorkspacePackage(directory, "broken")];

    await expect(getCargoWorkspacePackageNameList(packageList, "serde")).rejects.toThrow(
      /Couldn't parse .*Cargo\.toml/u,
    );
  });
});

// Unreviewed
const buildUpdate = (overrides: Partial<Update> = {}): Update => ({
  currentDigest: null,
  currentValue: null,
  currentVersion: "2.10.10",
  datasource: "npm",
  dependencyName: "turbo",
  dependencyType: null,
  fromVersion: "2.10.10",
  manager: "pnpm",
  manifestFilePath: "pnpm-workspace.yaml",
  newDigest: null,
  newName: null,
  newValue: "2.10.11",
  newVersion: "2.10.11",
  toVersion: "2.10.11",
  updateType: "patch",
  ...overrides,
});

describe(getSharedDeclarationPackageNameList, () => {
  const packageList = [
    buildPackage("catalogued", { dependencies: { turbo: "catalog:shared-dev" } }),
    buildPackage("declares", { dependencies: { turbo: "^2.10.10" } }),
  ];

  it("Expands a pnpm catalog to its consumers", async () => {
    expect.hasAssertions();

    const update = buildUpdate({ dependencyType: "pnpm.catalog.shared-dev" });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toStrictEqual([
      "catalogued",
    ]);
  });

  it("Expands a Yarn catalog the same way", async () => {
    expect.hasAssertions();

    const update = buildUpdate({ dependencyType: "yarn.catalog.shared-dev", manifestFilePath: "package.json" });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toStrictEqual([
      "catalogued",
    ]);
  });

  it("Expands a catalog even when the root happens to be a workspace package", async () => {
    expect.hasAssertions();

    const update = buildUpdate({ dependencyType: "pnpm.catalog.shared-dev" });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: true })).resolves.toStrictEqual([
      "catalogued",
    ]);
  });

  it.each(["overrides", "pnpm.overrides", "pnpm-workspace.overrides", "resolutions"])(
    "Expands %s only when no package owns the manifest",
    async (dependencyType) => {
      expect.hasAssertions();

      const update = buildUpdate({ dependencyType, manifestFilePath: "package.json" });

      // Drawing a dependency from a catalog is still declaring it, so an override pinning it reaches both packages.
      await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toStrictEqual(
        ["catalogued", "declares"],
      );
      await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: true })).resolves.toBeNull();
    },
  );

  it("Leaves an override that pins something transitive to nobody", async () => {
    expect.hasAssertions();

    const update = buildUpdate({
      dependencyName: "minimatch",
      dependencyType: "overrides",
      manifestFilePath: "package.json",
    });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toStrictEqual(
      [],
    );
  });

  it("Leaves an ordinary dependency to ownership", async () => {
    expect.hasAssertions();

    const update = buildUpdate({ dependencyType: "devDependencies", manifestFilePath: "packages/app/package.json" });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toBeNull();
  });

  it("Expands a Cargo workspace declaration to the crates that inherit it", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/heir/Cargo.toml": '[package]\nname = "heir"\n\n[dependencies]\nserde.workspace = true\n',
      "packages/pinned/Cargo.toml": '[package]\nname = "pinned"\n\n[dependencies]\nserde = "1.0.0"\n',
    });
    const cargoPackageList = ["heir", "pinned"].map((name) => buildCargoWorkspacePackage(directory, name));
    const update = buildUpdate({
      dependencyName: "serde",
      dependencyType: "workspace.dependencies",
      manifestFilePath: "Cargo.toml",
    });

    await expect(
      getSharedDeclarationPackageNameList(update, cargoPackageList, { isOwned: false }),
    ).resolves.toStrictEqual(["heir"]);
  });

  it("Leaves an update with no dependency type to ownership", async () => {
    expect.hasAssertions();

    const update = buildUpdate({ dependencyType: null, manifestFilePath: "packages/app/Dockerfile" });

    await expect(getSharedDeclarationPackageNameList(update, packageList, { isOwned: false })).resolves.toBeNull();
  });
});

// Unreviewed
const buildResolvedUpdate = (overrides: Partial<ResolvedUpdate> = {}): ResolvedUpdate => ({
  currentDigest: null,
  currentValue: "^2.0.2",
  currentVersion: "2.0.2",
  datasource: "npm",
  dependencyName: "ky",
  dependencyType: "dependencies",
  fromVersion: "2.0.2",
  manager: "npm",
  manifestFilePath: "packages/app/package.json",
  newDigest: null,
  newName: null,
  newValue: "^3.0.0",
  newVersion: "3.0.0",
  packageName: "@fixture/app",
  toVersion: "3.0.0",
  updateType: "major",
  ...overrides,
});

// Unreviewed
const renderBody = (template: string, overrides: Partial<ResolvedUpdate> = {}): string =>
  renderChangeset(template, buildResolvedUpdate(overrides));

describe(renderChangeset, () => {
  it("Interpolates a variable", () => {
    expect.hasAssertions();

    expect(renderBody("{{depName}} {{toVersion}}")).toBe("ky 3.0.0\n");
  });

  it("Treats the triple-brace form as raw text, the same as the double-brace form", () => {
    expect.hasAssertions();

    expect(renderBody("{{{depName}}} {{depName}}")).toBe("ky ky\n");
  });

  it("Tolerates whitespace inside an expression", () => {
    expect.hasAssertions();

    expect(renderBody("{{ depName }}|{{#if  fromVersion }}yes{{ else }}no{{ /if }}")).toBe("ky|yes\n");
  });

  it("Renders a null value as nothing", () => {
    expect.hasAssertions();

    expect(renderBody("[{{newName}}]")).toBe("[]\n");
  });

  it("Renders a false flag as nothing", () => {
    expect.hasAssertions();

    expect(renderBody("[{{isReplacement}}]")).toBe("[]\n");
  });

  it("Takes the consequent when the condition has a value", () => {
    expect.hasAssertions();

    expect(renderBody("{{#if fromVersion}}from {{fromVersion}}{{/if}}")).toBe("from 2.0.2\n");
  });

  it("Takes the alternate when the condition is null", () => {
    expect.hasAssertions();

    expect(renderBody("{{#if newName}}renamed{{else}}same name{{/if}}", { newName: null })).toBe("same name\n");
  });

  it("Treats an empty string as falsy", () => {
    expect.hasAssertions();

    expect(renderBody("{{#if currentValue}}has{{else}}none{{/if}}", { currentValue: "" })).toBe("none\n");
  });

  it("Nests conditions", () => {
    expect.hasAssertions();

    const template = "{{#if isReplacement}}A{{else}}{{#if isRollback}}B{{else}}C{{/if}}{{/if}}";

    expect(renderBody(template, { updateType: "replacement" })).toBe("A\n");
    expect(renderBody(template, { updateType: "rollback" })).toBe("B\n");
    expect(renderBody(template, { updateType: "patch" })).toBe("C\n");
  });

  it("Collapses the blank lines an untaken branch leaves behind", () => {
    expect.hasAssertions();

    expect(renderBody("one\n{{#if newName}}\n\ntwo\n\n{{/if}}\nthree")).toBe("one\n\nthree\n");
  });

  it("Ends the file with exactly one newline", () => {
    expect.hasAssertions();

    expect(renderBody("body\n\n\n")).toBe("body\n");
    expect(renderBody("body")).toBe("body\n");
  });

  it("Rejects a variable that isn't a field of an update", () => {
    expect.hasAssertions();

    expect(() => renderBody("{{newversion}}")).toThrow(/references \{\{newversion\}\}/u);
    expect(() => renderBody("{{newversion}}")).toThrow(/Available: .*newVersion/u);
  });

  it("Rejects a block helper other than if", () => {
    expect.hasAssertions();

    expect(() => renderBody("{{#each upgrades}}x{{/each}}")).toThrow(/unsupported block expression/u);
  });

  it("Rejects an unclosed condition", () => {
    expect.hasAssertions();

    expect(() => renderBody("{{#if fromVersion}}x")).toThrow(/never closes \{\{#if fromVersion\}\}/u);
  });

  it("Rejects a closing tag with no condition", () => {
    expect.hasAssertions();

    expect(() => renderBody("x{{/if}}")).toThrow(/\{\{\/if\}\} with no matching/u);
  });

  it("Rejects an else with no condition", () => {
    expect.hasAssertions();

    expect(() => renderBody("x{{else}}y")).toThrow(/\{\{else\}\} with no matching/u);
  });
});

describe("Default template", () => {
  it("Names both versions of an ordinary update", () => {
    expect.hasAssertions();

    expect(renderChangeset(DEFAULT_TEMPLATE, buildResolvedUpdate())).toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated ky from 2.0.2 to 3.0.0\n',
    );
  });

  it("Omits the from side when Renovate reported no current version", () => {
    expect.hasAssertions();

    expect(renderChangeset(DEFAULT_TEMPLATE, buildResolvedUpdate({ currentVersion: null, fromVersion: null }))).toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated ky to 3.0.0\n',
    );
  });

  it("Names the arriving dependency on a replacement", () => {
    expect.hasAssertions();

    const content = renderChangeset(
      DEFAULT_TEMPLATE,
      buildResolvedUpdate({
        newName: "some-fork",
        newValue: "3.0.0",
        newVersion: null,
        toVersion: "3.0.0",
        updateType: "replacement",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nReplaced ky 2.0.2 with some-fork 3.0.0\n');
  });

  it("Doesn't read a rollback as an upgrade", () => {
    expect.hasAssertions();

    const content = renderChangeset(
      DEFAULT_TEMPLATE,
      buildResolvedUpdate({
        currentVersion: "2.10.11",
        dependencyName: "turbo",
        fromVersion: "2.10.11",
        newVersion: "2.10.10",
        toVersion: "2.10.10",
        updateType: "rollback",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nRolled turbo back to 2.10.10\n');
  });

  it("Names both digests on a digest update", () => {
    expect.hasAssertions();

    const content = renderChangeset(
      DEFAULT_TEMPLATE,
      buildResolvedUpdate({
        currentDigest: "sha256:032b412",
        currentVersion: null,
        dependencyName: "timescaledb",
        fromVersion: "sha256:032b412",
        newDigest: "sha256:cf49c5d",
        newVersion: null,
        toVersion: "sha256:cf49c5d",
        updateType: "digest",
      }),
    );

    expect(content).toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated timescaledb from sha256:032b412 to sha256:cf49c5d\n',
    );
  });
});

// Unreviewed
/** The `.changeset/config.json` a fixture needs before `readConfig` will look at it. */
const buildChangesetConfig = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify(
    {
      $schema: "https://unpkg.com/@changesets/config@4.0.0/schema.json",
      access: "restricted",
      baseBranch: "main",
      changelog: false,
      commit: false,
      fixed: [],
      ignore: [],
      linked: [],
      privatePackages: { tag: false, version: true },
      updateInternalDependencies: "patch",
      ...overrides,
    },
    null,
    2,
  )}\n`;

// Unreviewed
const buildPnpmWorkspace = (relativeDirList: string[]): string =>
  ["packages:", ...relativeDirList.map((relativeDir) => `  - ${relativeDir}`), ""].join("\n");

// Unreviewed
const serializePackageJson = (value: Record<string, unknown>): string => `${JSON.stringify(value, null, 2)}\n`;

// Unreviewed
const createTemporaryWorkspace = async (fileMap: Record<string, string>): Promise<string> => {
  const directory = await createWorkspace({ ".changeset/config.json": buildChangesetConfig(), ...fileMap });

  return directory;
};

// Unreviewed
const runIn = async (
  directory: string,
  upgradeList: RenovateUpgrade[],
  environment: Record<string, string | undefined> = {},
): Promise<string[]> => {
  const filePathList = await run({ argumentList: [encodeUpgradeList(upgradeList)], directory, environment });

  return filePathList;
};

describe(run, () => {
  it("Writes one changeset for a dependency inside a package", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/app"]),
    });

    await runIn(directory, [
      {
        currentVersion: "1.10.10",
        depName: "oxlint",
        depType: "devDependencies",
        newVersion: "2.10.11",
        packageFile: "packages/app/package.json",
        updateType: "major",
      },
    ]);

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map(({ content }) => content)).toStrictEqual([
      '---\n"@fixture/app": patch\n---\n\nUpdated oxlint from 1.10.10 to 2.10.11\n',
    ]);
    expect(changesetList[0]?.fileName).toMatch(/^renovate-[\da-f]{8}\.md$/u);
  });

  it("Writes nothing for a manifest that belongs to no package", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/app"]),
    });

    await runIn(directory, [
      { currentVersion: "0.2.337", depName: "chainctl", newVersion: "0.2.338", packageFile: "mise.toml" },
      {
        currentDigest: "sha256:aaaaaaabbbbbbb",
        depName: "actions/checkout",
        newDigest: "sha256:cccccccddddddd",
        packageFile: ".github/workflows/ci.yaml",
        updateType: "digest",
      },
    ]);

    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });

  it("Expands a catalog entry to every package that draws from it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/bystander/package.json": serializePackageJson({
        dependencies: { turbo: "catalog:" },
        name: "@fixture/bystander",
        version: "1.0.0",
      }),
      "packages/consumer-a/package.json": serializePackageJson({
        dependencies: { turbo: "catalog:shared-dev" },
        name: "@fixture/consumer-a",
        version: "1.0.0",
      }),
      "packages/consumer-b/package.json": serializePackageJson({
        devDependencies: { turbo: "catalog:shared-dev" },
        name: "@fixture/consumer-b",
        version: "1.0.0",
      }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/consumer-a", "packages/consumer-b", "packages/bystander"]),
    });

    await runIn(directory, [
      {
        currentVersion: "2.10.10",
        depName: "turbo",
        depType: "pnpm.catalog.shared-dev",
        newVersion: "2.10.11",
        packageFile: "pnpm-workspace.yaml",
        updateType: "patch",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"@fixture/consumer-a": patch\n---\n\nUpdated turbo from 2.10.10 to 2.10.11\n',
      '---\n"@fixture/consumer-b": patch\n---\n\nUpdated turbo from 2.10.10 to 2.10.11\n',
    ]);
  });

  it("Skips a package Changesets wouldn't version", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".changeset/config.json": buildChangesetConfig({
        ignore: ["@fixture/ignored"],
        privatePackages: { tag: false, version: false },
      }),
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/ignored/package.json": serializePackageJson({ name: "@fixture/ignored", version: "1.0.0" }),
      "packages/private/package.json": serializePackageJson({
        name: "@fixture/private",
        private: true,
        version: "1.0.0",
      }),
      "packages/public/package.json": serializePackageJson({ name: "@fixture/public", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/ignored", "packages/private", "packages/public"]),
    });

    await runIn(
      directory,
      ["ignored", "private", "public"].map((directoryName) => ({
        currentVersion: "1.0.0",
        depName: `dependency-${directoryName}`,
        newVersion: "2.0.0",
        packageFile: `packages/${directoryName}/package.json`,
      })),
    );

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual([
      '---\n"@fixture/public": patch\n---\n\nUpdated dependency-public from 1.0.0 to 2.0.0\n',
    ]);
  });

  // `shouldSkipPackage` returns true for a package with no version, so one falls out of the workspace entirely and
  // its manifests fall through to whichever package encloses it.
  it("Skips a package with no version and gives its manifests to the package containing it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/outer/inner/package.json": serializePackageJson({ name: "@fixture/inner" }),
      "packages/outer/package.json": serializePackageJson({ name: "@fixture/outer", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/outer", "packages/outer/inner"]),
    });

    await runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "packages/outer/inner/package.json" }]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/outer": patch\n---\n\nUpdated ky to 2.0.0\n']);
  });

  it("Gives a nested package its own manifests when Changesets would version it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/outer/inner/package.json": serializePackageJson({ name: "@fixture/inner", version: "1.0.0" }),
      "packages/outer/package.json": serializePackageJson({ name: "@fixture/outer", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/outer", "packages/outer/inner"]),
    });

    await runIn(directory, [
      { depName: "ky", newVersion: "2.0.0", packageFile: "packages/outer/inner/package.json" },
      { depName: "turbo", newVersion: "3.0.0", packageFile: "packages/outer/Dockerfile" },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"@fixture/inner": patch\n---\n\nUpdated ky to 2.0.0\n',
      '---\n"@fixture/outer": patch\n---\n\nUpdated turbo to 3.0.0\n',
    ]);
  });

  it("Gives everything to the one package in a single-package repository", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [
      { currentVersion: "1.0.0", depName: "ky", newVersion: "2.0.0", packageFile: "package.json" },
      { currentVersion: "24.0.0", depName: "node", newVersion: "24.1.0", packageFile: "mise.toml" },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"solo": patch\n---\n\nUpdated ky from 1.0.0 to 2.0.0\n',
      '---\n"solo": patch\n---\n\nUpdated node from 24.0.0 to 24.1.0\n',
    ]);
  });

  // `@manypkg/find-root` only recognizes an npm, Yarn, or Bun workspace when the matching lock file is beside the
  // root `package.json`; without it the repository is read as a single package. Renovate's clone always has one,
  // since Renovate is the thing that just updated it.
  it.each([
    ["npm", "package-lock.json"],
    ["Yarn", "yarn.lock"],
  ])("Works the same in a %s workspace", async (_label, lockFileName) => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      [lockFileName]: "\n",
      "package.json": serializePackageJson({
        name: "root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
      }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
    });

    await runIn(directory, [
      { currentVersion: "1.0.0", depName: "ky", newVersion: "2.0.0", packageFile: "packages/app/package.json" },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/app": patch\n---\n\nUpdated ky from 1.0.0 to 2.0.0\n']);
  });

  it("Expands a Yarn catalog to its consumers", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({
        name: "root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
      }),
      "packages/app/package.json": serializePackageJson({
        dependencies: { turbo: "catalog:shared-dev" },
        name: "@fixture/app",
        version: "1.0.0",
      }),
      "yarn.lock": "\n",
    });

    await runIn(directory, [
      {
        currentVersion: "2.10.10",
        depName: "turbo",
        depType: "yarn.catalog.shared-dev",
        newVersion: "2.10.11",
        packageFile: "package.json",
        updateType: "patch",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/app": patch\n---\n\nUpdated turbo from 2.10.10 to 2.10.11\n']);
  });

  it("Uses a template the repository ships at the default path", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".changeset/.renovate-changesets.md":
        '---\n"{{packageName}}": minor\n---\n\nBumped {{depName}} to {{toVersion}}\n',
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"solo": minor\n---\n\nBumped ky to 2.0.0\n']);
  });

  it("Uses a template pointed at by RENOVATE_CHANGESETS_TEMPLATE_FILE", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{packageName}}": patch\n---\n\n{{depName}}@{{toVersion}}\n',
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }], {
      RENOVATE_CHANGESETS_TEMPLATE_FILE: ".github/changeset.md",
    });

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"solo": patch\n---\n\nky@2.0.0\n']);
  });

  it("Fails when a template it was told to use isn't there", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(
      runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }], {
        RENOVATE_CHANGESETS_TEMPLATE_FILE: ".github/missing.md",
      }),
    ).rejects.toThrow(/Couldn't read the changeset template/u);
  });

  it("Reads the repository named by RENOVATE_CHANGESETS_CWD rather than the working directory", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/app"]),
    });

    await runIn(process.cwd(), [{ depName: "ky", newVersion: "2.0.0", packageFile: "packages/app/package.json" }], {
      RENOVATE_CHANGESETS_CWD: directory,
    });

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/app": patch\n---\n\nUpdated ky to 2.0.0\n']);
  });

  it("Overwrites its own files on a rebase rather than accumulating a second set", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });
    const upgradeList: RenovateUpgrade[] = [
      { currentVersion: "1.0.0", depName: "ky", newVersion: "2.0.0", packageFile: "package.json" },
      { currentVersion: "1.0.0", depName: "turbo", newVersion: "2.0.0", packageFile: "package.json" },
    ];

    const firstFilePathList = await runIn(directory, upgradeList);
    const secondFilePathList = await runIn(directory, upgradeList);

    expect(secondFilePathList).toStrictEqual(firstFilePathList);
    await expect(readChangesetList(directory)).resolves.toHaveLength(2);
  });

  it("Names each file after a hash of its own content", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]);

    for (const { content, fileName } of await readChangesetList(directory)) {
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);

      expect(fileName).toBe(`renovate-${hash}.md`);
    }
  });

  it("Writes nothing when the command line asked for something yargs answers itself", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(run({ argumentList: ["--help"], directory, environment: {} })).resolves.toStrictEqual([]);
    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });

  it("Writes nothing for an empty payload", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(run({ argumentList: [], directory, environment: {} })).resolves.toStrictEqual([]);
    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });

  it("Reports an invalid Changesets config rather than writing against it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".changeset/config.json": buildChangesetConfig({ privatePackages: "yes" }),
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(
      runIn(directory, [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]),
    ).rejects.toThrow(/config\.json is invalid/u);
  });

  it("Writes for a repository that has no Changesets config at all", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      ".changeset/.keep": "",
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/app"]),
    });

    await runIn(directory, [
      { depName: "ky", newVersion: "3.0.0", packageFile: "packages/app/package.json", updateType: "major" },
    ]);

    const [changeset] = await readChangesetList(directory);

    expect(changeset?.content).toBe('---\n"@fixture/app": patch\n---\n\nUpdated ky to 3.0.0\n');
  });
});

// Unreviewed
/** Parses a command line against a repository root that is never read, for the cases that only inspect the options. */
const parse = async (
  argumentList: string[],
  environment: Record<string, string | undefined> = {},
): ReturnType<typeof parseArguments> => {
  const parsedArguments = await parseArguments({ argumentList, directory: "/repository", environment });

  return parsedArguments;
};

describe(configureLogging, () => {
  afterAll(async () => {
    await reset();
  });

  it("Writes a record to standard error, prefixed so Renovate's log says where it came from", async () => {
    expect.hasAssertions();

    const lineList: string[] = [];
    // Standard error is this function's entire contract, so it is the thing to observe.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lineList.push(String(chunk));

      return true;
    });

    try {
      await configureLogging();
      getLogger(["renovate-changesets"]).warning((format) => format`Something worth saying`);
    } finally {
      spy.mockRestore();
    }

    expect(lineList).toStrictEqual(["renovate-changesets: Something worth saying\n"]);
  });
});

describe(main, () => {
  const mainRecorder = createLogRecorder();

  beforeAll(async () => {
    await configure({
      loggers: [
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["recorder"] },
        { category: "renovate-changesets", lowestLevel: "warning", sinks: ["recorder"] },
      ],
      reset: true,
      sinks: { recorder: mainRecorder.sink },
    });
  });

  beforeEach(() => {
    mainRecorder.clear();
  });

  afterAll(async () => {
    await reset();
  });

  it("Reports success as an exit code of zero", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });
    const upgradeList = [{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }];

    await expect(main({ argumentList: [encodeUpgradeList(upgradeList)], directory, environment: {} })).resolves.toBe(0);
    await expect(readChangesetList(directory)).resolves.toHaveLength(1);
  });

  it("Reports a failure as an exit code of one, with the reason on the logger", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });

    // `e30=` is base64 for `{}` — decodable JSON, but not the array Renovate is supposed to send.
    await expect(main({ argumentList: ["e30="], directory, environment: {} })).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /is not a function/u });
  });
});

describe("Command line", () => {
  it("Falls back to the working directory and no template of its own", async () => {
    expect.hasAssertions();

    await expect(parse([])).resolves.toStrictEqual({
      encodedUpdates: "",
      templateFilePath: undefined,
      workingDirectory: "/repository",
    });
  });

  it("Reads Renovate's payload from the one positional argument", async () => {
    expect.hasAssertions();

    const encodedUpdates = encodeUpgradeList([{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]);

    await expect(parse([encodedUpdates])).resolves.toMatchObject({ encodedUpdates });
  });

  it("Takes every option from a flag", async () => {
    expect.hasAssertions();

    await expect(parse(["--cwd", "/elsewhere", "--template-file", ".github/changeset.md"])).resolves.toStrictEqual({
      encodedUpdates: "",
      templateFilePath: ".github/changeset.md",
      workingDirectory: "/elsewhere",
    });
  });

  it("Takes every option from the environment when no flag names it", async () => {
    expect.hasAssertions();

    await expect(
      parse([], {
        RENOVATE_CHANGESETS_CWD: "/elsewhere",
        RENOVATE_CHANGESETS_TEMPLATE_FILE: ".github/changeset.md",
      }),
    ).resolves.toStrictEqual({
      encodedUpdates: "",
      templateFilePath: ".github/changeset.md",
      workingDirectory: "/elsewhere",
    });
  });

  it("Lets a flag win over the environment", async () => {
    expect.hasAssertions();

    await expect(parse(["--cwd", "/flag"], { RENOVATE_CHANGESETS_CWD: "/environment" })).resolves.toMatchObject({
      workingDirectory: "/flag",
    });
  });

  it("Treats an empty value as unset", async () => {
    expect.hasAssertions();

    await expect(parse(["--cwd", ""])).resolves.toMatchObject({ workingDirectory: "/repository" });
  });

  it("Asks for nothing once it has printed help", async () => {
    expect.hasAssertions();

    const spy = vi.spyOn(console, "log").mockReturnValue();

    try {
      await expect(parse(["--help"])).resolves.toBeUndefined();
      expect(spy.mock.calls.flat().join("\n")).toMatch(/renovate-changesets \[updates\]/u);
    } finally {
      spy.mockRestore();
    }
  });

  it("Asks for nothing once it has printed the version", async () => {
    expect.hasAssertions();

    const spy = vi.spyOn(console, "log").mockReturnValue();

    try {
      await expect(parse(["--version"])).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/u));
    } finally {
      spy.mockRestore();
    }
  });

  it("Rejects a flag it doesn't know rather than ignoring it", async () => {
    expect.hasAssertions();

    await expect(parse(["--cwdd", "/elsewhere"])).rejects.toThrow(/Unknown argument: cwdd/u);
  });

  it("Rejects a second positional argument", async () => {
    expect.hasAssertions();

    await expect(parse(["one", "two"])).rejects.toThrow(/Unknown argument: two/u);
  });

  it("Uses a template a flag points at", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{packageName}}": patch\n---\n\n{{depName}}@{{toVersion}}\n',
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await run({
      argumentList: [
        encodeUpgradeList([{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]),
        "--template-file",
        ".github/changeset.md",
      ],
      directory,
      environment: {},
    });

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nky@2.0.0\n',
    ]);
  });

  it("Reads the repository a --cwd flag names rather than the working directory", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await run({
      argumentList: [
        encodeUpgradeList([{ depName: "ky", newVersion: "2.0.0", packageFile: "package.json" }]),
        "--cwd",
        directory,
      ],
      directory: process.cwd(),
      environment: {},
    });

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nUpdated ky to 2.0.0\n',
    ]);
  });
});

type FixtureCatalogReference = { catalogName: string; dependencyName: string };

type FixturePackage = {
  catalogReferenceList: FixtureCatalogReference[];
  dependencyGroup: "dependencies" | "devDependencies";
  directoryPath: string;
  hasVersion: boolean;
  isIgnored: boolean;
  isPrivate: boolean;
  /** Whether Changesets would version this package — the three reasons `shouldSkipPackage` says no, inverted. */
  isVersioned: boolean;
  name: string;
};

type FixtureWorkspace = {
  catalogNameList: string[];
  directory: string;
  packageList: FixturePackage[];
  versionedPackageNameList: string[];
};

/** What one package should look like. Plain data, so fast-check can shrink a failure down to a smaller workspace. */
type FixturePackagePlan = {
  catalogName: string | null;
  dependencyGroup: "dependencies" | "devDependencies";
  isNested: boolean;
  isPrivate: boolean;
};

type FixturePlan = {
  /**
   * Which package Changesets is told to ignore, or `-1` for none. At most one, since `readConfig` rejects an ignore
   * entry naming no package in the workspace.
   */
  ignoredIndex: number;
  packagePlanList: FixturePackagePlan[];
  privatePackagesVersion: boolean;
  /** Which package has no `version` field at all, or `-1` for none. */
  versionlessIndex: number;
};

const CATALOG_NAME_LIST = ["default", "react-19", "shared-dev"];
const CATALOG_DEPENDENCY_NAME = "catalogued-dependency";

/** How many workspaces the property runs against. */
const WORKSPACE_COUNT = 120;

// Unreviewed
const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

// Unreviewed
const buildPackageList = ({
  ignoredIndex,
  packagePlanList,
  privatePackagesVersion,
  versionlessIndex,
}: FixturePlan): FixturePackage[] => {
  const packageList: FixturePackage[] = [];

  for (const [index, packagePlan] of packagePlanList.entries()) {
    const parent = packageList.at(-1);

    // A nested package sits inside the previous one, which is what exercises deepest-match ownership. The first
    // package has no parent to nest inside.
    const directoryPath =
      parent !== undefined && packagePlan.isNested
        ? `${parent.directoryPath}/nested-${index}`
        : `packages/package-${index}`;

    const hasVersion = index !== versionlessIndex;
    const isIgnored = index === ignoredIndex;

    packageList.push({
      catalogReferenceList:
        packagePlan.catalogName === null
          ? []
          : [{ catalogName: packagePlan.catalogName, dependencyName: CATALOG_DEPENDENCY_NAME }],
      dependencyGroup: packagePlan.dependencyGroup,
      directoryPath,
      hasVersion,
      isIgnored,
      isPrivate: packagePlan.isPrivate,
      // The three reasons `shouldSkipPackage` refuses a package: it is ignored, it is private and private packages
      // aren't versioned, or it has no version at all.
      isVersioned: !isIgnored && (privatePackagesVersion || !packagePlan.isPrivate) && hasVersion,
      name: `@fixture/package-${index}`,
    });
  }

  return packageList;
};

const fixturePackagePlanArbitrary = fc.record<FixturePackagePlan>({
  catalogName: fc.option(fc.constantFrom(...CATALOG_NAME_LIST), { nil: null }),
  dependencyGroup: fc.constantFrom("dependencies", "devDependencies"),
  isNested: fc.boolean(),
  isPrivate: fc.boolean(),
});

/** A whole workspace shape. The two indexes are drawn after the list so they can't point past its end. */
const fixturePlanArbitrary: fc.Arbitrary<FixturePlan> = fc
  .record({
    packagePlanList: fc.array(fixturePackagePlanArbitrary, { maxLength: 6, minLength: 2 }),
    privatePackagesVersion: fc.boolean(),
  })
  .chain(({ packagePlanList, privatePackagesVersion }) =>
    fc.record({
      ignoredIndex: fc.integer({ max: packagePlanList.length - 1, min: -1 }),
      packagePlanList: fc.constant(packagePlanList),
      privatePackagesVersion: fc.constant(privatePackagesVersion),
      versionlessIndex: fc.integer({ max: packagePlanList.length - 1, min: -1 }),
    }),
  );

// Unreviewed
const buildPackageJson = (fixturePackage: FixturePackage): Record<string, unknown> => {
  const dependencyEntryList: [string, string][] = fixturePackage.catalogReferenceList.map(
    ({ catalogName, dependencyName }) => [
      dependencyName,
      catalogName === "default" ? "catalog:" : `catalog:${catalogName}`,
    ],
  );

  return {
    name: fixturePackage.name,
    ...(fixturePackage.hasVersion ? { version: "1.0.0" } : {}),
    ...(fixturePackage.isPrivate ? { private: true } : {}),
    [fixturePackage.dependencyGroup]: {
      ...Object.fromEntries(dependencyEntryList),
      "plain-dependency": "^1.0.0",
    },
  };
};

// Unreviewed
/**
 * Writes a throwaway pnpm workspace to a temporary directory and describes what it contains.
 *
 * The shapes it varies — package count, nesting, catalog declarations, dependency group, private flags,
 * `privatePackages.version`, ignore lists, and packages with no version — are the ones a single repository can't cover
 * on its own, and they are exactly what a shared package's consumers will have.
 */
const createFixtureWorkspace = async (plan: FixturePlan): Promise<FixtureWorkspace> => {
  const directory = await mkdtemp(path.join(tmpdir(), "renovate-changesets-"));
  const packageList = buildPackageList(plan);

  await Promise.all(
    packageList.map(async (fixturePackage) => {
      await writeJsonFile(
        path.join(directory, fixturePackage.directoryPath, "package.json"),
        buildPackageJson(fixturePackage),
      );
    }),
  );

  await writeFile(
    path.join(directory, "pnpm-workspace.yaml"),
    [
      "catalog:",
      '  catalogued-dependency: "^1.0.0"',
      "catalogs:",
      ...CATALOG_NAME_LIST.filter((catalogName) => catalogName !== "default").flatMap((catalogName) => [
        `  ${catalogName}:`,
        '    catalogued-dependency: "^1.0.0"',
      ]),
      "packages:",
      ...packageList.map((fixturePackage) => `  - ${fixturePackage.directoryPath}`),
      "",
    ].join("\n"),
  );

  await writeJsonFile(path.join(directory, "package.json"), {
    name: "@fixture/root",
    private: true,
    version: "0.0.0",
  });

  await writeJsonFile(path.join(directory, ".changeset", "config.json"), {
    $schema: "https://unpkg.com/@changesets/config@4.0.0/schema.json",
    access: "restricted",
    baseBranch: "main",
    changelog: false,
    commit: false,
    fixed: [],
    ignore: packageList
      .filter((fixturePackage) => fixturePackage.isIgnored)
      .map((fixturePackage) => fixturePackage.name),
    linked: [],
    privatePackages: { tag: false, version: plan.privatePackagesVersion },
    updateInternalDependencies: "patch",
  });

  return {
    catalogNameList: CATALOG_NAME_LIST,
    directory,
    packageList,
    versionedPackageNameList: packageList
      .filter((fixturePackage) => fixturePackage.isVersioned)
      .map((fixturePackage) => fixturePackage.name),
  };
};

const CHANGESET_PATTERN = /^---\n"(?<packageName>[^"]+)": patch\n---\n\n(?<body>.+)\n$/su;
const BODY_PATTERN = /^Updated (?<dependencyName>\S+) (?:from (?<fromVersion>\S+) )?to (?<toVersion>\S+)$/u;
const FILE_NAME_PATTERN = /^renovate-(?<hash>[\da-f]{8})\.md$/u;

type Pair = { dependencyName: string; packageName: string };

// Unreviewed
/**
 * Works out who should own a manifest from the fixture's own description, by directory prefix rather than by the path
 * arithmetic the implementation uses. Packages Changesets won't version are excluded first, which is what makes a
 * manifest inside an ignored nested package fall through to its parent.
 */
const findExpectedOwner = (fixture: FixtureWorkspace, manifestFilePath: string): string | null =>
  fixture.packageList
    .filter(
      (fixturePackage) =>
        fixturePackage.isVersioned &&
        (manifestFilePath === fixturePackage.directoryPath ||
          manifestFilePath.startsWith(`${fixturePackage.directoryPath}/`)),
    )
    .toSorted((left, right) => right.directoryPath.length - left.directoryPath.length)
    .at(0)?.name ?? null;

// Unreviewed
const buildUpgradeList = (fixture: FixtureWorkspace): RenovateUpgrade[] => [
  // One update per package, each with its own dependency name and version so ownership is never ambiguous.
  ...fixture.packageList.map((fixturePackage, index) => ({
    currentVersion: `${index + 1}.0.0`,
    depName: `dependency-${index}`,
    depType: fixturePackage.dependencyGroup,
    newVersion: `${index + 1}.1.0`,
    packageFile: `${fixturePackage.directoryPath}/package.json`,
    updateType: "minor" as const,
  })),
  // A manifest at the repository root, owned by no package.
  { currentVersion: "0.2.337", depName: "chainctl", newVersion: "0.2.338", packageFile: "mise.toml" },
  // A manifest in a directory that isn't a package at all.
  {
    currentVersion: "1.0.0",
    depName: "stray-dependency",
    newVersion: "1.1.0",
    packageFile: "packages/not-a-package/package.json",
  },
  // One update per catalog, each with its own version.
  ...fixture.catalogNameList.map((catalogName, index) => ({
    currentVersion: `10.${index}.0`,
    depName: CATALOG_DEPENDENCY_NAME,
    depType: `pnpm.catalog.${catalogName}`,
    newVersion: `10.${index}.1`,
    packageFile: "pnpm-workspace.yaml",
    updateType: "patch" as const,
  })),
];

// Unreviewed
const buildExpectedPairList = (fixture: FixtureWorkspace): Pair[] => {
  const pairList: Pair[] = [];

  for (const [index, fixturePackage] of fixture.packageList.entries()) {
    const packageName = findExpectedOwner(fixture, `${fixturePackage.directoryPath}/package.json`);

    if (packageName !== null) {
      pairList.push({ dependencyName: `dependency-${index}`, packageName });
    }
  }

  for (const catalogName of fixture.catalogNameList) {
    for (const fixturePackage of fixture.packageList) {
      const consumes = fixturePackage.catalogReferenceList.some(
        (reference) => reference.catalogName === catalogName && reference.dependencyName === CATALOG_DEPENDENCY_NAME,
      );

      if (fixturePackage.isVersioned && consumes) {
        pairList.push({ dependencyName: CATALOG_DEPENDENCY_NAME, packageName: fixturePackage.name });
      }
    }
  }

  return pairList;
};

// Unreviewed
const sortPairList = (pairList: Pair[]): string[] =>
  pairList.map(({ dependencyName, packageName }) => `${packageName} <- ${dependencyName}`).toSorted();

// Unreviewed
/** One named group of a match, or the empty string when either the match or the group is missing. */
const readMatchGroup = (match: RegExpExecArray | null, groupName: string): string => match?.groups?.[groupName] ?? "";

// Unreviewed
/** Every package that draws the catalogued dependency from a named catalog, as the pair it should produce. */
const buildCatalogConsumerPairList = (fixture: FixtureWorkspace): string[] => [
  ...new Set(
    fixture.packageList
      .filter(
        (fixturePackage) =>
          fixturePackage.isVersioned &&
          fixturePackage.catalogReferenceList.some((reference) => reference.catalogName !== ""),
      )
      .map((fixturePackage) => `${fixturePackage.name} <- ${CATALOG_DEPENDENCY_NAME}`),
  ),
];

// Unreviewed
/** Every pair a package that draws from no catalog must never produce. */
const buildCatalogNonConsumerPairSet = (fixture: FixtureWorkspace): Set<string> =>
  new Set(
    fixture.packageList
      .filter((fixturePackage) => fixturePackage.catalogReferenceList.length === 0)
      .map((fixturePackage) => `${fixturePackage.name} <- ${CATALOG_DEPENDENCY_NAME}`),
  );

// Unreviewed
/** Every pair a nested package must produce for its own manifest, rather than the package containing it. */
const buildNestedPairList = (fixture: FixtureWorkspace): string[] =>
  [...fixture.packageList.entries()]
    .filter(([, fixturePackage]) => fixturePackage.isVersioned && fixturePackage.directoryPath.includes("/nested-"))
    .map(([index, fixturePackage]) => `${fixturePackage.name} <- dependency-${index}`);

// Unreviewed
/** Every property a generated workspace's changesets must satisfy, asserted against one materialized fixture. */
const assertWorkspaceChangesets = async (fixture: FixtureWorkspace): Promise<void> => {
  const upgradeList = buildUpgradeList(fixture);
  const options = { argumentList: [encodeUpgradeList(upgradeList)], directory: fixture.directory, environment: {} };
  const firstFilePathList = await run(options);
  const secondFilePathList = await run(options);

  const changesetList = await readChangesetList(fixture.directory);
  const actualPairList: Pair[] = [];

  for (const { content, fileName } of changesetList) {
    // 1. Every file is named the way this tool names files.
    const fileNameMatch = FILE_NAME_PATTERN.exec(fileName);

    expect(fileNameMatch, `file name ${fileName}`).not.toBeNull();

    // 2. A file's name is the hash of its own content, which is what makes a rebase overwrite rather than pile up.
    expect(fileNameMatch?.groups?.hash).toBe(createHash("sha256").update(content).digest("hex").slice(0, 8));

    // 3. Every file parses as changeset frontmatter followed by a body.
    const changesetMatch = CHANGESET_PATTERN.exec(content);

    expect(changesetMatch, `content ${JSON.stringify(content)}`).not.toBeNull();

    const packageName = readMatchGroup(changesetMatch, "packageName");
    const bodyMatch = BODY_PATTERN.exec(readMatchGroup(changesetMatch, "body"));

    // 4. Every body names one dependency and the version it moved to.
    expect(bodyMatch, `body ${JSON.stringify(readMatchGroup(changesetMatch, "body"))}`).not.toBeNull();

    // 5. Every package named is a real package in the workspace.
    expect(fixture.packageList.map((fixturePackage) => fixturePackage.name)).toContain(packageName);

    // 6. Every package named is one Changesets would actually version.
    expect(fixture.versionedPackageNameList).toContain(packageName);

    actualPairList.push({ dependencyName: readMatchGroup(bodyMatch, "dependencyName"), packageName });
  }

  // 7. The whole set of package-to-dependency pairs is exactly the expected one — nothing missing, nothing extra.
  expect(sortPairList(actualPairList)).toStrictEqual(sortPairList(buildExpectedPairList(fixture)));

  // 8. A manifest owned by no package contributes nothing.
  expect(actualPairList.map((pair) => pair.dependencyName)).not.toContain("chainctl");
  expect(actualPairList.map((pair) => pair.dependencyName)).not.toContain("stray-dependency");

  const actualPairNameList = sortPairList(actualPairList);

  // 9. A catalog reaches every package that draws from it.
  expect(actualPairNameList).toStrictEqual(expect.arrayContaining(buildCatalogConsumerPairList(fixture)));

  // 10. A catalog reaches no package that doesn't draw from it.
  const catalogNonConsumerPairSet = buildCatalogNonConsumerPairSet(fixture);

  expect(actualPairNameList.filter((pair) => catalogNonConsumerPairSet.has(pair))).toStrictEqual([]);

  // 11. A manifest inside a nested package belongs to the nested package, not to the one containing it.
  expect(actualPairNameList).toStrictEqual(expect.arrayContaining(buildNestedPairList(fixture)));

  // 12. Re-running against the same branch rewrites the same files rather than adding a second set.
  expect(secondFilePathList).toStrictEqual(firstFilePathList);
  expect(changesetList).toHaveLength(firstFilePathList.length);
};

describe("Generated workspaces", () => {
  propertyTest.prop([fixturePlanArbitrary], { numRuns: WORKSPACE_COUNT })(
    "Writes exactly the changesets a workspace implies",
    async (plan) => {
      const fixture = await createFixtureWorkspace(plan);

      try {
        await assertWorkspaceChangesets(fixture);
      } finally {
        await removeWorkspace(fixture.directory);
      }
    },
  );
});
