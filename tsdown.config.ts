import { defineConfig } from "tsdown";

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  dts: true,
  entry: ["src/cli.ts", "src/index.ts"],
  format: "esm",
  outDir: "dist",
  outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
  platform: "node",
  sourcemap: true,
  target: "node22",
  unbundle: true,
});
