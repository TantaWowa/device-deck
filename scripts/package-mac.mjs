import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  appInfo, applicationBuildPayload, bundleId, captureSetup, digest, minimumOS, numericVersion,
  postinstall, preinstall, requireReleaseSettings, validateMediaBundle,
  verifyMachOClosure, walk, xml,
} from "./distribution/package-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const { values } = parseArgs({ options: {
  mode: { type: "string" },
  arch: { type: "string", default: process.arch },
  release: { type: "boolean", default: false },
  "skip-build": { type: "boolean", default: false },
  "media-bundle": { type: "string" },
  output: { type: "string", default: "work/distribution" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log(`Build a Device Deck macOS installer (macOS 14+).
  node scripts/package-mac.mjs [--mode live|test] [--arch arm64|x64]
       [--media-bundle DIR] [--skip-build] [--output DIR] [--release]

Default: test licensing, ad-hoc-signed app, unsigned team installer, external FFmpeg.
--release requires Developer ID identities and notarization credentials:
  DEVICE_DECK_APPLICATION_IDENTITY='Developer ID Application: ... (TEAMID)'
  DEVICE_DECK_INSTALLER_IDENTITY='Developer ID Installer: ... (TEAMID)'
  DEVICE_DECK_NOTARY_PROFILE='device-deck'
No account tokens or private signing keys are written into the application.
`);
  process.exit(0);
}
const mode = values.mode || (values.release ? "live" : "test"), arch = values.arch, release = values.release;
if (process.platform !== "darwin") throw new Error("Build the Mac package on macOS.");
if (!["live", "test"].includes(mode)) throw new Error("Use --mode live or --mode test.");
if (!["arm64", "x64"].includes(arch) || arch !== process.arch) throw new Error("Build and validate each package on a Mac of the target architecture.");
const applicationIdentity = process.env.DEVICE_DECK_APPLICATION_IDENTITY;
const installerIdentity = process.env.DEVICE_DECK_INSTALLER_IDENTITY;
const notaryProfile = process.env.DEVICE_DECK_NOTARY_PROFILE;
requireReleaseSettings({ release, mode, applicationIdentity, installerIdentity, notaryProfile });
const exec = (file, args, options = {}) => execFileSync(file, args, { stdio: "inherit", ...options });
if (release) {
  const identities = execFileSync("/usr/bin/security", ["find-identity", "-v"], { encoding: "utf8" });
  for (const identity of [applicationIdentity, installerIdentity]) if (!identities.includes(`"${identity}"`))
    throw new Error(`Signing identity is not available with a valid private key: ${identity}`);
}
if (!values["skip-build"]) exec(process.execPath, ["scripts/build-local.mjs", "--mode", mode]);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const packageVersion = numericVersion(pkg.version);
const build = JSON.parse(await readFile("build/build-metadata.json", "utf8"));
if (build.version !== pkg.version || build.mode !== mode || build.arch !== arch)
  throw new Error("Build metadata does not match package version, licensing mode and architecture. Rebuild before packaging.");
const runtime = JSON.parse(await readFile("scripts/distribution/node-runtime.json", "utf8"));
const out = path.resolve(values.output);
const name = `device-deck-${pkg.version}-macos-${arch}-${mode}${release ? "" : "-team"}`;
const staging = path.join(out, "staging", `${arch}-${mode}`);
const payload = path.join(staging, "payload");
const app = path.join(payload, "Applications", "Device Deck.app");
const contents = path.join(app, "Contents"), resources = path.join(contents, "Resources");
const scripts = path.join(staging, "scripts");
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(resources, { recursive: true });
await mkdir(scripts, { recursive: true });
await mkdir(out, { recursive: true });
console.log(`Packaging ${name}; FFmpeg: ${values["media-bundle"] ? "bundled" : "external (see Capture Setup)"}.`);

