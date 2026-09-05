import path from "node:path";

import type { Package } from "@manypkg/get-packages";

export const resolvePackageByFilePath = ({
  cwd,
  filePath,
  packageList,
}: {
  cwd: string;
  filePath: string;
  packageList: Package[];
}): Package | null => {
  const resolvedFilePath = path.resolve(cwd, filePath);

  return (
    packageList
      .filter((_package) => !path.relative(path.resolve(_package.dir), resolvedFilePath).startsWith(".."))
      .toSorted((left, right) => right.dir.length - left.dir.length)
      .at(0) ?? null
  );
};
