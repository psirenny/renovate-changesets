import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Package } from "@manypkg/get-packages";
import { describe, expect, it, onTestFinished } from "vitest";

import { resolveCargoPackagesByWorkspaceDependency } from "./cargo.js";

// Unreviewed
/** Writes a minimal single-package or multi-package workspace with exactly the shape a test asks for. */
const createWorkspace = async ({ fileMap }: { fileMap: Record<string, string> }): Promise<string> => {
  const fileDirectory = await mkdtemp(path.join(tmpdir(), "renovate-changesets-"));

  onTestFinished(async () => {
    await rm(fileDirectory, { force: true, recursive: true });
  });

  await Promise.all(
    Object.entries(fileMap).map(async ([relativeFilePath, content]) => {
      const filePath = path.join(fileDirectory, relativeFilePath);

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }),
  );

  return fileDirectory;
};

// Unreviewed
const buildCargoWorkspacePackage = ({ fileDirectory, name }: { fileDirectory: string; name: string }): Package => ({
  dir: path.join(fileDirectory, "packages", name),
  packageJson: { name, version: "1.0.0" },
  relativeDir: `packages/${name}`,
});

describe(resolveCargoPackagesByWorkspaceDependency, () => {
  it("Ignores a target table whose entry isn't a table at all", async () => {
    expect.hasAssertions();

    const fileDirectory = await createWorkspace({
      fileMap: {
        "packages/heir/Cargo.toml":
          "[package]\nname = \"heir\"\n\n[target.'cfg(unix)'.dependencies]\nserde.workspace = true\n",
        // `[target]` holding a scalar is not a per-platform table, so there is nothing to read a dependency from.
        "packages/scalar/Cargo.toml": '[package]\nname = "scalar"\n\n[target]\nnot-a-table = "x"\n',
      },
    });
    const cargoPackageList = ["scalar", "heir"].map((name) => buildCargoWorkspacePackage({ fileDirectory, name }));

    await expect(
      resolveCargoPackagesByWorkspaceDependency({
        packageList: cargoPackageList,
        upgrade: { depName: "serde", depType: "workspace.dependencies", manager: "cargo", packageFile: "Cargo.toml" },
      }),
    ).resolves.toStrictEqual(["heir"]);
  });

  it("Reports which Cargo manifest failed to parse", async () => {
    expect.hasAssertions();

    const fileDirectory = await createWorkspace({
      fileMap: { "packages/broken/Cargo.toml": "[dependencies\nserde = " },
    });
    const packageList = [buildCargoWorkspacePackage({ fileDirectory, name: "broken" })];

    await expect(
      resolveCargoPackagesByWorkspaceDependency({
        packageList,
        upgrade: { depName: "serde", depType: "workspace.dependencies", manager: "cargo", packageFile: "Cargo.toml" },
      }),
    ).rejects.toThrow(/Couldn't parse .*Cargo\.toml/u);
  });
});