const cache = path.join(out, "cache");
await mkdir(cache, { recursive: true });
const runtimeName = `node-v${runtime.version}-darwin-${arch}`;
const archive = path.join(cache, `${runtimeName}.tar.gz`);
async function validArchive() {
  try { return digest(await readFile(archive)) === runtime.darwin[arch]; } catch { return false; }
}
if (!(await validArchive())) {
  await rm(archive, { force: true });
  exec("/usr/bin/curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--retry", "3", "--output", archive,
    `https://nodejs.org/dist/v${runtime.version}/${runtimeName}.tar.gz`]);
  if (!(await validArchive())) { await rm(archive, { force: true }); throw new Error("Node archive failed its pinned SHA-256 check."); }
}
const extracted = path.join(staging, "node");
await mkdir(extracted);
exec("/usr/bin/tar", ["-xzf", archive, "-C", extracted, `${runtimeName}/bin/node`, `${runtimeName}/LICENSE`]);
await mkdir(path.join(resources, "runtime/bin"), { recursive: true });
await cp(path.join(extracted, runtimeName, "bin/node"), path.join(resources, "runtime/bin/node"));
await cp(path.join(extracted, runtimeName, "LICENSE"), path.join(resources, "runtime/LICENSE"));
const packagedNode = path.join(resources, "runtime/bin/node");
if (execFileSync(packagedNode, ["--version"], { encoding: "utf8" }).trim() !== `v${runtime.version}`) throw new Error("Bundled Node version mismatch.");

await mkdir(path.join(resources, "build"));
for (const item of applicationBuildPayload)
  await cp(path.join(root, "build", item), path.join(resources, "build", item), { recursive: true });
await mkdir(path.join(resources, "native"));
await cp("native/apple-tv.py", path.join(resources, "native/apple-tv.py"));
await cp("COPYRIGHT", path.join(resources, "COPYRIGHT"));
await writeFile(path.join(contents, "Info.plist"), appInfo(pkg.version));
await writeFile(path.join(contents, "PkgInfo"), "APPL????");
await writeFile(path.join(resources, "Capture Setup.html"), captureSetup(values["media-bundle"] ? "bundled" : "external"));
const notices = [];
async function collectNotices(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { await collectNotices(folder); continue; }
    try {
      const dependency = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"));
      const license = (await readdir(folder)).find((name) => /^licen[cs]e(?:\.md|\.txt)?$/i.test(name));
      if (license) notices.push(`${dependency.name} ${dependency.version}\n${await readFile(path.join(folder, license), "utf8")}`);
    } catch { /* Workspaces and packages without a license file have no additional notice here. */ }
  }
}
await collectNotices("node_modules");
await writeFile(path.join(resources, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n----------------------------------------\n\n"));
if (values["media-bundle"]) {
  const source = path.resolve(values["media-bundle"]);
  await validateMediaBundle(source, arch);
  await cp(source, path.join(resources, "media"), { recursive: true });
}
exec("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(root, "build/swift-cache"), "-O", "-target",
  `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx${minimumOS}`, "native/macos/app.swift", "-o", path.join(contents, "MacOS/Device Deck")]);
exec("/usr/bin/xcrun", ["clang", "-O2", "-target", `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx${minimumOS}`,
  "native/macos/cli.c", "-o", path.join(contents, "MacOS/devdeck")]);
exec("/usr/bin/plutil", ["-lint", path.join(contents, "Info.plist")]);
const binaryFiles = await verifyMachOClosure(await walk(app), arch);
// Installer ownership becomes root:wheel. Normalize permissions before signing
// so a restrictive build-shell umask cannot make the installed app unreadable.
async function normalizePermissions(directory) {
  await chmod(directory, 0o755);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await normalizePermissions(file);
    else await chmod(file, binaryFiles.includes(file) ? 0o755 : 0o644);
  }
}
await normalizePermissions(app);
// The application boundary must contain only actual release code, never the dev
// profile, source adapters, source maps, npm or private provisioning credentials.
const forbidden = /(?:^|\/)(?:node_modules|\.env[^/]*|secrets|local-deck|service-local\.ts|start-local\.ts)(?:\/|$)|\.map$/;
for (const file of await walk(app)) if (forbidden.test(path.relative(app, file))) throw new Error(`Forbidden release payload: ${file}`);
const distribution = {
  schemaVersion: 1, application: bundleId, version: pkg.version, arch, mode,
  minimumOS, runtime: { name: "node", version: runtime.version, sha256: runtime.darwin[arch] },
  media: values["media-bundle"] ? "bundled" : "external",
  channel: release ? "stable" : "team", signing: release ? "developer-id-notarized" : "ad-hoc",
  build,
};
await writeFile(path.join(resources, "distribution.json"), JSON.stringify(distribution, null, 2) + "\n");
await chmod(path.join(resources, "distribution.json"), 0o644);
const sign = (file, entitlements) => exec("/usr/bin/codesign", ["--force", "--sign", release ? applicationIdentity : "-",
  ...(release ? ["--options", "runtime", "--timestamp"] : []), ...(entitlements ? ["--entitlements", entitlements] : []), file]);
