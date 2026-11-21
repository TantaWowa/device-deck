import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { appInfo, applicationBuildPayload, bundleId, captureSetup, digest, minimumOS, numericVersion,
  postinstall, preinstall, validateMediaBundle, verifyMachOClosure } from "./package-support.mjs";

export function requireExpectedCheckout(root, expectedCommit) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || "")) throw new Error("Import requires --expected-commit with the full merged source SHA.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== expectedCommit) throw new Error("The checkout HEAD differs from the expected source commit.");
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Import signing requires a clean checkout at the expected commit.");
}

export function validateImportMetadata(metadata, { version, expectedCommit, expectedArch, runtime }) {
  const arch = metadata?.arch;
  if (!["arm64", "x64"].includes(arch) || (expectedArch && arch !== expectedArch)) throw new Error("Imported architecture does not match the requested Mac architecture.");
  const filename = `device-deck-${version}-macos-${arch}.pkg`;
  for (const [key, value] of Object.entries({ schemaVersion: 1, application: bundleId, version, arch,
    mode: "free", media: "bundled", signing: "ad-hoc", minimumOS, channel: version.includes("-") ? "beta" : "stable", file: filename })) {
    if (metadata[key] !== value) throw new Error(`Imported package ${key} must be ${value}.`);
  }
  for (const [key, value] of Object.entries({ schema: 1, version, arch, mode: "free", commit: expectedCommit }))
    if (metadata.build?.[key] !== value) throw new Error(`Imported build ${key} differs from the expected source.`);
  if (!Number.isFinite(Date.parse(metadata.build.builtAt))) throw new Error("Imported build timestamp is invalid.");
  if (!isDeepStrictEqual(metadata.runtime, { name: "node", version: runtime.version, sha256: runtime.darwin[arch] })) throw new Error("Imported Node runtime differs from the repository pin.");
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(metadata.sha256 || "")) throw new Error("Imported package size or checksum is invalid.");
  return arch;
}

async function regular(file, maximum = Infinity) {
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.mode & 0o6022 || info.size > maximum) throw new Error(`Import requires a regular, non-writable file without links: ${file}`);
  return info;
}

