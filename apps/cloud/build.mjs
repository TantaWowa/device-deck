import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(directory, "src/index.ts")],
  outfile: path.join(directory, "dist/server.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node24",
  format: "esm",
});
console.log("Cloud API built in apps/cloud/dist/server.mjs. Runtime credentials are not included.");
