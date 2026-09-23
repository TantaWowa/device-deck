import { build as bundle } from "esbuild";
import { build as vite } from "vite";
import { mkdir, rename, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { prepareScrcpy } from "./prepare-scrcpy.mjs";
const { values } = parseArgs({ options: { mode: { type: "string", default: "live" } } });
const mode = values.mode;
if (!["live", "test"].includes(mode)) throw new Error("Use --mode live or --mode test.");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const trust = JSON.parse(await readFile("config/releases/keygen.json", "utf8"))[mode];
if (!trust?.productId || trust.mode !== mode || !/^[a-f0-9]{64}$/.test(trust.publicKey)) throw new Error("Release trust configuration is incomplete.");
// Remove stale success metadata before starting any part of the build.
await rm("build/build-metadata.json", { force: true });
await mkdir("build/native", { recursive: true });
await prepareScrcpy();
execFileSync(
  "swiftc",
  [
    "-module-cache-path",
    "build/swift-cache",
    "-O",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    "native/Info.plist",
    "native/camera.swift",
    "-o",
    "build/native/deck-camera",
  ],
  { stdio: "inherit" },
);
await bundle({
  entryPoints: {
    daemon: "apps/daemon/src/index.ts",
    devdeck: "apps/cli/src/index.ts",
    tui: "apps/tui/src/index.ts",
    mcp: "packages/mcp/src/index.ts",
    client: "packages/core/src/client-public.ts",
  },
  outdir: "build",
  bundle: true,
  legalComments: "eof",
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  sourcemap: false,
  define: { __DEVICE_DECK_RELEASE_MODE__: JSON.stringify(mode), __DEVICE_DECK_VERSION__: JSON.stringify(version) },
  outExtension: { ".js": ".mjs" },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
await vite({
  root: "apps/web",
  build: {
    outDir: "../../build/web",
    emptyOutDir: true,
    rollupOptions: { input: "apps/web/local.html" },
  },
});
await rename("build/web/local.html", "build/web/index.html");
for (const name of ["daemon", "devdeck", "tui", "mcp", "client"]) {
  const output = await readFile(`build/${name}.mjs`, "utf8");
  if (/LocalLicenseManager|local-license\.ts|DEVICE_DECK_MOCK_PRO|KEYGEN_ADMIN_TOKEN/.test(output)) throw new Error(`Development or operator code leaked into ${name}.`);
}
await writeFile("build/build-metadata.json", JSON.stringify({
  schema: 1, version, mode, arch: process.arch, builtAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  licenseProductId: trust.productId,
}, null, 2) + "\n");