export async function inspectUnsignedPackage(file, expected) {
  file = path.resolve(file);
  const metadataFile = file.replace(/\.pkg$/, ".json");
  if (!file.endsWith(".pkg")) throw new Error("Import requires a .pkg installer.");
  await regular(metadataFile, 65536);
  await regular(`${file}.sha256`, 1024);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  const arch = validateImportMetadata(metadata, expected);
  if (path.basename(file) !== metadata.file) throw new Error("Imported installer filename differs from its metadata.");
  if ((await regular(file, 2 * 1024 ** 3)).size !== metadata.bytes) throw new Error("Imported installer size differs from its metadata.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== metadata.sha256 || (await readFile(`${file}.sha256`, "utf8")).trim() !== `${metadata.sha256}  ${metadata.file}`) throw new Error("Imported installer checksum verification failed.");
  return { file, metadata, arch };
}

export async function inspectRegularTree(directory) {
  const files = [];
  const info = await lstat(directory);
  if (!info.isDirectory() || info.mode & 0o6022) throw new Error(`Unsafe imported directory: ${directory}`);
  for (const entry of await readdir(directory)) {
    const file = path.join(directory, entry), child = await lstat(file);
    if (child.isDirectory()) files.push(...await inspectRegularTree(file));
    else { await regular(file); files.push(file); }
  }
  return files;
}

async function entries(directory, names) {
  if (!isDeepStrictEqual((await readdir(directory)).sort(), [...names].sort())) throw new Error(`Unexpected imported payload layout: ${directory}`);
}
async function equalFile(file, bytes) {
  if (!(await readFile(file)).equals(Buffer.from(bytes))) throw new Error(`Imported source-controlled file differs from this checkout: ${file}`);
}
function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Import validation failed: ${path.basename(file)}\n${result.error?.message || result.stderr}`);
  return result.stdout + result.stderr;
}

/** Inspect data and signatures before running any executable supplied by the artifact. */
export async function validateExpandedPackage(expanded, imported, root) {
  const { metadata, arch } = imported, version = metadata.version;
  await inspectRegularTree(expanded);
  await entries(expanded, ["Distribution", "component.pkg"]);
  const component = path.join(expanded, "component.pkg"), payload = path.join(component, "Payload");
  await entries(component, ["Bom", "PackageInfo", "Payload", "Scripts"]);
  await entries(path.join(component, "Scripts"), ["preinstall", "postinstall"]);
  await equalFile(path.join(component, "Scripts/preinstall"), preinstall);
  await equalFile(path.join(component, "Scripts/postinstall"), postinstall);
  for (const file of [path.join(component, "PackageInfo"), path.join(expanded, "Distribution")]) {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(await readFile(file, "utf8"))) throw new Error("Imported installer XML cannot declare entities or an external document type.");
  }
  const xmlValue = (file, xpath) => command("/usr/bin/xmllint", ["--nonet", "--xpath", xpath, file]).trim();
  for (const [file, xpath, value] of [
    ["PackageInfo", "string(/pkg-info/@identifier)", bundleId],
    ["PackageInfo", "string(/pkg-info/@version)", numericVersion(version)],
    ["PackageInfo", "string(/pkg-info/@install-location)", "/"],
    ["PackageInfo", "string(/pkg-info/bundle/@id)", bundleId],
    ["PackageInfo", "string(/pkg-info/bundle/@path)", "./Applications/Device Deck.app"],
  ]) if (xmlValue(path.join(component, file), xpath) !== value) throw new Error(`Imported package identity differs: ${xpath}`);
  if (xmlValue(path.join(expanded, "Distribution"), "string(/installer-gui-script/options/@hostArchitectures)") !== (arch === "x64" ? "x86_64" : arch)) throw new Error("Imported installer architecture differs from its metadata.");
  await entries(payload, ["Applications"]);
  await entries(path.join(payload, "Applications"), ["Device Deck.app"]);
  const app = path.join(payload, "Applications/Device Deck.app"), contents = path.join(app, "Contents"), resources = path.join(contents, "Resources");
  await entries(app, ["Contents"]);
  await entries(contents, ["Info.plist", "PkgInfo", "MacOS", "Resources", "_CodeSignature"]);
  await entries(path.join(contents, "MacOS"), ["Device Deck", "devdeck", "device-deck-service"]);
  await entries(resources, ["Capture Setup.html", "LICENSE", "THIRD_PARTY_NOTICES.txt", "build", "distribution.json", "media", "native", "runtime", "scripts"]);
  await entries(path.join(resources, "scripts"), ["install-simulator-memory-profile.py"]);
  await equalFile(path.join(resources, "scripts/install-simulator-memory-profile.py"), await readFile(path.join(root, "scripts/install-simulator-memory-profile.py")));
  await entries(path.join(resources, "build"), applicationBuildPayload);
  await entries(path.join(resources, "native"), ["apple-tv.py"]);
  await entries(path.join(resources, "runtime"), ["bin", "LICENSE"]);
  await entries(path.join(resources, "runtime/bin"), ["node"]);
  await equalFile(path.join(contents, "Info.plist"), appInfo(version));
  await equalFile(path.join(contents, "PkgInfo"), "APPL????");
  await equalFile(path.join(resources, "LICENSE"), await readFile(path.join(root, "LICENSE")));
  await equalFile(path.join(resources, "native/apple-tv.py"), await readFile(path.join(root, "native/apple-tv.py")));
  await equalFile(path.join(resources, "Capture Setup.html"), captureSetup("bundled"));
  const { file: _file, bytes: _bytes, sha256: _sha256, ...distribution } = metadata;
  if (!isDeepStrictEqual(JSON.parse(await readFile(path.join(resources, "distribution.json"), "utf8")), distribution) ||
      !isDeepStrictEqual(JSON.parse(await readFile(path.join(resources, "build/build-metadata.json"), "utf8")), metadata.build)) throw new Error("Imported embedded metadata differs from its verified sidecar.");
  const scrcpy = JSON.parse(await readFile(path.join(root, "scripts/distribution/scrcpy.json"), "utf8"));
  await entries(path.join(resources, "build/native"), ["deck-camera", "deck-camera-native", "scrcpy-LICENSE", `scrcpy-server-v${scrcpy.version}`]);
  if (digest(await readFile(path.join(resources, "build/native", `scrcpy-server-v${scrcpy.version}`))) !== scrcpy.sha256) throw new Error("Imported scrcpy server differs from the pinned release.");
  await equalFile(path.join(resources, "build/native/scrcpy-LICENSE"), await readFile(path.join(root, "native/scrcpy-LICENSE")));
  const media = path.join(resources, "media"), lock = JSON.parse(await readFile(path.join(root, "scripts/distribution/media-sources.json"), "utf8"));
  await entries(media, ["bin", "licenses", "sources", "recipe", "README.txt", "media-manifest.json"]);
  await entries(path.join(media, "bin"), ["ffmpeg", "ffprobe"]);
  await entries(path.join(media, "sources"), lock.components.map(c => path.basename(new URL(c.url).pathname)));
  await entries(path.join(media, "licenses"), lock.components.map(c => `${c.name}.txt`));
  await entries(path.join(media, "recipe"), ["build-media.mjs", "package-support.mjs", "media-sources.json", "build.json"]);
  for (const component of lock.components) if (digest(await readFile(path.join(media, "sources", path.basename(new URL(component.url).pathname)))) !== component.sha256) throw new Error(`Imported ${component.name} sources differ from the repository pin.`);
  for (const file of ["build-media.mjs", "package-support.mjs", "media-sources.json"]) await equalFile(path.join(media, "recipe", file), await readFile(path.join(root, "scripts/distribution", file)));
  const allFiles = await inspectRegularTree(app), binaries = await verifyMachOClosure(allFiles, arch);
  const expectedBinaries = ["MacOS/Device Deck", "MacOS/devdeck", "MacOS/device-deck-service", "Resources/runtime/bin/node", "Resources/build/native/deck-camera", "Resources/build/native/deck-camera-native", "Resources/media/bin/ffmpeg", "Resources/media/bin/ffprobe"];
  if (!isDeepStrictEqual(binaries.map(file => path.relative(contents, file)).sort(), expectedBinaries.sort())) throw new Error("Unexpected executable code in imported package.");
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  for (const binary of binaries) {
    if (((await lstat(binary)).mode & 0o111) !== 0o111) throw new Error(`Imported executable permissions are invalid: ${binary}`);
    command("/usr/bin/codesign", ["--verify", "--strict", binary]);
    if (!/^Signature=adhoc$/m.test(command("/usr/bin/codesign", ["--display", "--verbose=4", binary]))) throw new Error("Import expects ad-hoc signed CI binaries, not another distribution identity.");
  }
  await validateMediaBundle(media, arch);
  return app;
}
