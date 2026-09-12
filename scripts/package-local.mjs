import {
  mkdir,
  cp,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const destination = path.resolve("work/package/device-deck");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await mkdir(path.join(destination, "build"), { recursive: true });
for (const name of [
  "daemon.mjs",
  "devdeck.mjs",
  "tui.mjs",
  "mcp.mjs",
  "native",
  "web",
])
  await cp(path.join("build", name), path.join(destination, "build", name), {
    recursive: true,
  });
await cp("native", path.join(destination, "native"), { recursive: true });
await cp("docs", path.join(destination, "docs"), { recursive: true });
await cp("examples", path.join(destination, "examples"), { recursive: true });
await cp("README.md", path.join(destination, "README.md"));
await cp("COPYRIGHT", path.join(destination, "COPYRIGHT"));
await writeFile(
  path.join(destination, "devdeck"),
  `#!/bin/sh\nset -eu\nDEVICE_DECK_APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$DEVICE_DECK_APP_DIR/build/devdeck.mjs" "$@"\n`,
);
await chmod(path.join(destination, "devdeck"), 0o755);
const notices = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const folder = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      await scan(folder);
      continue;
    }
    try {
      const pkg = JSON.parse(
        await readFile(path.join(folder, "package.json"), "utf8"),
      );
      const files = await readdir(folder);
      const license = files.find((n) => /^licen[sc]e(?:\.md|\.txt)?$/i.test(n));
      if (license)
        notices.push(
          `${pkg.name} ${pkg.version}\n${await readFile(path.join(folder, license), "utf8")}`,
        );
    } catch {}
  }
}
await scan("node_modules");
await writeFile(
  path.join(destination, "THIRD_PARTY_NOTICES.txt"),
  notices.join("\n\n--------------------------------------------------\n\n"),
);
const out = path.resolve("../../outputs");
await mkdir(out, { recursive: true });
const archive = path.join(
  out,
  `device-deck-0.2.0-macos-${process.arch}.tar.gz`,
);
execFileSync("/usr/bin/tar", [
  "-czf",
  archive,
  "-C",
  path.dirname(destination),
  path.basename(destination),
]);
console.log(archive);
