import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fc, test as propertyTest } from "@fast-check/vitest";
import { configure, getLogger, reset } from "@logtape/logtape";
import { createLogRecorder } from "@logtape/testing/recorder";
import type { Package } from "@manypkg/get-packages";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  configureLogger,
  defaultTemplate,
  getSharedDeclarationPackageNameList,
  getUpgradeList,
  getPackageList,
  main,
  resolveDependency,
  run,
  writeChangesets,
  type RenovateUpgrade,
  type ResolvedRenovateUpgrade,
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

// This package's records go nowhere until something configures a sink, so the suite points the category at a recorder
// and reads what a real run would have written to standard error.
const recorder = createLogRecorder();

describe(getUpgradeList, () => {
  beforeAll(async () => {
    await configure({
      loggers: [
        // LogTape's own diagnostics get the recorder too, so a misconfigured suite surfaces instead of vanishing.
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["recorder"] },
        // The version-range skip logs at info, below what an entry point configures, so the recorder listens lower.
        { category: "renovate-changesets", lowestLevel: "info", sinks: ["recorder"] },
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

  it("Passes a nameable upgrade through untouched", () => {
    expect.hasAssertions();

    const upgrade = {
      currentValue: "^1.10.10",
      currentVersion: "1.10.10",
      datasource: "npm",
      depName: "oxlint",
      depType: "devDependencies",
      displayFrom: "^1.10.10",
      displayTo: "^2.10.11",
      manager: "npm",
      newValue: "^2.10.11",
      newVersion: "2.10.11",
      packageFile: "packages/example/package.json",
      packageName: "oxlint",
      updateType: "minor",
    } as const;

    expect(getUpgradeList([upgrade])).toStrictEqual([upgrade]);
  });

  it("Keeps an override selector when Renovate parsed the clean packageName out of it", () => {
    expect.hasAssertions();

    const upgrade = {
      depName: "minimatch@>=10.0.0 <10.2.3",
      depType: "pnpm-workspace.overrides",
      displayTo: "10.2.3",
      newValue: "10.2.3",
      packageFile: "pnpm-workspace.yaml",
      packageName: "minimatch",
    } as const;

    expect(getUpgradeList([upgrade])).toStrictEqual([upgrade]);
  });

  it("Skips an upgrade with no dependency name, which is what lockFileMaintenance sends", () => {
    expect.hasAssertions();

    const upgrade = { packageFile: "pnpm-lock.yaml", updateType: "lockFileMaintenance" } as const;

    expect(getUpgradeList([upgrade])).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no dependency name or manifest path/u });
  });

  it("Skips an upgrade with no manifest path", () => {
    expect.hasAssertions();

    expect(getUpgradeList([{ depName: "ky", newVersion: "3.0.0" }])).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /no dependency name or manifest path/u });
  });

  it.each([
    ["minimatch@>=10.0.0 <10.2.3", "a security-range override key"],
    ["foo>bar", "a nested override path"],
    ["some package", "a name with a space"],
  ])("Skips %s, which is %s rather than a dependency name", (depName) => {
    expect.hasAssertions();

    const upgrade = { depName, newVersion: "1.0.0", packageFile: "package.json" } as const;

    expect(getUpgradeList([upgrade])).toStrictEqual([]);
    recorder.assertLogged({ level: "info", message: /version range rather than a dependency name/u });
  });

  it("Skips an upgrade whose displayTo is empty or missing, which has nothing to say", () => {
    expect.hasAssertions();

    expect(
      getUpgradeList([
        {
          depName: "ky",
          displayFrom: "",
          displayTo: "",
          packageFile: "package.json",
          packageName: "ky",
          updateType: "patch",
        },
        {
          depName: "turbo",
          newValue: "^3.0.0",
          packageFile: "package.json",
          packageName: "turbo",
          updateType: "patch",
        },
      ]),
    ).toStrictEqual([]);
    recorder.assertLogged({ level: "warning", message: /empty displayTo/u });
  });

  it("Reads every upgrade in the payload", () => {
    expect.hasAssertions();

    const upgradeList = getUpgradeList([
      { depName: "a", displayTo: "1.0.0", packageFile: "packages/a/package.json", packageName: "a" },
      { depName: "b", displayTo: "2.0.0", packageFile: "packages/b/package.json", packageName: "b" },
    ]);

    expect(upgradeList.map((upgrade) => upgrade.depName)).toStrictEqual(["a", "b"]);
  });
});

// Unreviewed
/** Renders one changeset through `writeChangesets`, in a throwaway workspace, and reads back what it wrote. */
const render = async (template: string, resolvedUpgrade: ResolvedRenovateUpgrade): Promise<string> => {
  const directory = await createWorkspace({ ".changeset/.keep": "" });

  await writeChangesets({ cwd: directory, resolvedUpgradeList: [resolvedUpgrade], template });

  const [changeset] = await readChangesetList(directory);

  return changeset?.content ?? "";
};

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

