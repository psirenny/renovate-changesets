import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fc, test as propertyTest } from "@fast-check/vitest";
import { configure, getLogger, reset } from "@logtape/logtape";
import { createLogRecorder } from "@logtape/testing/recorder";
import { getPackages } from "@manypkg/get-packages";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  configureLogger,
  main,
  readChangesetConfig,
  run,
  writeChangesets,
  type PackageUpgrade,
  type Upgrade,
} from "./index.js";

const encodeJson = (json: unknown): string => Buffer.from(JSON.stringify(json), "utf8").toString("base64");

const removeWorkspace = async ({ fileDirectory }: { fileDirectory: string }): Promise<void> => {
  await rm(fileDirectory, { force: true, recursive: true });
};

const writeFileMap = async ({
  fileDirectory,
  fileMap,
}: {
  fileDirectory: string;
  fileMap: Record<string, string>;
}): Promise<void> => {
  await Promise.all(
    Object.entries(fileMap).map(async ([relativeFilePath, content]) => {
      const filePath = path.join(fileDirectory, relativeFilePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }),
  );
};

const createWorkspace = async ({
  fileMap,
  parentDirectory = tmpdir(),
}: {
  fileMap: Record<string, string>;
  parentDirectory?: string;
}): Promise<string> => {
  await mkdir(parentDirectory, { recursive: true });
  const fileDirectory = await mkdtemp(path.join(parentDirectory, "renovate-changesets-"));

  onTestFinished(async () => {
    await removeWorkspace({ fileDirectory });
  });

  await writeFileMap({ fileDirectory, fileMap });

  return fileDirectory;
};

const readChangesets = async ({
  fileDirectory,
}: {
  fileDirectory: string;
}): Promise<{ content: string; fileName: string }[]> => {
  const changesetsFileDirectory = path.join(fileDirectory, ".changeset");
  const fileNameList = await readdir(changesetsFileDirectory);

  return Promise.all(
    fileNameList
      .filter((fileName) => fileName.startsWith("renovate-") && fileName.endsWith(".md"))
      .toSorted()
      .map(async (fileName) => ({
        content: await readFile(path.join(changesetsFileDirectory, fileName), "utf8"),
        fileName,
      })),
  );
};

const createChangeset = async ({
  resolvedUpgrade,
  template,
}: {
  resolvedUpgrade: PackageUpgrade;
  template: string;
}): Promise<string> => {
  const fileDirectory = await createWorkspace({ fileMap: { ".changeset/.keep": "" } });
  await writeChangesets({ cwd: fileDirectory, format: false, resolvedUpgradeList: [resolvedUpgrade], template });
  const [changeset] = await readChangesets({ fileDirectory });
  return changeset?.content ?? "";
};

describe(readChangesetConfig, () => {
  it("Fails when the repository has no Changesets config, which this tool exists to write for", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      fileMap: {
        "package.json": '{ "name": "root", "private": true, "version": "0.0.0" }\n',
        "packages/app/package.json": '{ "name": "@fixture/app", "version": "1.0.0" }\n',
        "pnpm-workspace.yaml": "packages:\n  - packages/app\n",
      },
    });

    await expect(readChangesetConfig({ cwd, workspace: await getPackages(cwd) })).rejects.toThrow(
      /ENOENT.*config\.json/u,
    );
  });
});

