import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: {
    server: path.join(root, "src/index.ts"),
    operator: path.join(root, "src/operator.ts"),
    recover: path.join(root, "src/recover.ts"),
  },
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
});
console.log(
  "Billing server/operator bundles ready in apps/billing/dist. No environment secrets were embedded.",
);