describe(getPackageList, () => {
  it("Fails when the repository has no Changesets config, which this tool exists to write for", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      "package.json": '{ "name": "root", "private": true, "version": "0.0.0" }\n',
      "packages/app/package.json": '{ "name": "@fixture/app", "version": "1.0.0" }\n',
      "pnpm-workspace.yaml": "packages:\n  - packages/app\n",
    });

    await expect(getPackageList({ cwd })).rejects.toThrow(/ENOENT.*config\.json/u);
  });
});

// Unreviewed
const resolveOwner = (packageFile: string, packageList: Package[] = PACKAGE_LIST): string | null =>
  resolveDependency({ cwd: ROOT_DIRECTORY, packageList, upgrade: { packageFile } });

describe(resolveDependency, () => {
  it("Gives a package its own manifest", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/app/package.json")).toBe("@fixture/app");
  });

  it("Gives a package a manifest nested inside it", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/app/docker/docker-compose.yaml")).toBe("@fixture/app");
  });

  it("Gives a nested package its own manifests rather than the parent's", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/parent/child/package.json")).toBe("@fixture/child");
  });

  it("Still gives the parent the manifests that aren't inside the nested package", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/parent/Dockerfile")).toBe("@fixture/parent");
  });

  it("Doesn't let a sibling whose name shares a prefix claim the manifest", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/app-extras/package.json")).toBe("@fixture/app-extras");
  });

  it("Gives a repository-root manifest to nobody", () => {
    expect.hasAssertions();

    expect(resolveOwner("mise.toml")).toBeNull();
    expect(resolveOwner("pnpm-workspace.yaml")).toBeNull();
    expect(resolveOwner(".github/workflows/ci.yaml")).toBeNull();
  });

  it("Gives a manifest in an unrelated directory to nobody", () => {
    expect.hasAssertions();

    expect(resolveOwner("packages/not-a-package/package.json")).toBeNull();
  });

  it("Gives an upgrade with no manifest path to nobody", () => {
    expect.hasAssertions();

    expect(resolveDependency({ cwd: ROOT_DIRECTORY, packageList: PACKAGE_LIST, upgrade: {} })).toBeNull();
  });

  it("Gives everything to the one package in a single-package repository", () => {
    expect.hasAssertions();

    const singlePackageList = [buildOwnedPackage(".", "solo")];

    expect(resolveOwner("package.json", singlePackageList)).toBe("solo");
    expect(resolveOwner("mise.toml", singlePackageList)).toBe("solo");
    expect(resolveOwner("docker/Dockerfile", singlePackageList)).toBe("solo");
  });
});