// Unreviewed
// Unreviewed
const buildResolvedUpgrade = (overrides: Partial<PackageUpgrade> = {}): PackageUpgrade => ({
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
const createFixtureChangeset = async ({
  overrides = {},
  template,
}: {
  overrides?: Partial<PackageUpgrade>;
  template: string;
}): Promise<string> => createChangeset({ resolvedUpgrade: buildResolvedUpgrade(overrides), template });
const formatterFixtureDirectory = path.join(import.meta.dirname, "..", "node_modules", ".cache", "renovate-changesets");

describe(writeChangesets, () => {
  it("Interpolates a variable", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{depName}} {{displayTo}}" })).resolves.toBe("ky ^3.0.0\n");
  });

  it("Treats the triple-brace form as raw text, the same as the double-brace form", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{{depName}}} {{depName}}" })).resolves.toBe("ky ky\n");
  });

  it("Tolerates whitespace inside an expression", async () => {
    expect.hasAssertions();

    await expect(
      createFixtureChangeset({ template: "{{ depName }}|{{#if  currentVersion }}yes{{ else }}no{{/if}}" }),
    ).resolves.toBe("ky|yes\n");
  });

  it("Rejects a closing tag written with a space before the slash, as Renovate's own templates do", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{#if displayFrom}}x{{ /if }}" })).rejects.toThrow(
      /Parse error on line 1/u,
    );
  });

  it("Ignores a comment", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{! a note }}{{depName}}" })).resolves.toBe("ky\n");
  });

  it("Rejects a partial, which has no file to resolve against", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{> shared}}" })).rejects.toThrow(
      /partial shared could not be found/u,
    );
  });

  it("Renders a null value as nothing", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "[{{newName}}]" })).resolves.toBe("[]\n");
  });

  it("Renders a false flag as the word false, the way Renovate does — flags belong inside conditions", async () => {
    expect.hasAssertions();

    await expect(
      createFixtureChangeset({ overrides: { isReplacement: false }, template: "[{{isReplacement}}]" }),
    ).resolves.toBe("[false]\n");
  });

  it("Takes the consequent when the condition has a value", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{#if displayFrom}}from {{displayFrom}}{{/if}}" })).resolves.toBe(
      "from ^2.0.2\n",
    );
  });

  it("Takes the alternate when Renovate defaulted the value to an empty string", async () => {
    expect.hasAssertions();

    await expect(
      createFixtureChangeset({ overrides: { displayFrom: "" }, template: "{{#if displayFrom}}yes{{else}}no{{/if}}" }),
    ).resolves.toBe("no\n");
  });

  it("Takes the alternate when the condition is null", async () => {
    expect.hasAssertions();

    await expect(
      createFixtureChangeset({
        overrides: { newName: null },
        template: "{{#if newName}}renamed{{else}}same name{{/if}}",
      }),
    ).resolves.toBe("same name\n");
  });

  it("Treats an empty string as falsy", async () => {
    expect.hasAssertions();

    await expect(
      createFixtureChangeset({
        overrides: { currentValue: "" },
        template: "{{#if currentValue}}has{{else}}none{{/if}}",
      }),
    ).resolves.toBe("none\n");
  });

  it("Nests conditions", async () => {
    expect.hasAssertions();

    const template = "{{#if isReplacement}}A{{else}}{{#if isRollback}}B{{else}}C{{/if}}{{/if}}";

    await expect(createFixtureChangeset({ overrides: { isReplacement: true }, template })).resolves.toBe("A\n");
    await expect(createFixtureChangeset({ overrides: { isRollback: true }, template })).resolves.toBe("B\n");
    await expect(createFixtureChangeset({ template })).resolves.toBe("C\n");
  });

  it("Leaves no blank lines behind where an untaken branch stood on its own line", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "one\n{{#if newName}}\n\ntwo\n\n{{/if}}\nthree" })).resolves.toBe(
      "one\nthree\n",
    );
  });

  it("Collapses the run of blank lines an untaken inline branch leaves behind", async () => {
    expect.hasAssertions();

    // Handlebars only drops the line a block tag sits on by itself, so an inline branch leaves its surrounding blank
    // lines in the output for this to collapse.
    await expect(createFixtureChangeset({ template: "one\n\n{{#if newName}}two{{/if}}\n\nthree" })).resolves.toBe(
      "one\n\nthree\n",
    );
    await expect(
      createFixtureChangeset({ template: "a\n\n{{#if newName}}b{{/if}}\n{{#if newName}}c{{/if}}\n\nd" }),
    ).resolves.toBe("a\n\nd\n");
  });

  it("Ends the file with exactly one newline", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "body\n\n\n" })).resolves.toBe("body\n");
    await expect(createFixtureChangeset({ template: "body" })).resolves.toBe("body\n");
  });

  it("Drops the blank lines a template starts with, so the frontmatter comes first", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "\n\nbody" })).resolves.toBe("body\n");
  });

  it("Throws for a field Renovate omitted, so a template guards an optional field with a condition", async () => {
    expect.hasAssertions();

    await expect(
      createChangeset({
        resolvedUpgrade: { changesetPackageName: "solo", depName: "ky", packageFile: "package.json" },
        template: "{{currentDigest}}",
      }),
    ).rejects.toThrow(/"currentDigest" not defined/u);
    await expect(
      createChangeset({
        resolvedUpgrade: {
          changesetPackageName: "solo",
          depName: "ky",
          packageFile: "package.json",
        },
        template: "{{#if currentDigest}}{{currentDigest}}{{else}}none{{/if}}",
      }),
    ).resolves.toBe("none\n");
  });

  it("Rejects a variable that isn't a field of an upgrade", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{newversion}}" })).rejects.toThrow(/"newversion" not defined/u);
  });

  it("Reads a name no upgrade carries inside a condition as falsy, the way Renovate does", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{#if newversion}}yes{{else}}no{{/if}}" })).resolves.toBe("no\n");
  });

  it("Renders nothing for a block helper with no data behind it", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{#each upgrades}}x{{/each}}" })).resolves.toBe("\n");
  });

  it("Rejects an unclosed condition", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "{{#if displayFrom}}x" })).rejects.toThrow(
      /Parse error on line 1/u,
    );
    await expect(createFixtureChangeset({ template: "{{#if displayFrom}}x" })).rejects.toThrow(
      /'OPEN_ENDBLOCK', got 'EOF'/u,
    );
  });

  it("Rejects a closing tag with no condition", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "x{{/if}}" })).rejects.toThrow(/Parse error on line 1/u);
  });

  it("Rejects an else with no condition", async () => {
    expect.hasAssertions();

    await expect(createFixtureChangeset({ template: "x{{else}}y" })).rejects.toThrow(/Parse error on line 1/u);
  });

  it("Formats what it wrote with the configured formatter", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      fileMap: { ".changeset/.keep": "", ".oxfmtrc.json": '{ "printWidth": 40, "proseWrap": "always" }\n' },
      parentDirectory: formatterFixtureDirectory,
    });

    await writeChangesets({
      cwd,
      format: "oxfmt",
      resolvedUpgradeList: [buildResolvedUpgrade()],
      template: "Updated {{depName}} from `{{displayFrom}}` to `{{displayTo}}` in the fixture package.",
    });

    const [changeset] = await readChangesets({ fileDirectory: cwd });

    expect(changeset?.content).toBe("Updated ky from `^2.0.2` to `^3.0.0` in\nthe fixture package.\n");
  });

  it("Detects the project's formatter when the config leaves format on auto", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      fileMap: { ".changeset/.keep": "", ".oxfmtrc.json": '{ "printWidth": 40, "proseWrap": "always" }\n' },
      parentDirectory: formatterFixtureDirectory,
    });

    await writeChangesets({
      cwd,
      format: "auto",
      resolvedUpgradeList: [buildResolvedUpgrade()],
      template: "Updated {{depName}} from `{{displayFrom}}` to `{{displayTo}}` in the fixture package.",
    });

    const [changeset] = await readChangesets({ fileDirectory: cwd });

    expect(changeset?.content).toBe("Updated ky from `^2.0.2` to `^3.0.0` in\nthe fixture package.\n");
  });

  it("Leaves what it wrote alone when formatting is off", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      fileMap: { ".changeset/.keep": "", ".oxfmtrc.json": '{ "printWidth": 40, "proseWrap": "always" }\n' },
      parentDirectory: formatterFixtureDirectory,
    });

    await writeChangesets({
      cwd,
      format: false,
      resolvedUpgradeList: [buildResolvedUpgrade()],
      template: "Updated {{depName}} from `{{displayFrom}}` to `{{displayTo}}` in the fixture package.",
    });

    const [changeset] = await readChangesets({ fileDirectory: cwd });

    expect(changeset?.content).toBe("Updated ky from `^2.0.2` to `^3.0.0` in the fixture package.\n");
  });

  it("Runs no formatter when it wrote nothing, so the rest of the repository is left as it was", async () => {
    expect.hasAssertions();

    const cwd = await createWorkspace({
      fileMap: {
        ".changeset/.keep": "",
        ".oxfmtrc.json": '{ "printWidth": 40, "proseWrap": "always" }\n',
        "NOTES.md": "A line that is long enough for the formatter to wrap it.\n",
      },
      parentDirectory: formatterFixtureDirectory,
    });

    await writeChangesets({ cwd, format: "oxfmt", resolvedUpgradeList: [], template: "{{depName}}" });

    await expect(readFile(path.join(cwd, "NOTES.md"), "utf8")).resolves.toBe(
      "A line that is long enough for the formatter to wrap it.\n",
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
const buildPnpmWorkspace = ({ relativeDirList }: { relativeDirList: string[] }): string =>
  ["packages:", ...relativeDirList.map((relativeDir) => `  - ${relativeDir}`), ""].join("\n");

// Unreviewed
const serializePackageJson = ({ value }: { value: Record<string, unknown> }): string =>
  `${JSON.stringify(value, null, 2)}\n`;

// Unreviewed
const createTemporaryWorkspace = async ({ fileMap }: { fileMap: Record<string, string> }): Promise<string> => {
  const fileDirectory = await createWorkspace({
    fileMap: { ".changeset/config.json": buildChangesetConfig(), ...fileMap },
  });

  return fileDirectory;
};

// Unreviewed
const runIn = async ({
  fileDirectory,
  upgradeList,
}: {
  fileDirectory: string;
  upgradeList: Upgrade[];
}): Promise<void> => {
  await run({ cwd: fileDirectory, templateFilePath: undefined, upgradeListString: encodeJson(upgradeList) });
};

describe(run, () => {
  it("Fails when a template it was told to use isn't there", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": serializePackageJson({ value: { name: "solo", version: "1.0.0" } }),
      },
    });

    await expect(
      run({
        cwd: fileDirectory,
        templateFilePath: ".github/missing.md",
        upgradeListString: encodeJson([
          { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
        ]),
      }),
    ).rejects.toThrow(/ENOENT.*missing\.md/u);
  });

  it("Fails on an undecodable payload rather than silently writing nothing", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": serializePackageJson({ value: { name: "solo", version: "1.0.0" } }),
      },
    });

    await expect(run({ cwd: fileDirectory, templateFilePath: undefined, upgradeListString: "" })).rejects.toThrow(
      /JSON/u,
    );
    await expect(
      run({ cwd: fileDirectory, templateFilePath: undefined, upgradeListString: "not base64 encoded json" }),
    ).rejects.toThrow(/JSON/u);
    await expect(readChangesets({ fileDirectory })).resolves.toStrictEqual([]);
  });

  it("Throws for an upgrade with no dependency name that isn't a lockfile refresh", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": serializePackageJson({ value: { name: "solo", version: "1.0.0" } }),
      },
    });

    await expect(
      runIn({
        fileDirectory,
        upgradeList: [{ displayTo: "^3.1.0", packageFile: "package.json", updateType: "patch" }],
      }),
    ).rejects.toThrow(/needs a depName unless it is lockFileMaintenance/u);
    await expect(readChangesets({ fileDirectory })).resolves.toStrictEqual([]);
  });

  it("Reports an invalid Changesets config rather than writing against it", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        ".changeset/config.json": buildChangesetConfig({ privatePackages: "yes" }),
        "package.json": serializePackageJson({ value: { name: "solo", version: "1.0.0" } }),
      },
    });

    await expect(
      runIn({
        fileDirectory,
        upgradeList: [
          { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
        ],
      }),
    ).rejects.toThrow(/config\.json is invalid/u);
  });

  it("Fails for a repository that has no Changesets config at all", async () => {
    expect.hasAssertions();

    const fileDirectory = await createWorkspace({
      fileMap: {
        ".changeset/.keep": "",
        "package.json": serializePackageJson({ value: { name: "root", private: true, version: "0.0.0" } }),
        "packages/app/package.json": serializePackageJson({ value: { name: "@fixture/app", version: "1.0.0" } }),
        "pnpm-workspace.yaml": buildPnpmWorkspace({ relativeDirList: ["packages/app"] }),
      },
    });

    await expect(
      runIn({
        fileDirectory,
        upgradeList: [
          {
            depName: "ky",
            displayTo: "3.0.0",
            newVersion: "3.0.0",
            packageFile: "packages/app/package.json",
            updateType: "major",
          },
        ],
      }),
    ).rejects.toThrow(/ENOENT.*config\.json/u);
    await expect(readChangesets({ fileDirectory })).resolves.toStrictEqual([]);
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

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });
    const upgradeList = [
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ];

    await expect(main([encodeJson(upgradeList), "--cwd", fileDirectory])).resolves.toBe(0);
    await expect(readChangesets({ fileDirectory })).resolves.toHaveLength(1);
  });

  it("Reports a missing payload as a failure, since Renovate always sends one", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });

    await expect(main(["--cwd", fileDirectory])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /JSON/u });
    await expect(readChangesets({ fileDirectory })).resolves.toStrictEqual([]);
  });

  it("Reports a failure as an exit code of one, with the reason on the logger", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });

    // `e30=` is base64 for `{}` — decodable JSON, but not the array Renovate is supposed to send.
    await expect(main(["e30=", "--cwd", fileDirectory])).resolves.toBe(1);
    mainRecorder.assertLogged({ level: "error", message: /expected array, received object/u });
  });

  it("Takes every option from a flag", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depName}}@{{displayTo}}\n',
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });
    const payload = encodeJson([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    await expect(main([payload, "--cwd", fileDirectory, "--template-file-path", ".github/changeset.md"])).resolves.toBe(
      0,
    );

    const changesetList = await readChangesets({ fileDirectory });

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nky@2.0.0\n',
    ]);
  });

  it("Takes every option from the environment when no flag names it", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        ".github/changeset.md": '---\n"{{changesetPackageName}}": patch\n---\n\n{{depName}}@{{displayTo}}\n',
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });
    const payload = encodeJson([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    vi.stubEnv("RENOVATE_CHANGESETS_CWD", fileDirectory);
    vi.stubEnv("RENOVATE_CHANGESETS_TEMPLATE_FILE_PATH", ".github/changeset.md");

    await expect(main([payload])).resolves.toBe(0);

    const changesetList = await readChangesets({ fileDirectory });

    expect(changesetList.map((changeset) => changeset.content)).toStrictEqual([
      '---\n"solo": patch\n---\n\nky@2.0.0\n',
    ]);
  });

  it("Lets a flag win over the environment", async () => {
    expect.hasAssertions();

    const fileDirectory = await createTemporaryWorkspace({
      fileMap: {
        "package.json": '{ "name": "solo", "version": "1.0.0" }\n',
      },
    });
    const payload = encodeJson([
      { depName: "ky", displayTo: "2.0.0", newVersion: "2.0.0", packageFile: "package.json", packageName: "ky" },
    ]);

    // The environment points somewhere that would fail, so the run only succeeds if the flag wins.
    vi.stubEnv("RENOVATE_CHANGESETS_CWD", path.join(fileDirectory, "does-not-exist"));

    await expect(main([payload, "--cwd", fileDirectory])).resolves.toBe(0);
    await expect(readChangesets({ fileDirectory })).resolves.toHaveLength(1);
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

type Drawn<Node> = Node extends readonly (infer Option)[]
  ? Drawn<Option>
  : Node extends object
    ? { -readonly [Key in keyof Node]: Drawn<Node[Key]> }
    : Node;

const matrix = {
  attribute: {
    hasSourceUrl: [false, true],
    security: [
      { payload: {}, security: "none", tag: "" },
      { payload: { isVulnerabilityAlert: true }, security: "alert", tag: " [Security]" },
      {
        payload: { isVulnerabilityAlert: true, vulnerabilitySeverity: "HIGH" },
        security: "alert-with-severity",
        tag: " [Security: HIGH]",
      },
    ],
    updateType: [
      {
        payload: {
          currentValue: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "1.1.0",
          isBump: true,
          newValue: "1.1.0",
          updateType: "bump",
        },
        sentence: "Updated <subject> from `1.0.0` to `1.1.0`.",
      },
      {
        payload: {
          currentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          currentDigestShort: "aaaaaaa",
          displayFrom: "aaaaaaa",
          displayTo: "bbbbbbb",
          isDigest: true,
          newDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          newDigestShort: "bbbbbbb",
          updateType: "digest",
        },
        sentence: "Updated <subject> from `aaaaaaa` to `bbbbbbb`.",
      },
      {
        payload: {
          currentVersion: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "1.1.0",
          isLockfileUpdate: true,
          newVersion: "1.1.0",
          updateType: "lockfileUpdate",
        },
        sentence: "Updated <subject> from `1.0.0` to `1.1.0`.",
      },
      {
        payload: {
          currentValue: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "2.0.0",
          isMajor: true,
          newValue: "2.0.0",
          updateType: "major",
        },
        sentence: "Updated <subject> from `1.0.0` to `2.0.0`.",
      },
      {
        payload: {
          currentValue: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "1.1.0",
          isMinor: true,
          newValue: "1.1.0",
          updateType: "minor",
        },
        sentence: "Updated <subject> from `1.0.0` to `1.1.0`.",
      },
      {
        payload: {
          currentValue: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "1.0.1",
          isPatch: true,
          newValue: "1.0.1",
          updateType: "patch",
        },
        sentence: "Updated <subject> from `1.0.0` to `1.0.1`.",
      },
      {
        payload: {
          currentValue: "^1.0.0",
          displayFrom: "^1.0.0",
          displayTo: "1.0.0",
          isPin: true,
          newValue: "1.0.0",
          updateType: "pin",
        },
        sentence: "Pinned <subject> to `1.0.0`.",
      },
      {
        payload: {
          displayFrom: "",
          displayTo: "bbbbbbb",
          isPinDigest: true,
          newDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          newDigestShort: "bbbbbbb",
          newValue: "1.0.0",
          updateType: "pinDigest",
        },
        sentence: "Pinned <subject> to `bbbbbbb`.",
      },
      {
        payload: {
          currentValue: "1.0.0",
          displayFrom: "1.0.0",
          displayTo: "1.1.0",
          isReplacement: true,
          newName: "replacement",
          newValue: "1.1.0",
          updateType: "replacement",
        },
        sentence: "Replaced `<name>` with `replacement` `1.1.0`.",
      },
      {
        payload: {
          currentValue: "1.1.0",
          displayFrom: "1.1.0",
          displayTo: "1.0.0",
          isRollback: true,
          newValue: "1.0.0",
          updateType: "rollback",
        },
        sentence: "Rolled back <subject> to `1.0.0`.",
      },
    ],
  },
  package: {
    crate: [
      { site: "none" },
      {
        site: ["beside", "nested", "node_modules", "target"],
        syntax: ["dotted", "inline", "table"],
        table: ["build-dependencies", "dependencies", "dev-dependencies", "target.'cfg(unix)'.dependencies"],
      },
    ],
    dependencyGroup: ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"],
    isPrivate: [false, true],
    placement: ["beside", "nested", "prefixed"],
  },
  upgrade: [
    {
      declaration: [
        { kind: "lockfile", manifestFileName: "package.json", sentence: "Updated the `<manager>` lockfile." },
        {
          depType: [
            "dependencies",
            "devDependencies",
            "engines",
            "optionalDependencies",
            "packageManager",
            "peerDependencies",
            "volta",
            "workspace.dependencies",
          ],
          kind: "none",
          manifestFileName: "package.json",
        },
        {
          kind: "override",
          spelling: [
            { depType: "overrides", packageFile: "package.json", usesSelector: false },
            { depType: "pnpm-workspace.overrides", packageFile: "pnpm-workspace.yaml", usesSelector: [false, true] },
            { depType: "pnpm.overrides", packageFile: "package.json", usesSelector: [false, true] },
            { depType: "resolutions", packageFile: "package.json", usesSelector: false },
          ],
        },
      ],
      manager: ["bun", "deno", "npm"],
    },
    {
      declaration: {
        catalog: [
          { name: "default", reference: ["catalog:", "catalog:default"] },
          { name: "react-19", reference: "catalog:react-19" },
        ],
        isAliased: [false, true],
        kind: "catalog",
        source: [
          { packageFile: "pnpm-workspace.yaml", spelling: "pnpm" },
          { packageFile: ".yarnrc.yml", spelling: "yarn" },
        ],
      },
      manager: "npm",
    },
    {
      declaration: [
        { kind: "lockfile", manifestFileName: "Cargo.toml", sentence: "Updated the `<manager>` lockfile." },
        {
          depType: ["build-dependencies", "dependencies", "dev-dependencies"],
          kind: "none",
          manifestFileName: "Cargo.toml",
        },
        { isRenamed: [false, true], kind: "workspace-dependency" },
      ],
      manager: "cargo",
    },
    [
      { declaration: { depType: null, kind: "none", manifestFileName: ".tool-versions" }, manager: "custom.regex" },
      {
        declaration: { depType: null, kind: "none", manifestFileName: "docker-compose.yaml" },
        manager: "docker-compose",
      },
      {
        declaration: { depType: ["final", "stage", "syntax"], kind: "none", manifestFileName: "Dockerfile" },
        manager: "dockerfile",
      },
      {
        declaration: {
          depType: ["action", "container", "docker", "github-runner", "service", "uses-with", "workflow"],
          kind: "none",
          manifestFileName: ".github/workflows/ci.yaml",
        },
        manager: "github-actions",
      },
      {
        declaration: {
          depType: ["golang", "indirect", "replace", "require", "tool", "toolchain"],
          kind: "none",
          manifestFileName: "go.mod",
        },
        manager: "gomod",
      },
      {
        declaration: [
          { kind: "lockfile", manifestFileName: "pyproject.toml", sentence: "Updated the `<manager>` lockfile." },
          {
            depType: [
              "build-system.requires",
              "dependency-groups",
              "project.dependencies",
              "project.optional-dependencies",
              "requires-python",
              "tool.pdm.dev-dependencies",
              "tool.uv.dev-dependencies",
              "tool.uv.sources",
            ],
            kind: "none",
            manifestFileName: "pyproject.toml",
          },
        ],
        manager: "pep621",
      },
    ],
  ],
  workspace: {
    hasStrayCrate: [false, true],
    kind: ["mono", "mono-with-root-as-member", "solo"],
    privatePackagesVersion: [false, true],
    template: ["custom", "default"],
    tool: ["bun", "npm", "pnpm", "yarn"],
  },
} as const;

type Attribute = Drawn<typeof matrix.attribute>;
type PackagePlan = Drawn<typeof matrix.package>;
type Shape = Drawn<typeof matrix.upgrade>;
type Declaration = Shape["declaration"];
type WorkspaceKind = Drawn<typeof matrix.workspace.kind>;
type Site = number | "root" | "stray";

type UpgradePlan = { attribute: Attribute; memberIndexList: number[]; shape: Shape; site: Site };

type Plan = {
  ignoredIndex: number;
  packageList: PackagePlan[];
  upgradeList: UpgradePlan[];
  versionlessIndex: number;
  workspace: Drawn<typeof matrix.workspace>;
};

type FixtureCrate = Exclude<PackagePlan["crate"], { site: "none" }> & { filePath: string; isPruned: boolean };

type FixturePackage = {
  crate: FixtureCrate | null;
  dependencyGroup: PackagePlan["dependencyGroup"];
  fileDirectoryPath: string;
  hasVersion: boolean;
  isIgnored: boolean;
  isPrivate: boolean;
  isVersioned: boolean;
  name: string;
};

type Fixture = { fileDirectory: string; packageList: FixturePackage[]; plan: Plan };

/** How many workspaces the property runs against. */
const WORKSPACE_COUNT = 120;

const buildNodeArbitrary = (node: unknown): fc.Arbitrary<unknown> => {
  if (Array.isArray(node)) {
    const optionList: readonly unknown[] = node;
    return fc.oneof(...optionList.map((option) => buildNodeArbitrary(option)));
  }

  if (typeof node === "object" && node !== null) {
    return fc.record(Object.fromEntries(Object.entries(node).map(([key, child]) => [key, buildNodeArbitrary(child)])));
  }

  return fc.constant(node);
};

const buildArbitrary = <Node>(node: Node): fc.Arbitrary<Drawn<Node>> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Drawn` is the type-level twin of `buildNodeArbitrary`.
  buildNodeArbitrary(node) as fc.Arbitrary<Drawn<Node>>;

const enumerateNode = (node: unknown): unknown[] => {
  if (Array.isArray(node)) {
    const optionList: readonly unknown[] = node;
    return optionList.flatMap((option) => enumerateNode(option));
  }

  if (typeof node === "object" && node !== null) {
    let recordList: Record<string, unknown>[] = [{}];

    for (const [key, child] of Object.entries(node)) {
      const valueList = enumerateNode(child);
      recordList = recordList.flatMap((record) => valueList.map((value) => ({ ...record, [key]: value })));
    }

    return recordList;
  }

  return [node];
};

const enumerate = <Node>(node: Node): Drawn<Node>[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Drawn` is the type-level twin of `enumerateNode`.
  enumerateNode(node) as Drawn<Node>[];

const planArbitrary: fc.Arbitrary<Plan> = buildArbitrary(matrix.workspace)
  .chain((workspace) =>
    fc
      .array(buildArbitrary(matrix.package), { maxLength: workspace.kind === "solo" ? 1 : 5, minLength: 1 })
      .map((packageList) => ({ packageList, workspace })),
  )
  .chain(({ packageList, workspace }) => {
    const indexList = packageList.map((_packagePlan, index) => index);

    return fc.record<Plan>({
      ignoredIndex: fc.integer({ max: packageList.length - 1, min: -1 }),
      packageList: fc.constant(packageList),
      upgradeList: fc.array(
        fc.record<UpgradePlan>({
          attribute: buildArbitrary(matrix.attribute),
          memberIndexList: fc.subarray(indexList),
          shape: buildArbitrary(matrix.upgrade),
          site: fc.constantFrom<Site>("root", "stray", ...indexList),
        }),
        { maxLength: 5, minLength: 1 },
      ),
      versionlessIndex: fc.integer({ max: packageList.length - 1, min: -1 }),
      workspace: fc.constant(workspace),
    });
  });

const resolvePackageFileDirectoryPath = ({
  index,
  isRoot,
  parentFileDirectoryPath,
  placement,
}: {
  index: number;
  isRoot: boolean;
  parentFileDirectoryPath: string;
  placement: PackagePlan["placement"];
}): string => {
  if (isRoot) {
    return "";
  }

  if (parentFileDirectoryPath === "" || placement === "beside") {
    return `packages/package-${index}`;
  }

  return placement === "nested" ? `${parentFileDirectoryPath}/nested-${index}` : `${parentFileDirectoryPath}-${index}`;
};

const describeCrate = ({
  crate,
  fileDirectoryPath,
  index,
}: {
  crate: PackagePlan["crate"];
  fileDirectoryPath: string;
  index: number;
}): FixtureCrate | null => {
  if (crate.site === "none") {
    return null;
  }

  const siteFileDirectoryPath = {
    beside: "",
    nested: `crates/crate-${index}`,
    node_modules: "node_modules/vendored",
    target: "target/debug",
  }[crate.site];

  return {
    ...crate,
    filePath: path.posix.join(fileDirectoryPath, siteFileDirectoryPath, "Cargo.toml"),
    isPruned: crate.site === "node_modules" || crate.site === "target",
  };
};

const describePackageList = ({ plan }: { plan: Plan }): FixturePackage[] => {
  const packageList: FixturePackage[] = [];

  for (const [index, packagePlan] of plan.packageList.entries()) {
    const isRoot = index === 0 && plan.workspace.kind !== "mono";

    const fileDirectoryPath = resolvePackageFileDirectoryPath({
      index,
      isRoot,
      parentFileDirectoryPath: packageList.at(-1)?.fileDirectoryPath ?? "",
      placement: packagePlan.placement,
    });

    const hasVersion = index !== plan.versionlessIndex;
    const isIgnored = index === plan.ignoredIndex;

    packageList.push({
      crate: describeCrate({ crate: packagePlan.crate, fileDirectoryPath, index }),
      dependencyGroup: packagePlan.dependencyGroup,
      fileDirectoryPath,
      hasVersion,
      isIgnored,
      isPrivate: packagePlan.isPrivate,
      isVersioned: !isIgnored && (plan.workspace.privatePackagesVersion || !packagePlan.isPrivate) && hasVersion,
      name: isRoot ? "@fixture/root" : `@fixture/package-${index}`,
    });
  }

  return packageList;
};

const resolveSiteFileDirectoryPath = ({ fixture, site }: { fixture: Fixture; site: Site }): string => {
  if (site === "root") {
    return "";
  }

  if (site === "stray") {
    return "packages/not-a-package";
  }

  const fixturePackage = fixture.packageList[site];

  if (fixturePackage === undefined) {
    throw new Error(`The plan has no package ${site}.`);
  }

  return fixturePackage.fileDirectoryPath;
};

const resolveDepName = ({
  declaration,
  index,
}: {
  declaration: Exclude<Declaration, { kind: "lockfile" }>;
  index: number;
}): string => {
  const packageName = `dependency-${index}`;

  if (declaration.kind === "catalog") {
    return declaration.isAliased ? `alias-${index}` : packageName;
  }

  if (declaration.kind === "override") {
    return declaration.spelling.usesSelector ? `${packageName}@>=1.0.0 <1.0.1` : packageName;
  }

  if (declaration.kind === "workspace-dependency") {
    return declaration.isRenamed ? `alias-${index}` : packageName;
  }

  return packageName;
};

const resolveDepType = ({
  declaration,
}: {
  declaration: Exclude<Declaration, { kind: "lockfile" }>;
}): string | null => {
  if (declaration.kind === "catalog") {
    return `${declaration.source.spelling}.catalog.${declaration.catalog.name}`;
  }

  if (declaration.kind === "override") {
    return declaration.spelling.depType;
  }

  return declaration.kind === "workspace-dependency" ? "workspace.dependencies" : declaration.depType;
};

const resolvePackageFile = ({ fixture, upgrade }: { fixture: Fixture; upgrade: UpgradePlan }): string => {
  const { declaration } = upgrade.shape;

  if (declaration.kind === "catalog") {
    return declaration.source.packageFile;
  }

  if (declaration.kind === "override") {
    return declaration.spelling.packageFile;
  }

  if (declaration.kind === "workspace-dependency") {
    return "Cargo.toml";
  }

  return path.posix.join(resolveSiteFileDirectoryPath({ fixture, site: upgrade.site }), declaration.manifestFileName);
};

const buildUpgrade = ({
  fixture,
  index,
  upgrade,
}: {
  fixture: Fixture;
  index: number;
  upgrade: UpgradePlan;
}): Upgrade => {
  const { attribute, shape } = upgrade;
  const packageFile = resolvePackageFile({ fixture, upgrade });

  if (shape.declaration.kind === "lockfile") {
    return {
      branchName: "renovate/all",
      displayTo: "",
      isLockFileMaintenance: true,
      manager: shape.manager,
      packageFile,
      updateType: "lockFileMaintenance",
    };
  }

  const packageName = `dependency-${index}`;

  return {
    ...attribute.security.payload,
    ...attribute.updateType.payload,
    ...(attribute.hasSourceUrl ? { sourceUrl: `https://example.com/${packageName}` } : {}),
    branchName: "renovate/all",
    depName: resolveDepName({ declaration: shape.declaration, index }),
    depType: resolveDepType({ declaration: shape.declaration }),
    manager: shape.manager,
    packageFile,
    packageName,
  };
};

const findExpectedOwner = ({
  fixture,
  manifestFilePath,
}: {
  fixture: Fixture;
  manifestFilePath: string;
}): string | null =>
  fixture.packageList
    .filter(
      (fixturePackage) =>
        fixturePackage.isVersioned &&
        (fixturePackage.fileDirectoryPath === "" ||
          manifestFilePath.startsWith(`${fixturePackage.fileDirectoryPath}/`)),
    )
    .toSorted((left, right) => right.fileDirectoryPath.length - left.fileDirectoryPath.length)
    .at(0)?.name ?? null;

const resolveExpectedPackageNameList = ({ fixture, upgrade }: { fixture: Fixture; upgrade: UpgradePlan }): string[] => {
  const { declaration } = upgrade.shape;

  const memberNameList = fixture.packageList
    .filter((fixturePackage, index) => fixturePackage.isVersioned && upgrade.memberIndexList.includes(index))
    .map((fixturePackage) => fixturePackage.name);

  if (declaration.kind === "catalog") {
    return memberNameList;
  }

  if (declaration.kind === "override") {
    const owner = findExpectedOwner({ fixture, manifestFilePath: declaration.spelling.packageFile });
    return owner === null ? memberNameList : [owner];
  }

  if (declaration.kind === "workspace-dependency") {
    return [
      ...fixture.packageList.flatMap((fixturePackage, index) =>
        fixturePackage.crate !== null && !fixturePackage.crate.isPruned && upgrade.memberIndexList.includes(index)
          ? [fixturePackage.crate.filePath]
          : [],
      ),
      ...(fixture.plan.workspace.hasStrayCrate ? ["packages/not-a-package/Cargo.toml"] : []),
    ]
      .map((crateFilePath) => findExpectedOwner({ fixture, manifestFilePath: crateFilePath }))
      .filter((owner) => owner !== null);
  }

  const owner = findExpectedOwner({ fixture, manifestFilePath: resolvePackageFile({ fixture, upgrade }) });
  return owner === null ? [] : [owner];
};

const customTemplate =
  '---\n"{{changesetPackageName}}": patch\n---\n\n{{#if isLockFileMaintenance}}{{manager}} lockfile{{else}}{{depName}} {{displayTo}}{{/if}} on {{branchName}}\n';

const buildExpectedBody = ({
  fixture,
  index,
  upgrade,
}: {
  fixture: Fixture;
  index: number;
  upgrade: UpgradePlan;
}): string => {
  const { attribute, shape } = upgrade;
  const { declaration } = shape;

  if (fixture.plan.workspace.template === "custom") {
    return declaration.kind === "lockfile"
      ? `${shape.manager} lockfile on renovate/all`
      : `${resolveDepName({ declaration, index })} ${attribute.updateType.payload.displayTo} on renovate/all`;
  }

  if (declaration.kind === "lockfile") {
    return declaration.sentence.replaceAll("<manager>", shape.manager);
  }

  const packageName = `dependency-${index}`;
  const subject = attribute.hasSourceUrl
    ? `[${packageName}](https://example.com/${packageName})`
    : `\`${packageName}\``;

  return `${attribute.updateType.sentence.replaceAll("<subject>", subject).replaceAll("<name>", packageName)}${attribute.security.tag}`;
};

const buildExpectedContentList = ({ fixture }: { fixture: Fixture }): string[] =>
  [
    ...new Set(
      fixture.plan.upgradeList.flatMap((upgrade, index) =>
        resolveExpectedPackageNameList({ fixture, upgrade }).map(
          (packageName) => `---\n"${packageName}": patch\n---\n\n${buildExpectedBody({ fixture, index, upgrade })}\n`,
        ),
      ),
    ),
  ].toSorted();

const buildOverrideEntryList = ({ depType, fixture }: { depType: string; fixture: Fixture }): [string, string][] =>
  fixture.plan.upgradeList.flatMap((upgrade, index): [string, string][] => {
    const { declaration } = upgrade.shape;

    return declaration.kind === "override" && declaration.spelling.depType === depType
      ? [[resolveDepName({ declaration, index }), "1.0.1"]]
      : [];
  });

const buildRootFieldMap = ({ fixture }: { fixture: Fixture }): Record<string, unknown> => {
  const overrideEntryList = buildOverrideEntryList({ depType: "overrides", fixture });
  const pnpmOverrideEntryList = buildOverrideEntryList({ depType: "pnpm.overrides", fixture });
  const resolutionEntryList = buildOverrideEntryList({ depType: "resolutions", fixture });
  const { kind, tool } = fixture.plan.workspace;

  return {
    ...(overrideEntryList.length > 0 ? { overrides: Object.fromEntries(overrideEntryList) } : {}),
    ...(pnpmOverrideEntryList.length > 0 ? { pnpm: { overrides: Object.fromEntries(pnpmOverrideEntryList) } } : {}),
    ...(resolutionEntryList.length > 0 ? { resolutions: Object.fromEntries(resolutionEntryList) } : {}),
    ...(tool === "pnpm" || kind === "solo"
      ? {}
      : {
          workspaces: fixture.packageList.map((fixturePackage) =>
            fixturePackage.fileDirectoryPath === "" ? "." : fixturePackage.fileDirectoryPath,
          ),
        }),
  };
};

const buildPackageJson = ({
  fixture,
  fixturePackage,
  packageIndex,
}: {
  fixture: Fixture;
  fixturePackage: FixturePackage;
  packageIndex: number;
}): Record<string, unknown> => {
  const dependencyGroupMap: Record<string, Record<string, string>> = {};

  for (const [index, upgrade] of fixture.plan.upgradeList.entries()) {
    const { declaration } = upgrade.shape;

    if (
      (declaration.kind !== "catalog" && declaration.kind !== "override") ||
      !upgrade.memberIndexList.includes(packageIndex)
    ) {
      continue;
    }

    const [key, value] =
      declaration.kind === "catalog"
        ? [resolveDepName({ declaration, index }), declaration.catalog.reference]
        : [`dependency-${index}`, "^1.0.0"];

    dependencyGroupMap[fixturePackage.dependencyGroup] = {
      ...dependencyGroupMap[fixturePackage.dependencyGroup],
      [key]: value,
    };
  }

  return {
    name: fixturePackage.name,
    ...(fixturePackage.hasVersion ? { version: "1.0.0" } : {}),
    ...(fixturePackage.isPrivate ? { private: true } : {}),
    ...dependencyGroupMap,
    ...(fixturePackage.fileDirectoryPath === "" ? buildRootFieldMap({ fixture }) : {}),
  };
};

const buildCatalogLineList = ({ fixture, spelling }: { fixture: Fixture; spelling: "pnpm" | "yarn" }): string[] => {
  const entryList = fixture.plan.upgradeList.flatMap((upgrade, index) => {
    const { declaration } = upgrade.shape;

    if (declaration.kind !== "catalog" || declaration.source.spelling !== spelling) {
      return [];
    }

    const value = declaration.isAliased ? `npm:dependency-${index}@^1.0.0` : "^1.0.0";

    return [{ catalogName: declaration.catalog.name, line: `${resolveDepName({ declaration, index })}: "${value}"` }];
  });

  const defaultLineList = entryList
    .filter((entry) => entry.catalogName === "default")
    .map((entry) => `  ${entry.line}`);
  const namedLineList = entryList
    .filter((entry) => entry.catalogName === "react-19")
    .map((entry) => `    ${entry.line}`);

  return [
    ...(defaultLineList.length > 0 ? ["catalog:", ...defaultLineList] : []),
    ...(namedLineList.length > 0 ? ["catalogs:", "  react-19:", ...namedLineList] : []),
  ];
};

const buildCrateManifest = ({
  crate,
  crateName,
  fixture,
  packageIndex,
}: {
  crate: Pick<FixtureCrate, "syntax" | "table">;
  crateName: string;
  fixture: Fixture;
  packageIndex: number | null;
}): string => {
  const entryList = fixture.plan.upgradeList.flatMap((upgrade, index) => {
    const { declaration } = upgrade.shape;

    return declaration.kind === "workspace-dependency"
      ? [
          {
            inherits: packageIndex === null || upgrade.memberIndexList.includes(packageIndex),
            key: resolveDepName({ declaration, index }),
          },
        ]
      : [];
  });

  const lineList = entryList.flatMap(({ inherits, key }) => {
    if (!inherits) {
      return [`${key} = "1.0.0"`];
    }

    if (crate.syntax === "dotted") {
      return [`${key}.workspace = true`];
    }

    return crate.syntax === "inline" ? [`${key} = { workspace = true }`] : [];
  });

  const subTableLineList =
    crate.syntax === "table"
      ? entryList
          .filter((entry) => entry.inherits)
          .flatMap(({ key }) => ["", `[${crate.table}.${key}]`, "workspace = true"])
      : [];

  return [
    "[package]",
    `name = "${crateName}"`,
    'version = "0.1.0"',
    "",
    `[${crate.table}]`,
    ...lineList,
    ...subTableLineList,
    "",
  ].join("\n");
};

const buildRootCargoManifest = ({ fixture }: { fixture: Fixture }): string | null => {
  const { packageList, plan } = fixture;

  const rootCrate =
    packageList.map((fixturePackage) => fixturePackage.crate).find((crate) => crate?.filePath === "Cargo.toml") ?? null;

  const workspaceDependencyLineList = plan.upgradeList.flatMap((upgrade, index) => {
    const { declaration } = upgrade.shape;

    if (declaration.kind !== "workspace-dependency") {
      return [];
    }

    return declaration.isRenamed
      ? [`alias-${index} = { package = "dependency-${index}", version = "1.0.0" }`]
      : [`dependency-${index} = "1.0.0"`];
  });

  const memberList = [
    ...packageList.flatMap((fixturePackage) =>
      fixturePackage.crate === null || fixturePackage.crate.isPruned || fixturePackage.crate.filePath === "Cargo.toml"
        ? []
        : [path.posix.dirname(fixturePackage.crate.filePath)],
    ),
    ...(plan.workspace.hasStrayCrate ? ["packages/not-a-package"] : []),
  ];

  if (rootCrate === null && memberList.length === 0 && workspaceDependencyLineList.length === 0) {
    return null;
  }

  return [
    ...(rootCrate === null
      ? []
      : [buildCrateManifest({ crate: rootCrate, crateName: "crate-0", fixture, packageIndex: 0 })]),
    "[workspace]",
    `members = ${JSON.stringify(memberList)}`,
    ...(workspaceDependencyLineList.length > 0 ? ["", "[workspace.dependencies]", ...workspaceDependencyLineList] : []),
    "",
  ].join("\n");
};

const buildFileMap = ({ fixture }: { fixture: Fixture }): Record<string, string> => {
  const { packageList, plan } = fixture;
  const { hasStrayCrate, kind, privatePackagesVersion, template, tool } = plan.workspace;
  const isWorkspace = kind !== "solo";

  const fileMap: Record<string, string> = {
    ".changeset/config.json": buildChangesetConfig({
      ignore: packageList
        .filter((fixturePackage) => fixturePackage.isIgnored)
        .map((fixturePackage) => fixturePackage.name),
      privatePackages: { tag: false, version: privatePackagesVersion },
    }),
  };

  if (template === "custom") {
    fileMap[".github/changeset.md"] = customTemplate;
  }

  for (const [packageIndex, fixturePackage] of packageList.entries()) {
    fileMap[path.posix.join(fixturePackage.fileDirectoryPath, "package.json")] = serializePackageJson({
      value: buildPackageJson({ fixture, fixturePackage, packageIndex }),
    });

    if (fixturePackage.crate !== null && fixturePackage.crate.filePath !== "Cargo.toml") {
      fileMap[fixturePackage.crate.filePath] = buildCrateManifest({
        crate: fixturePackage.crate,
        crateName: `crate-${packageIndex}`,
        fixture,
        packageIndex,
      });
    }
  }

  if (kind === "mono") {
    fileMap["package.json"] = serializePackageJson({
      value: { name: "@fixture/root", private: true, version: "0.0.0", ...buildRootFieldMap({ fixture }) },
    });
  }

  if (isWorkspace && tool === "bun") {
    fileMap["bun.lock"] = "\n";
  }

  if (isWorkspace && tool === "npm") {
    fileMap["package-lock.json"] = "{}\n";
  }

  if (isWorkspace && tool === "yarn") {
    fileMap["yarn.lock"] = "\n";
  }

  const workspaceOverrideEntryList = buildOverrideEntryList({ depType: "pnpm-workspace.overrides", fixture });

  const pnpmWorkspaceLineList = [
    ...(isWorkspace && tool === "pnpm"
      ? [
          "packages:",
          ...packageList.map(
            (fixturePackage) =>
              `  - ${fixturePackage.fileDirectoryPath === "" ? "." : fixturePackage.fileDirectoryPath}`,
          ),
        ]
      : []),
    ...buildCatalogLineList({ fixture, spelling: "pnpm" }),
    ...(workspaceOverrideEntryList.length > 0
      ? ["overrides:", ...workspaceOverrideEntryList.map(([key, value]) => `  "${key}": "${value}"`)]
      : []),
  ];

  if (pnpmWorkspaceLineList.length > 0) {
    fileMap["pnpm-workspace.yaml"] = `${pnpmWorkspaceLineList.join("\n")}\n`;
  }

  const yarnrcLineList = buildCatalogLineList({ fixture, spelling: "yarn" });

  if (yarnrcLineList.length > 0) {
    fileMap[".yarnrc.yml"] = `${yarnrcLineList.join("\n")}\n`;
  }

  const rootCargoManifest = buildRootCargoManifest({ fixture });

  if (rootCargoManifest !== null) {
    fileMap["Cargo.toml"] = rootCargoManifest;
  }

  if (hasStrayCrate) {
    fileMap["packages/not-a-package/Cargo.toml"] = buildCrateManifest({
      crate: { syntax: "dotted", table: "dependencies" },
      crateName: "crate-stray",
      fixture,
      packageIndex: null,
    });
  }

  return fileMap;
};

const assertPlan = async ({ plan }: { plan: Plan }): Promise<void> => {
  const fileDirectory = await mkdtemp(path.join(tmpdir(), "renovate-changesets-"));
  const fixture: Fixture = { fileDirectory, packageList: describePackageList({ plan }), plan };

  try {
    await writeFileMap({ fileDirectory, fileMap: buildFileMap({ fixture }) });

    const options = {
      cwd: fileDirectory,
      templateFilePath: plan.workspace.template === "custom" ? ".github/changeset.md" : undefined,
      upgradeListString: encodeJson(
        plan.upgradeList.map((upgrade, index) => buildUpgrade({ fixture, index, upgrade })),
      ),
    };

    await run(options);

    const firstChangesetList = await readChangesets({ fileDirectory });

    await run(options);

    const changesetList = await readChangesets({ fileDirectory });

    for (const { content, fileName } of changesetList) {
      expect(fileName).toBe(`renovate-${createHash("sha256").update(content).digest("hex").slice(0, 8)}.md`);
    }

    expect(changesetList.map((changeset) => changeset.content).toSorted()).toStrictEqual(
      buildExpectedContentList({ fixture }),
    );
    expect(changesetList).toStrictEqual(firstChangesetList);
  } finally {
    await removeWorkspace({ fileDirectory });
  }
};

const findLeaf = <Leaf>({ leafList, matches }: { leafList: Leaf[]; matches: (leaf: Leaf) => boolean }): Leaf => {
  const leaf = leafList.find((candidate) => matches(candidate));

  if (leaf === undefined) {
    throw new Error("The matrix has no such leaf.");
  }

  return leaf;
};

const attributeLeafList = enumerate(matrix.attribute);
const crateLeafList = enumerate(matrix.package.crate);
const shapeLeafList = enumerate(matrix.upgrade);

const canonicalAttribute = findLeaf({
  leafList: attributeLeafList,
  matches: (attribute) =>
    !attribute.hasSourceUrl &&
    attribute.security.security === "none" &&
    attribute.updateType.payload.updateType === "minor",
});

const canonicalCrate = findLeaf({
  leafList: crateLeafList,
  matches: (crate) => crate.site === "beside" && crate.syntax === "dotted" && crate.table === "dependencies",
});

const canonicalWorkspaceDependencyShape = findLeaf({
  leafList: shapeLeafList,
  matches: (shape) => shape.declaration.kind === "workspace-dependency" && !shape.declaration.isRenamed,
});

const canonicalShape = findLeaf({
  leafList: shapeLeafList,
  matches: (shape) =>
    shape.manager === "npm" && shape.declaration.kind === "none" && shape.declaration.depType === "dependencies",
});

const buildLeafPlan = ({
  attribute,
  crate,
  kind,
  shape,
}: {
  attribute: Attribute;
  crate: PackagePlan["crate"];
  kind: WorkspaceKind;
  shape: Shape;
}): Plan => {
  const memberIndex = kind === "solo" ? 0 : 1;

  return {
    ignoredIndex: -1,
    packageList: [
      { crate, dependencyGroup: "dependencies", isPrivate: false, placement: "beside" },
      ...(kind === "solo"
        ? []
        : [{ crate, dependencyGroup: "dependencies" as const, isPrivate: false, placement: "nested" as const }]),
    ],
    upgradeList: [{ attribute, memberIndexList: [memberIndex], shape, site: memberIndex }],
    versionlessIndex: -1,
    workspace: { hasStrayCrate: false, kind, privatePackagesVersion: true, template: "default", tool: "pnpm" },
  };
};

const shapeCaseList = matrix.workspace.kind.flatMap((kind) =>
  shapeLeafList.map((shape) => ({ kind, shape, title: `Resolves ${JSON.stringify(shape)} in a ${kind} workspace` })),
);

const attributeCaseList = attributeLeafList.map((attribute) => ({
  attribute,
  title: `Renders ${JSON.stringify(attribute)}`,
}));

const crateCaseList = matrix.workspace.kind.flatMap((kind) =>
  crateLeafList.map((crate) => ({ crate, kind, title: `Walks to ${JSON.stringify(crate)} in a ${kind} workspace` })),
);

describe("Matrix", () => {
  it.each(shapeCaseList)("$title", async ({ kind, shape }) => {
    expect.hasAssertions();

    await assertPlan({ plan: buildLeafPlan({ attribute: canonicalAttribute, crate: canonicalCrate, kind, shape }) });
  });

  it.each(attributeCaseList)("$title", async ({ attribute }) => {
    expect.hasAssertions();

    await assertPlan({
      plan: buildLeafPlan({ attribute, crate: canonicalCrate, kind: "mono", shape: canonicalShape }),
    });
  });

  it.each(crateCaseList)("$title", async ({ crate, kind }) => {
    expect.hasAssertions();

    await assertPlan({
      plan: buildLeafPlan({ attribute: canonicalAttribute, crate, kind, shape: canonicalWorkspaceDependencyShape }),
    });
  });

  propertyTest.prop([planArbitrary], { numRuns: WORKSPACE_COUNT })(
    "Writes exactly the changesets a workspace implies",
    async (plan) => {
      await assertPlan({ plan });
    },
    30_000,
  );
});
