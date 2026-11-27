import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyReleaseArtifacts } from "./verify-release.mjs";

const version = "1.0.0-beta.1", commit = "a".repeat(40);
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "device-deck-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const arch = "arm64";
  const name = `device-deck-${version}-macos-${arch}`, file = `${name}.pkg`;
  const bytes = Buffer.from(`package fixture ${arch}`), sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(directory, file), bytes);
  await writeFile(path.join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify({ schemaVersion: 1,
    application: "com.tantawowa.device-deck", version, arch, mode: "free", media: "bundled",
    signing: "developer-id-notarized", file, bytes: bytes.length, sha256,
    build: { version, arch, mode: "free", commit } }));
  return { directory, version, commit };
}

test("release integrity gate accepts the arm64 package and rejects Intel artifacts", async t => {
  const options = await fixture(t);
  assert.equal((await verifyReleaseArtifacts(options)).length, 3);
  await assert.rejects(verifyReleaseArtifacts({ ...options, architectures: ["x64"] }), /arm64/);
  await writeFile(path.join(options.directory, `device-deck-${version}-macos-x64.pkg`), "old Intel installer");
  await assert.rejects(verifyReleaseArtifacts(options), /exactly/);
});

test("release integrity gate rejects unsigned, external-media and wrong-commit metadata", async t => {
  const options = await fixture(t), metadataPath = path.join(options.directory, `device-deck-${version}-macos-arm64.json`);
  const original = JSON.parse(await readFile(metadataPath, "utf8"));
  for (const changes of [{ signing: "ad-hoc" }, { media: "external" }, { build: { ...original.build, commit: "b".repeat(40) } }]) {
    await writeFile(metadataPath, JSON.stringify({ ...original, ...changes }));
    await assert.rejects(verifyReleaseArtifacts(options), /Refusing release/);
  }
});

test("release gate rejects changed bytes and arbitrary additional uploads", async t => {
  const options = await fixture(t), pkg = path.join(options.directory, `device-deck-${version}-macos-arm64.pkg`);
  const original = await readFile(pkg);
  await writeFile(pkg, Buffer.alloc(original.length, 0));
  await assert.rejects(verifyReleaseArtifacts(options), /checksum differs/);
  await writeFile(pkg, original);
  await writeFile(path.join(options.directory, "private.p12"), "never publish this");
  await assert.rejects(verifyReleaseArtifacts(options), /exactly/);
});