describe(getSharedDeclarationPackageNameList, () => {
  const packageList = [
    buildPackage("catalogued", { dependencies: { turbo: "catalog:shared-dev" } }),
    buildPackage("declares", { dependencies: { turbo: "^2.10.10" } }),
  ];

  it("Expands a pnpm catalog to its consumers", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depName: "turbo", depType: "pnpm.catalog.shared-dev" },
      }),
    ).resolves.toStrictEqual(["catalogued"]);
  });

  it("Expands a Yarn catalog the same way", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depName: "turbo", depType: "yarn.catalog.shared-dev" },
      }),
    ).resolves.toStrictEqual(["catalogued"]);
  });

  it("Expands a catalog even when the root happens to be a workspace package", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: true,
        packageList,
        upgrade: { depName: "turbo", depType: "pnpm.catalog.shared-dev" },
      }),
    ).resolves.toStrictEqual(["catalogued"]);
  });

  it.each(["overrides", "pnpm.overrides", "pnpm-workspace.overrides", "resolutions"])(
    "Expands %s only when no package owns the manifest",
    async (depType) => {
      expect.hasAssertions();

      // Drawing a dependency from a catalog is still declaring it, so an override pinning it reaches both packages.
      await expect(
        getSharedDeclarationPackageNameList({
          isOwned: false,
          packageList,
          upgrade: { depName: "turbo", depType },
        }),
      ).resolves.toStrictEqual(["catalogued", "declares"]);
      await expect(
        getSharedDeclarationPackageNameList({
          isOwned: true,
          packageList,
          upgrade: { depName: "turbo", depType },
        }),
      ).resolves.toBeNull();
    },
  );

  it("Leaves an override that pins something transitive to nobody", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depName: "minimatch", depType: "overrides" },
      }),
    ).resolves.toStrictEqual([]);
  });

  it("Leaves an ordinary dependency to ownership", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depName: "turbo", depType: "devDependencies" },
      }),
    ).resolves.toBeNull();
  });

  it("Expands a Cargo workspace declaration to the crates that inherit it", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/heir/Cargo.toml": '[package]\nname = "heir"\n\n[dependencies]\nserde.workspace = true\n',
      "packages/pinned/Cargo.toml": '[package]\nname = "pinned"\n\n[dependencies]\nserde = "1.0.0"\n',
    });
    const cargoPackageList: Package[] = [
      {
        dir: path.join(directory, "packages/heir"),
        packageJson: { name: "heir", version: "1.0.0" },
        relativeDir: "packages/heir",
      },
      {
        dir: path.join(directory, "packages/pinned"),
        packageJson: { name: "pinned", version: "1.0.0" },
        relativeDir: "packages/pinned",
      },
    ];

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList: cargoPackageList,
        upgrade: { depName: "serde", depType: "workspace.dependencies", manager: "cargo" },
      }),
    ).resolves.toStrictEqual(["heir"]);
  });

  it("Leaves a workspace.dependencies upgrade from another manager to ownership", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/heir/Cargo.toml": '[package]\nname = "heir"\n\n[dependencies]\nserde.workspace = true\n',
    });

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList: [
          {
            dir: path.join(directory, "packages/heir"),
            packageJson: { name: "heir", version: "1.0.0" },
            relativeDir: "packages/heir",
          },
        ],
        upgrade: { depName: "serde", depType: "workspace.dependencies", manager: "not-cargo" },
      }),
    ).resolves.toBeNull();
  });

  it("Leaves a workspace.dependencies upgrade Renovate credited to no manager to ownership", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      "packages/heir/Cargo.toml": '[package]\nname = "heir"\n\n[dependencies]\nserde.workspace = true\n',
    });

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList: [
          {
            dir: path.join(directory, "packages/heir"),
            packageJson: { name: "heir", version: "1.0.0" },
            relativeDir: "packages/heir",
          },
        ],
        upgrade: { depName: "serde", depType: "workspace.dependencies" },
      }),
    ).resolves.toBeNull();
  });

  it("Leaves an upgrade with no dependency type to ownership", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depName: "turbo" },
      }),
    ).resolves.toBeNull();
  });

  it("Leaves an upgrade with no dependency name to ownership", async () => {
    expect.hasAssertions();

    await expect(
      getSharedDeclarationPackageNameList({
        isOwned: false,
        packageList,
        upgrade: { depType: "pnpm.catalog.shared-dev" },
      }),
    ).resolves.toBeNull();
  });
});

// Unreviewed
const buildResolvedUpgrade = (overrides: Partial<ResolvedRenovateUpgrade> = {}): ResolvedRenovateUpgrade => ({
  changesetPackageName: "@fixture/app",
  currentDigest: null,
  currentValue: "^2.0.2",
  currentVersion: "2.0.2",
  datasource: "npm",
  depName: "ky",
  depType: "dependencies",
  displayFrom: "^2.0.2",
  displayTo: "^3.0.0",
  manager: "npm",
  newDigest: null,
  newName: null,
  newValue: "^3.0.0",
  newVersion: "3.0.0",
  packageFile: "packages/app/package.json",
  packageName: "ky",
  sourceUrl: "https://github.com/sindresorhus/ky",
  updateType: "major",
  ...overrides,
});

// Unreviewed
const renderBody = async (template: string, overrides: Partial<ResolvedRenovateUpgrade> = {}): Promise<string> =>
  render(template, buildResolvedUpgrade(overrides));