for (const binary of binaryFiles.sort((a, b) => b.length - a.length)) {
  if (binary === path.join(contents, "MacOS/Device Deck")) continue;
  sign(binary, binary === packagedNode ? "native/macos/node-entitlements.plist" : binary.endsWith("deck-camera") ? "native/macos/entitlements.plist" : undefined);
}
sign(app, "native/macos/entitlements.plist");
exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
for (const [filename, data] of [["preinstall", preinstall], ["postinstall", postinstall]]) {
  await writeFile(path.join(scripts, filename), data, { mode: 0o755 });
  await chmod(path.join(scripts, filename), 0o755);
}
const components = path.join(staging, "components.plist");
await writeFile(components, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array><dict><key>RootRelativeBundlePath</key><string>Applications/Device Deck.app</string><key>BundleIsRelocatable</key><false/><key>BundleHasStrictIdentifier</key><true/><key>BundleOverwriteAction</key><string>upgrade</string></dict></array></plist>`);
const component = path.join(staging, "component.pkg");
exec("/usr/bin/pkgbuild", ["--root", payload, "--identifier", bundleId, "--version", packageVersion,
  "--install-location", "/", "--ownership", "recommended", "--component-plist", components, "--scripts", scripts, component]);
const installer = path.join(out, `${name}.pkg`);
const distributionXML = path.join(staging, "Distribution.xml");
await writeFile(distributionXML, `<?xml version="1.0" encoding="utf-8"?><installer-gui-script minSpecVersion="2"><title>Device Deck ${xml(pkg.version)}</title><options customize="never" require-scripts="true" hostArchitectures="${arch === "x64" ? "x86_64" : "arm64"}"/><domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/><allowed-os-versions><os-version min="${minimumOS}"/></allowed-os-versions><choices-outline><line choice="default"/></choices-outline><choice id="default" visible="false"><pkg-ref id="${bundleId}"/></choice><pkg-ref id="${bundleId}" version="${packageVersion}" onConclusion="none">component.pkg</pkg-ref></installer-gui-script>`);
exec("/usr/bin/productbuild", ["--distribution", distributionXML, "--package-path", staging,
  ...(release ? ["--sign", installerIdentity, "--timestamp"] : []), installer]);
if (release) {
  exec("/usr/bin/xcrun", ["notarytool", "submit", installer, "--keychain-profile", notaryProfile, "--wait"]);
  exec("/usr/bin/xcrun", ["stapler", "staple", installer]);
  exec("/usr/bin/xcrun", ["stapler", "validate", installer]);
  exec("/usr/sbin/spctl", ["--assess", "--type", "install", "--verbose=2", installer]);
}
const bytes = await readFile(installer);
const checksum = digest(bytes);
await writeFile(`${installer}.sha256`, `${checksum}  ${path.basename(installer)}\n`);
await writeFile(path.join(out, `${name}.json`), JSON.stringify({ ...distribution, file: path.basename(installer), bytes: bytes.length, sha256: checksum }, null, 2) + "\n");
console.log(`\n${release ? "Signed and notarized release" : "TEAM TEST PACKAGE — unsigned installer, ad-hoc app"}: ${installer}\nSHA-256 ${checksum}\nStaged app: ${app}`);
