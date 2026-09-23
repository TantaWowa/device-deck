import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appInfo, applicationBuildPayload, numericVersion, postinstall, preinstall, requireReleaseSettings, validateMediaBundle } from "./package-support.mjs";
const exec = promisify(execFile);

test("every application package includes the public reservation client", () => {
  assert.ok(applicationBuildPayload.includes("client.mjs"));
  assert.ok(applicationBuildPayload.includes("build-metadata.json"));
});

test("public packages cannot silently fall back to unsigned or test licensing", () => {
  const complete = { release: true, mode: "live", applicationIdentity: "Developer ID Application: Team (123)", installerIdentity: "Developer ID Installer: Team (123)", notaryProfile: "device-deck" };
  assert.doesNotThrow(() => requireReleaseSettings(complete));
  for (const field of ["applicationIdentity", "installerIdentity", "notaryProfile"]) assert.throws(() => requireReleaseSettings({ ...complete, [field]: undefined }));
  assert.throws(() => requireReleaseSettings({ ...complete, mode: "test" }), /live/);
  assert.doesNotThrow(() => requireReleaseSettings({ release: false, mode: "test" }));
});

test("prerelease versions preserve release identity and valid Mac numeric versions", () => {
  assert.equal(numericVersion("0.5.0-beta.1"), "0.5.0");
  assert.match(appInfo("0.5.0-beta.1"), /<key>DeviceDeckReleaseVersion<\/key><string>0.5.0-beta.1<\/string>/);
  assert.throws(() => appInfo('1.0.0</string>'), /major/);
});

test("installer adds an absent CLI link but preserves existing files and unrelated/development links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-install-script-"));
  try {
    const script = path.join(directory, "postinstall"), destination = path.join(directory, "volume/usr/local/bin/devdeck");
    await writeFile(script, postinstall);
    await exec("/bin/sh", [script, "package", "/", path.join(directory, "volume")]);
    assert.equal(await readlink(destination), "/Applications/Device Deck.app/Contents/MacOS/devdeck");
    await exec("/bin/sh", [script, "package", "/", path.join(directory, "volume")]);
    await rm(destination);
    await symlink("/some/development/checkout/devdeck", destination);
    const retained = await exec("/bin/sh", [script, "package", "/", path.join(directory, "volume")]);
    assert.match(retained.stderr, /was preserved/);
    assert.equal(await readlink(destination), "/some/development/checkout/devdeck");
    await rm(destination);
    await writeFile(destination, "another tool");
    await exec("/bin/sh", [script, "package", "/", path.join(directory, "volume")]);
    assert.equal(await readFile(destination, "utf8"), "another tool");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("installer rejects replacing a linked application and leaves user data alone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-preinstall-script-"));
  try {
    const script = path.join(directory, "preinstall"), volume = path.join(directory, "volume");
    await writeFile(script, preinstall);
    await mkdir(path.join(volume, "Applications"), { recursive: true });
    await mkdir(path.join(volume, "Library/Application Support/Device Deck"), { recursive: true });
    const data = path.join(volume, "Library/Application Support/Device Deck/config.json");
    await writeFile(data, "user data");
    await exec("/bin/sh", [script, "package", "/", volume]);
    await symlink(directory, path.join(volume, "Applications/Device Deck.app"));
    await assert.rejects(exec("/bin/sh", [script, "package", "/", volume]), /Refusing to replace an application symlink/);
    await rm(path.join(volume, "Applications/Device Deck.app"));
    await symlink(path.join(directory, "missing"), path.join(volume, "Applications/Device Deck.app"));
    await assert.rejects(exec("/bin/sh", [script, "package", "/", volume]), /Refusing to replace an application symlink/);
    await rm(path.join(volume, "Applications/Device Deck.app"));
    await mkdir(path.join(volume, "Applications/Device Deck.app/Contents"), { recursive: true });
    await writeFile(path.join(volume, "Applications/Device Deck.app/Contents/Info.plist"), appInfo("1.0.0").replace("com.tantawowa.device-deck", "another.app"));
    await assert.rejects(exec("/bin/sh", [script, "package", "/", volume]), /Another application occupies/);
    assert.equal(await readFile(data, "utf8"), "user data");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("vendored media rejects absent licenses/source and path traversal before executable loading", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-media-manifest-"));
  try {
    const manifest = path.join(directory, "media-manifest.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, arch: process.arch, components: [{ name: "ffmpeg" }] }));
    await assert.rejects(validateMediaBundle(directory, process.arch), /Each media component/);
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, arch: process.arch, components: [{ name: "ffmpeg", version: "8", license: "GPL-3.0-or-later", source: "../source.tar.gz", notices: "COPYING", files: [{ path: "bin/ffmpeg", sha256: "0".repeat(64) }] }] }));
    await assert.rejects(validateMediaBundle(directory, process.arch), /Unsafe media manifest path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
