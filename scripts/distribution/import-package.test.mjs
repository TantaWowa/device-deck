import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRegularTree, inspectUnsignedPackage, requireExpectedCheckout, validateExpandedPackage, validateImportMetadata } from "./import-package.mjs";
import { bundleId, digest, minimumOS, postinstall, preinstall } from "./package-support.mjs";

const version = "1.2.3-beta.4", expectedCommit = "a".repeat(40);
const runtime = { version: "24.17.0", darwin: { arm64: "b".repeat(64), x64: "c".repeat(64) } };
const expected = { version, expectedCommit, runtime };
const bytes = Buffer.from("immutable unsigned native CI artifact");
function metadata(arch = "x64") {
  return { schemaVersion: 1, application: bundleId, version, arch, mode: "free", media: "bundled", signing: "ad-hoc", minimumOS,
    channel: "beta", file: `device-deck-${version}-macos-${arch}.pkg`, bytes: bytes.length, sha256: digest(bytes),
    runtime: { name: "node", version: runtime.version, sha256: runtime.darwin[arch] },
    build: { schema: 1, version, arch, mode: "free", commit: expectedCommit, builtAt: "2026-11-15T12:00:00.000Z" } };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function artifact(directory, data = metadata()) {
  const file = path.join(directory, data.file);
  await writeFile(file, bytes, { mode: 0o644 });
  await writeFile(file.replace(/\.pkg$/, ".json"), JSON.stringify(data), { mode: 0o644 });
  await writeFile(`${file}.sha256`, `${data.sha256}  ${data.file}\n`, { mode: 0o644 });
  return file;
}

test("import binds both native architectures to the source commit, product and pinned Node", () => {
  for (const arch of ["arm64", "x64"]) assert.equal(validateImportMetadata(metadata(arch), { ...expected, expectedArch: arch }), arch);
  for (const [field, value] of Object.entries({ schemaVersion: 2, application: "another.app", version: "1.2.4", arch: "universal", mode: "licensed", media: "external", signing: "developer-id-notarized", minimumOS: "10.0", channel: "stable", file: "other.pkg", bytes: 2 ** 32, sha256: "bad" }))
    assert.throws(() => validateImportMetadata({ ...metadata(), [field]: value }, expected), undefined, field);
  for (const [field, value] of Object.entries({ schema: 2, version: "1.2.4", arch: "arm64", mode: "licensed", commit: "d".repeat(40), builtAt: "invalid" })) {
    const data = metadata(); data.build[field] = value;
    assert.throws(() => validateImportMetadata(data, expected), undefined, `build.${field}`);
  }
  assert.throws(() => validateImportMetadata(metadata(), { ...expected, expectedArch: "arm64" }), /architecture/);
  const data = metadata(); data.runtime.sha256 = runtime.darwin.arm64;
  assert.throws(() => validateImportMetadata(data, expected), /Node runtime/);
});

test("import requires byte size, SHA-256 and checksum filename agreement before expansion", async t => {
  const file = await artifact(await temporary(t));
  assert.deepEqual(await inspectUnsignedPackage(file, expected), { file, metadata: metadata(), arch: "x64" });
  await writeFile(file, Buffer.alloc(bytes.length, 65));
  await assert.rejects(inspectUnsignedPackage(file, expected), /checksum/);
  await writeFile(file, bytes);
  await writeFile(`${file}.sha256`, `${digest(bytes)}  wrong.pkg\n`);
  await assert.rejects(inspectUnsignedPackage(file, expected), /checksum/);
  await writeFile(`${file}.sha256`, `${digest(bytes)}  ${path.basename(file)}\n`);
  await writeFile(file, "truncated");
  await assert.rejects(inspectUnsignedPackage(file, expected), /size/);
});

test("import rejects linked or writable input and bounded sidecar violations", async t => {
  const directory = await temporary(t), file = await artifact(directory);
  await chmod(file, 0o666);
  await assert.rejects(inspectUnsignedPackage(file, expected), /regular/);
  await chmod(file, 0o644);
  await link(file, `${file}.hardlink`);
  await assert.rejects(inspectUnsignedPackage(file, expected), /regular/);
  await rm(`${file}.hardlink`);
  const data = await readFile(file); await rm(file); await writeFile(`${file}.original`, data); await symlink(`${file}.original`, file);
  await assert.rejects(inspectUnsignedPackage(file, expected), /regular/);
  await rm(file); await writeFile(file, data);
  await writeFile(file.replace(/\.pkg$/, ".json"), " ".repeat(65537));
  await assert.rejects(inspectUnsignedPackage(file, expected), /regular/);
});

test("expanded input excludes symlinks, hardlinks and unsafe file or directory permissions", async t => {
  const directory = await temporary(t), file = path.join(directory, "code");
  await writeFile(file, "safe", { mode: 0o644 });
  assert.deepEqual(await inspectRegularTree(directory), [file]);
  await symlink(file, path.join(directory, "linked"));
  await assert.rejects(inspectRegularTree(directory), /regular/);
  await rm(path.join(directory, "linked"));
  await chmod(file, 0o4755);
  await assert.rejects(inspectRegularTree(directory), /regular/);
  await chmod(file, 0o644); await mkdir(path.join(directory, "writable")); await chmod(path.join(directory, "writable"), 0o777);
  await assert.rejects(inspectRegularTree(directory), /Unsafe imported directory/);
});

async function expandedFixture(directory) {
  const component = path.join(directory, "component.pkg");
  await mkdir(path.join(component, "Scripts"), { recursive: true });
  await mkdir(path.join(component, "Payload"));
  await writeFile(path.join(component, "Bom"), "");
  await writeFile(path.join(component, "PackageInfo"), `<pkg-info identifier="${bundleId}" version="1.2.3" install-location="/"><bundle id="${bundleId}" path="./Applications/Device Deck.app"/></pkg-info>`);
  await writeFile(path.join(directory, "Distribution"), '<installer-gui-script><options hostArchitectures="x86_64"/></installer-gui-script>');
  await writeFile(path.join(component, "Scripts/preinstall"), preinstall);
  await writeFile(path.join(component, "Scripts/postinstall"), postinstall);
  return component;
}

test("expanded packages reject injected top-level payload and modified installer scripts", async t => {
  const directory = await temporary(t), component = await expandedFixture(directory), imported = { metadata: metadata(), arch: "x64" };
  await writeFile(path.join(directory, "extra.pkg"), "");
  await assert.rejects(validateExpandedPackage(directory, imported, directory), /Unexpected imported payload layout/);
  await rm(path.join(directory, "extra.pkg"));
  await writeFile(path.join(component, "Scripts/preinstall"), `${preinstall}\necho injected\n`);
  await assert.rejects(validateExpandedPackage(directory, imported, directory), /source-controlled file differs/);
});

test("installer XML rejects external entities and mismatched package identity before code inspection", { skip: process.platform !== "darwin" }, async t => {
  const directory = await temporary(t), component = await expandedFixture(directory), imported = { metadata: metadata(), arch: "x64" };
  const info = path.join(component, "PackageInfo"), original = await readFile(info, "utf8");
  await writeFile(info, '<!DOCTYPE pkg-info [<!ENTITY file SYSTEM "file:///etc/passwd">]>' + original);
  await assert.rejects(validateExpandedPackage(directory, imported, directory), /cannot declare entities/);
  await writeFile(info, original.replace(`identifier="${bundleId}"`, 'identifier="another.app"'));
  await assert.rejects(validateExpandedPackage(directory, imported, directory), /identity differs/);
  await writeFile(info, original);
  await writeFile(path.join(directory, "Distribution"), '<installer-gui-script><options hostArchitectures="arm64"/></installer-gui-script>');
  await assert.rejects(validateExpandedPackage(directory, imported, directory), /architecture differs/);
});

test("signing import requires an exact clean source checkout", async t => {
  const directory = await temporary(t);
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  await writeFile(path.join(directory, "source"), "release source");
  git("add", "source"); git("-c", "user.name=Import Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  assert.doesNotThrow(() => requireExpectedCheckout(directory, commit));
  assert.throws(() => requireExpectedCheckout(directory, commit.slice(0, 7)), /full merged source SHA/);
  assert.throws(() => requireExpectedCheckout(directory, expectedCommit), /HEAD differs/);
  await writeFile(path.join(directory, "untracked"), "unexpected source");
  assert.throws(() => requireExpectedCheckout(directory, commit), /clean checkout/);
  await rm(path.join(directory, "untracked")); await writeFile(path.join(directory, "source"), "modified source");
  assert.throws(() => requireExpectedCheckout(directory, commit), /clean checkout/);
});
