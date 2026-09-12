import { build as bundle } from "esbuild";
import { build as vite } from "vite";
import { mkdir, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("build/native", { recursive: true });
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
  },
  outdir: "build",
  bundle: true,
  legalComments: "eof",
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  sourcemap: false,
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