describe(writeChangesets, () => {
  it("Interpolates a variable", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{depName}} {{displayTo}}")).resolves.toBe("ky ^3.0.0\n");
  });

  it("Treats the triple-brace form as raw text, the same as the double-brace form", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{{depName}}} {{depName}}")).resolves.toBe("ky ky\n");
  });

  it("Tolerates whitespace inside an expression", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{ depName }}|{{#if  currentVersion }}yes{{ else }}no{{/if}}")).resolves.toBe("ky|yes\n");
  });

  it("Rejects a closing tag written with a space before the slash, as Renovate's own templates do", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if displayFrom}}x{{ /if }}")).rejects.toThrow(/Parse error on line 1/u);
  });

  it("Ignores a comment", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{! a note }}{{depName}}")).resolves.toBe("ky\n");
  });

  it("Rejects a partial, which has no file to resolve against", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{> shared}}")).rejects.toThrow(/partial shared could not be found/u);
  });

  it("Renders a null value as nothing", async () => {
    expect.hasAssertions();

    await expect(renderBody("[{{newName}}]")).resolves.toBe("[]\n");
  });

  it("Renders a false flag as the word false, the way Renovate does — flags belong inside conditions", async () => {
    expect.hasAssertions();

    await expect(renderBody("[{{isReplacement}}]", { isReplacement: false })).resolves.toBe("[false]\n");
  });

  it("Takes the consequent when the condition has a value", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if displayFrom}}from {{displayFrom}}{{/if}}")).resolves.toBe("from ^2.0.2\n");
  });

  it("Takes the alternate when Renovate defaulted the value to an empty string", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if displayFrom}}yes{{else}}no{{/if}}", { displayFrom: "" })).resolves.toBe("no\n");
  });

  it("Takes the alternate when the condition is null", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if newName}}renamed{{else}}same name{{/if}}", { newName: null })).resolves.toBe(
      "same name\n",
    );
  });

  it("Treats an empty string as falsy", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if currentValue}}has{{else}}none{{/if}}", { currentValue: "" })).resolves.toBe(
      "none\n",
    );
  });

  it("Nests conditions", async () => {
    expect.hasAssertions();

    const template = "{{#if isReplacement}}A{{else}}{{#if isRollback}}B{{else}}C{{/if}}{{/if}}";

    await expect(renderBody(template, { isReplacement: true })).resolves.toBe("A\n");
    await expect(renderBody(template, { isRollback: true })).resolves.toBe("B\n");
    await expect(renderBody(template)).resolves.toBe("C\n");
  });

  it("Leaves no blank lines behind where an untaken branch stood on its own line", async () => {
    expect.hasAssertions();

    await expect(renderBody("one\n{{#if newName}}\n\ntwo\n\n{{/if}}\nthree")).resolves.toBe("one\nthree\n");
  });

  it("Collapses the run of blank lines an untaken inline branch leaves behind", async () => {
    expect.hasAssertions();

    // Handlebars only drops the line a block tag sits on by itself, so an inline branch leaves its surrounding blank
    // lines in the output for this to collapse.
    await expect(renderBody("one\n\n{{#if newName}}two{{/if}}\n\nthree")).resolves.toBe("one\n\nthree\n");
    await expect(renderBody("a\n\n{{#if newName}}b{{/if}}\n{{#if newName}}c{{/if}}\n\nd")).resolves.toBe("a\n\nd\n");
  });

  it("Ends the file with exactly one newline", async () => {
    expect.hasAssertions();

    await expect(renderBody("body\n\n\n")).resolves.toBe("body\n");
    await expect(renderBody("body")).resolves.toBe("body\n");
  });

  it("Drops the blank lines a template starts with, so the frontmatter comes first", async () => {
    expect.hasAssertions();

    await expect(renderBody("\n\nbody")).resolves.toBe("body\n");
  });

  it("Throws for a field Renovate omitted, so a template guards an optional field with a condition", async () => {
    expect.hasAssertions();

    await expect(render("{{currentDigest}}", { changesetPackageName: "solo", depName: "ky" })).rejects.toThrow(
      /"currentDigest" not defined/u,
    );
    await expect(
      render("{{#if currentDigest}}{{currentDigest}}{{else}}none{{/if}}", {
        changesetPackageName: "solo",
        depName: "ky",
      }),
    ).resolves.toBe("none\n");
  });

  it("Rejects a variable that isn't a field of an upgrade", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{newversion}}")).rejects.toThrow(/"newversion" not defined/u);
  });

  it("Reads a name no upgrade carries inside a condition as falsy, the way Renovate does", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if newversion}}yes{{else}}no{{/if}}")).resolves.toBe("no\n");
  });

  it("Renders nothing for a block helper with no data behind it", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#each upgrades}}x{{/each}}")).resolves.toBe("\n");
  });

  it("Rejects an unclosed condition", async () => {
    expect.hasAssertions();

    await expect(renderBody("{{#if displayFrom}}x")).rejects.toThrow(/Parse error on line 1/u);
    await expect(renderBody("{{#if displayFrom}}x")).rejects.toThrow(/'OPEN_ENDBLOCK', got 'EOF'/u);
  });

  it("Rejects a closing tag with no condition", async () => {
    expect.hasAssertions();

    await expect(renderBody("x{{/if}}")).rejects.toThrow(/Parse error on line 1/u);
  });

  it("Rejects an else with no condition", async () => {
    expect.hasAssertions();

    await expect(renderBody("x{{else}}y")).rejects.toThrow(/Parse error on line 1/u);
  });
});

