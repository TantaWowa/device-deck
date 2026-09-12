import { build } from "esbuild";
import { copyFile, mkdir, chmod } from "node:fs/promises";
await mkdir("packages/installer/dist", { recursive: true });
await build({
  entryPoints: ["packages/installer/src/cli.ts"],
  outfile: "packages/installer/dist/cli.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
});
await chmod("packages/installer/dist/cli.mjs", 0o755);
await copyFile("COPYRIGHT", "packages/installer/COPYRIGHT");
await copyFile(
  "work/package/device-deck/THIRD_PARTY_NOTICES.txt",
  "packages/installer/THIRD_PARTY_NOTICES.txt",
);