describe("Default template", () => {
  it("Names both display values of an ordinary update", async () => {
    expect.hasAssertions();

    await expect(render(defaultTemplate, buildResolvedUpgrade())).resolves.toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated [ky](https://github.com/sindresorhus/ky) from `^2.0.2` to `^3.0.0`.\n',
    );
  });

  it("Omits the from side when Renovate has nothing to display there", async () => {
    expect.hasAssertions();

    await expect(render(defaultTemplate, buildResolvedUpgrade({ displayFrom: "" }))).resolves.toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated [ky](https://github.com/sindresorhus/ky) to `^3.0.0`.\n',
    );
  });

  it("Tags a vulnerability-alert upgrade with its severity", async () => {
    expect.hasAssertions();

    await expect(
      render(defaultTemplate, buildResolvedUpgrade({ isVulnerabilityAlert: true, vulnerabilitySeverity: "HIGH" })),
    ).resolves.toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated [ky](https://github.com/sindresorhus/ky) from `^2.0.2` to `^3.0.0`. [Security: HIGH]\n',
    );
  });

  it("Tags a vulnerability alert that carries no severity as plain Security", async () => {
    expect.hasAssertions();

    await expect(render(defaultTemplate, buildResolvedUpgrade({ isVulnerabilityAlert: true }))).resolves.toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated [ky](https://github.com/sindresorhus/ky) from `^2.0.2` to `^3.0.0`. [Security]\n',
    );
  });

  it("Composes the security tag with the other sentences", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        displayTo: "2.0.2",
        isPin: true,
        isVulnerabilityAlert: true,
        newValue: "2.0.2",
        newVersion: "2.0.2",
        updateType: "pin",
        vulnerabilitySeverity: "CRITICAL",
      }),
    );

    expect(content).toBe(
      '---\n"@fixture/app": patch\n---\n\nPinned [ky](https://github.com/sindresorhus/ky) to `2.0.2`. [Security: CRITICAL]\n',
    );
  });

  it("Falls back to backticks when the datasource knows no sourceUrl", async () => {
    expect.hasAssertions();

    await expect(render(defaultTemplate, buildResolvedUpgrade({ sourceUrl: null }))).resolves.toBe(
      '---\n"@fixture/app": patch\n---\n\nUpdated `ky` from `^2.0.2` to `^3.0.0`.\n',
    );
  });

  it("Names the arriving dependency on a replacement", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        displayTo: "3.0.0",
        isReplacement: true,
        newName: "some-fork",
        newValue: "3.0.0",
        newVersion: null,
        updateType: "replacement",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nReplaced `ky` with `some-fork` `3.0.0`.\n');
  });

  it("Doesn't read a rollback as an upgrade", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        currentVersion: "2.10.11",
        depName: "turbo",
        displayFrom: "2.10.11",
        displayTo: "2.10.10",
        isRollback: true,
        newVersion: "2.10.10",
        packageName: "turbo",
        sourceUrl: null,
        updateType: "rollback",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nRolled back `turbo` to `2.10.10`.\n');
  });

  it("Pins a dependency rather than reading the narrowed range as an update", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        displayTo: "2.0.2",
        isPin: true,
        newValue: "2.0.2",
        newVersion: "2.0.2",
        updateType: "pin",
      }),
    );

    expect(content).toBe(
      '---\n"@fixture/app": patch\n---\n\nPinned [ky](https://github.com/sindresorhus/ky) to `2.0.2`.\n',
    );
  });

  it("Pins a digest the same way, with no from side on a first pin", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        depName: "actions/checkout",
        displayFrom: "",
        displayTo: "3d3c42e",
        isPinDigest: true,
        newDigest: "3d3c42e5aac5ba805825da76410c181273ba90b1",
        newValue: "v7.0.1",
        packageName: "actions/checkout",
        sourceUrl: null,
        updateType: "pinDigest",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nPinned `actions/checkout` to `3d3c42e`.\n');
  });

  it("Names both digests on a digest update", async () => {
    expect.hasAssertions();

    const content = await render(
      defaultTemplate,
      buildResolvedUpgrade({
        currentDigest: "sha256:032b412aaaaaaaaa",
        currentVersion: null,
        depName: "timescaledb",
        displayFrom: "032b412",
        displayTo: "cf49c5d",
        newDigest: "sha256:cf49c5dbbbbbbbbb",
        newVersion: null,
        packageName: "timescaledb",
        sourceUrl: null,
        updateType: "digest",
      }),
    );

    expect(content).toBe('---\n"@fixture/app": patch\n---\n\nUpdated `timescaledb` from `032b412` to `cf49c5d`.\n');
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
const runIn = async (directory: string, upgradeList: RenovateUpgrade[]): Promise<void> => {
  await run({ cwd: directory, templateFilePath: undefined, upgradeListString: encodeUpgradeList(upgradeList) });
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
        displayFrom: "1.10.10",
        displayTo: "2.10.11",
        newVersion: "2.10.11",
        packageFile: "packages/app/package.json",
        packageName: "oxlint",
        updateType: "major",
      },
    ]);

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map(({ content }) => content)).toStrictEqual([
      '---\n"@fixture/app": patch\n---\n\nUpdated `oxlint` from `1.10.10` to `2.10.11`.\n',
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
      {
        currentVersion: "0.2.337",
        depName: "chainctl",
        displayFrom: "0.2.337",
        displayTo: "0.2.338",
        newVersion: "0.2.338",
        packageFile: "mise.toml",
      },
      {
        currentDigest: "sha256:aaaaaaabbbbbbb",
        depName: "actions/checkout",
        displayFrom: "aaaaaaa",
        displayTo: "ccccccc",
        newDigest: "sha256:cccccccddddddd",
        packageFile: ".github/workflows/ci.yaml",
        packageName: "actions/checkout",
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
        displayFrom: "2.10.10",
        displayTo: "2.10.11",
        newVersion: "2.10.11",
        packageFile: "pnpm-workspace.yaml",
        packageName: "turbo",
        updateType: "patch",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"@fixture/consumer-a": patch\n---\n\nUpdated `turbo` from `2.10.10` to `2.10.11`.\n',
      '---\n"@fixture/consumer-b": patch\n---\n\nUpdated `turbo` from `2.10.10` to `2.10.11`.\n',
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
        displayFrom: "1.0.0",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: `packages/${directoryName}/package.json`,
        packageName: `dependency-${directoryName}`,
      })),
    );

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual([
      '---\n"@fixture/public": patch\n---\n\nUpdated `dependency-public` from `1.0.0` to `2.0.0`.\n',
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

    await runIn(directory, [
      {
        depName: "ky",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "packages/outer/inner/package.json",
        packageName: "ky",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/outer": patch\n---\n\nUpdated `ky` to `2.0.0`.\n']);
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
      {
        depName: "ky",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "packages/outer/inner/package.json",
        packageName: "ky",
      },
      {
        depName: "turbo",
        displayTo: "3.0.0",
        newVersion: "3.0.0",
        packageFile: "packages/outer/Dockerfile",
        packageName: "turbo",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"@fixture/inner": patch\n---\n\nUpdated `ky` to `2.0.0`.\n',
      '---\n"@fixture/outer": patch\n---\n\nUpdated `turbo` to `3.0.0`.\n',
    ]);
  });

  it("Gives everything to the one package in a single-package repository", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [
      {
        currentVersion: "1.0.0",
        depName: "ky",
        displayFrom: "1.0.0",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "package.json",
        packageName: "ky",
      },
      {
        currentVersion: "24.0.0",
        depName: "node",
        displayFrom: "24.0.0",
        displayTo: "24.1.0",
        newVersion: "24.1.0",
        packageFile: "mise.toml",
        packageName: "node",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList.toSorted()).toStrictEqual([
      '---\n"solo": patch\n---\n\nUpdated `ky` from `1.0.0` to `2.0.0`.\n',
      '---\n"solo": patch\n---\n\nUpdated `node` from `24.0.0` to `24.1.0`.\n',
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
      {
        currentVersion: "1.0.0",
        depName: "ky",
        displayFrom: "1.0.0",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "packages/app/package.json",
        packageName: "ky",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"@fixture/app": patch\n---\n\nUpdated `ky` from `1.0.0` to `2.0.0`.\n']);
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
        displayFrom: "2.10.10",
        displayTo: "2.10.11",
        newVersion: "2.10.11",
        packageFile: "package.json",
        packageName: "turbo",
        updateType: "patch",
      },
    ]);

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual([
      '---\n"@fixture/app": patch\n---\n\nUpdated `turbo` from `2.10.10` to `2.10.11`.\n',
    ]);
  });

  it("Writes a changeset under the clean name for a security-range override", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/declares/package.json": serializePackageJson({
        dependencies: { minimatch: "^10.0.0" },
        name: "@fixture/declares",
        version: "1.0.0",
      }),
      "packages/unrelated/package.json": serializePackageJson({ name: "@fixture/unrelated", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/declares", "packages/unrelated"]),
    });

    await runIn(directory, [
      {
        depName: "minimatch@>=10.0.0 <10.2.3",
        depType: "pnpm-workspace.overrides",
        displayTo: "10.2.3",
        newValue: "10.2.3",
        packageFile: "pnpm-workspace.yaml",
        packageName: "minimatch",
      },
    ]);

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"@fixture/declares": patch\n---\n\nUpdated `minimatch` to `10.2.3`.\n',
    ]);
  });

  it("Uses a template the options point at", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depName}}@{{displayTo}}\n',
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await run({
      cwd: directory,
      templateFilePath: ".github/changeset.md",
      upgradeListString: encodeUpgradeList([
        { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
      ]),
    });

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"solo": patch\n---\n\nky@2.0.0\n']);
  });

  it("Keeps a field it doesn't name, so a template can still read it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depNameLinked}}\n',
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await run({
      cwd: directory,
      templateFilePath: ".github/changeset.md",
      upgradeListString: encodeUpgradeList([
        {
          depName: "ky",
          depNameLinked: "[ky](https://github.com/sindresorhus/ky)",
          displayTo: "2.0.0",
          newVersion: "2.0.0",
          packageFile: "package.json",
          packageName: "ky",
        },
      ]),
    });

    const changesetList = await readChangesetList(directory);
    const contentList = changesetList.map((changeset) => changeset.content);

    expect(contentList).toStrictEqual(['---\n"solo": patch\n---\n\n[ky](https://github.com/sindresorhus/ky)\n']);
  });

  it("Fails when a template it was told to use isn't there", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(
      run({
        cwd: directory,
        templateFilePath: ".github/missing.md",
        upgradeListString: encodeUpgradeList([
          { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
        ]),
      }),
    ).rejects.toThrow(/ENOENT.*missing\.md/u);
  });

  it("Overwrites its own files on a rebase rather than accumulating a second set", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });
    const upgradeList: RenovateUpgrade[] = [
      {
        currentVersion: "1.0.0",
        depName: "ky",
        displayFrom: "1.0.0",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "package.json",
        packageName: "ky",
      },
      {
        currentVersion: "1.0.0",
        depName: "turbo",
        displayFrom: "1.0.0",
        displayTo: "2.0.0",
        newVersion: "2.0.0",
        packageFile: "package.json",
        packageName: "turbo",
      },
    ];

    await runIn(directory, upgradeList);

    const firstChangesetList = await readChangesetList(directory);

    await runIn(directory, upgradeList);

    expect(firstChangesetList).toHaveLength(2);
    await expect(readChangesetList(directory)).resolves.toStrictEqual(firstChangesetList);
  });

  it("Names each file after a hash of its own content", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await runIn(directory, [
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    for (const { content, fileName } of await readChangesetList(directory)) {
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);

      expect(fileName).toBe(`renovate-${hash}.md`);
    }
  });

  it("Fails on an empty payload rather than silently writing nothing", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(run({ cwd: directory, templateFilePath: undefined, upgradeListString: "" })).rejects.toThrow(/JSON/u);
    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });

  it("Throws when the payload isn't an array, because that means the consumer's template broke", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    // `e30=` is base64 for `{}` — decodable JSON, but not the array Renovate is supposed to send.
    await expect(run({ cwd: directory, templateFilePath: undefined, upgradeListString: "e30=" })).rejects.toThrow(
      /expected array, received object/u,
    );
  });

  it("Throws when a field isn't the type Renovate sends, naming where it went wrong", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    // `W3siZGVwTmFtZSI6NDJ9XQ==` is base64 for `[{"depName":42}]` — a number where Renovate sends a string.
    await expect(
      run({ cwd: directory, templateFilePath: undefined, upgradeListString: "W3siZGVwTmFtZSI6NDJ9XQ==" }),
    ).rejects.toThrow(/depName[\s\S]*expected string, received number/u);
  });

  it("Throws when the payload isn't decodable JSON", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(
      run({ cwd: directory, templateFilePath: undefined, upgradeListString: "not base64 encoded json" }),
    ).rejects.toThrow(/JSON/u);
  });

  it("Reports an invalid Changesets config rather than writing against it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".changeset/config.json": buildChangesetConfig({ privatePackages: "yes" }),
      "package.json": serializePackageJson({ name: "solo", version: "1.0.0" }),
    });

    await expect(
      runIn(directory, [
        { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
      ]),
    ).rejects.toThrow(/config\.json is invalid/u);
  });

  it("Fails for a repository that has no Changesets config at all", async () => {
    expect.hasAssertions();

    const directory = await createWorkspace({
      ".changeset/.keep": "",
      "package.json": serializePackageJson({ name: "root", private: true, version: "0.0.0" }),
      "packages/app/package.json": serializePackageJson({ name: "@fixture/app", version: "1.0.0" }),
      "pnpm-workspace.yaml": buildPnpmWorkspace(["packages/app"]),
    });

    await expect(
      runIn(directory, [
        {
          depName: "ky",
          displayTo: "3.0.0",
          newVersion: "3.0.0",
          packageFile: "packages/app/package.json",
          updateType: "major",
        },
      ]),
    ).rejects.toThrow(/ENOENT.*config\.json/u);
    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });
});

describe(configureLogger, () => {
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
      await configureLogger();
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await reset();
  });

  it("Reports success as an exit code of zero", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });
    const upgradeList = [
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ];

    await expect(main([encodeUpgradeList(upgradeList), "--cwd", directory])).resolves.toBe(0);
    await expect(readChangesetList(directory)).resolves.toHaveLength(1);
  });

  it("Reports a missing payload as a failure, since Renovate always sends one", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });

    await expect(main(["--cwd", directory])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /JSON/u });
    await expect(readChangesetList(directory)).resolves.toStrictEqual([]);
  });

  it("Reports a failure as an exit code of one, with the reason on the logger", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });

    // `e30=` is base64 for `{}` — decodable JSON, but not the array Renovate is supposed to send.
    await expect(main(["e30=", "--cwd", directory])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /expected array, received object/u });
  });

  it("Takes every option from a flag", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depName}}@{{displayTo}}\n',
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });
    const payload = encodeUpgradeList([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    await expect(main([payload, "--cwd", directory, "--template-file-path", ".github/changeset.md"])).resolves.toBe(0);

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nky@2.0.0\n',
    ]);
  });

  it("Takes every option from the environment when no flag names it", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depName}}@{{displayTo}}\n',
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });
    const payload = encodeUpgradeList([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    vi.stubEnv("RENOVATE_CHANGESETS_CWD", directory);
    vi.stubEnv("RENOVATE_CHANGESETS_TEMPLATE_FILE_PATH", ".github/changeset.md");

    await expect(main([payload])).resolves.toBe(0);

    const changesetList = await readChangesetList(directory);

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nky@2.0.0\n',
    ]);
  });

  it("Lets a flag win over the environment", async () => {
    expect.hasAssertions();

    const directory = await createTemporaryWorkspace({
      "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
    });
    const payload = encodeUpgradeList([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    // The environment points somewhere that would fail, so the run only succeeds if the flag wins.
    vi.stubEnv("RENOVATE_CHANGESETS_CWD", path.join(directory, "does-not-exist"));

    await expect(main([payload, "--cwd", directory])).resolves.toBe(0);
    await expect(readChangesetList(directory)).resolves.toHaveLength(1);
  });

  it("Asks for nothing once it has printed help", async () => {
    expect.hasAssertions();

    const spy = vi.spyOn(console, "log").mockReturnValue();

    try {
      await expect(main(["--help"])).resolves.toBe(0);
      expect(spy.mock.calls.flat().join("\n")).toMatch(/renovate-changesets \[upgradeListString\]/u);
    } finally {
      spy.mockRestore();
    }
  });

  it("Asks for nothing once it has printed the version", async () => {
    expect.hasAssertions();

    const spy = vi.spyOn(console, "log").mockReturnValue();

    try {
      await expect(main(["--version"])).resolves.toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/u));
    } finally {
      spy.mockRestore();
    }
  });

  it("Rejects a flag it doesn't know rather than ignoring it", async () => {
    expect.hasAssertions();

    await expect(main(["--cwdd", "/elsewhere"])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /Unknown argument/u });
  });

  it("Rejects a second positional argument", async () => {
    expect.hasAssertions();

    await expect(main(["one", "two"])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /Unknown argument/u });
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
const BODY_PATTERN =
  /^Updated `(?<dependencyName>[^`]+)` (?:from `(?<fromVersion>[^`]+)` )?to `(?<toVersion>[^`]+)`\.$/u;
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
    displayFrom: `${index + 1}.0.0`,
    displayTo: `${index + 1}.1.0`,
    newVersion: `${index + 1}.1.0`,
    packageFile: `${fixturePackage.directoryPath}/package.json`,
    packageName: `dependency-${index}`,
    updateType: "minor" as const,
  })),
  // A manifest at the repository root, owned by no package.
  {
    currentVersion: "0.2.337",
    depName: "chainctl",
    displayFrom: "0.2.337",
    displayTo: "0.2.338",
    newVersion: "0.2.338",
    packageFile: "mise.toml",
    packageName: "chainctl",
  },
  // A manifest in a directory that isn't a package at all.
  {
    currentVersion: "1.0.0",
    depName: "stray-dependency",
    displayFrom: "1.0.0",
    displayTo: "1.1.0",
    newVersion: "1.1.0",
    packageFile: "packages/not-a-package/package.json",
    packageName: "stray-dependency",
  },
  // One update per catalog, each with its own version.
  ...fixture.catalogNameList.map((catalogName, index) => ({
    currentVersion: `10.${index}.0`,
    depName: CATALOG_DEPENDENCY_NAME,
    depType: `pnpm.catalog.${catalogName}`,
    displayFrom: `10.${index}.0`,
    displayTo: `10.${index}.1`,
    newVersion: `10.${index}.1`,
    packageFile: "pnpm-workspace.yaml",
    packageName: CATALOG_DEPENDENCY_NAME,
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
  const options = {
    cwd: fixture.directory,
    templateFilePath: undefined,
    upgradeListString: encodeUpgradeList(upgradeList),
  };
  await run(options);

  const firstChangesetList = await readChangesetList(fixture.directory);

  await run(options);

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
  expect(changesetList).toStrictEqual(firstChangesetList);
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
    30_000,
  );
});
