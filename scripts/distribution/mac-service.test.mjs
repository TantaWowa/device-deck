import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const mac = process.platform === "darwin";
let scratch, executable;
before(async () => {
  if (!mac) return;
  scratch = await mkdtemp(path.join(os.tmpdir(), "deck-service-proof-"));
  executable = path.join(scratch, "device-deck-service");
  await exec("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(scratch, "swift-cache"), fileURLToPath(new URL("../../native/macos/service-manager.swift", import.meta.url)), "-o", executable]);
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

test("boot service plan runs as the selected account with private profile and bundled runtime", { skip: !mac }, async () => {
  const { stdout } = await exec(executable, ["--plan", String(process.getuid())]);
  const { host, launchDaemon } = JSON.parse(stdout);
  assert.equal(host.uid, process.getuid());
  assert.equal(host.username, os.userInfo().username);
  assert.equal(host.home, os.homedir());
  assert.equal(host.profile, path.join(os.homedir(), "Library/Application Support/Device Deck"));
  assert.equal(launchDaemon.UserName, host.username);
  assert.notEqual(launchDaemon.UserName, "root");
  assert.equal(launchDaemon.RunAtLoad, true);
  assert.equal(launchDaemon.KeepAlive, true);
  assert.equal(launchDaemon.Umask, 0o077);
  assert.equal(launchDaemon.ExitTimeOut, 180);
  assert.deepEqual(launchDaemon.ProgramArguments, [
    "/Applications/Device Deck.app/Contents/Resources/runtime/bin/node",
    "/Applications/Device Deck.app/Contents/Resources/build/daemon.mjs",
  ]);
  assert.equal(launchDaemon.EnvironmentVariables.HOME, host.home);
  assert.equal(launchDaemon.EnvironmentVariables.DEVICE_DECK_HOME, host.profile);
  assert.equal(launchDaemon.EnvironmentVariables.DEVICE_DECK_HOST_UID, String(host.uid));
  assert.equal(launchDaemon.EnvironmentVariables.DEVICE_DECK_SYSTEM_SERVICE, "1");
  assert.ok(launchDaemon.EnvironmentVariables.PATH.includes("/Contents/Resources/media/bin"));
  assert.equal(launchDaemon.StandardErrorPath, "/Library/Logs/Device Deck/daemon.log");
});

test("boot service setup rejects root, malformed and nonexistent hosting accounts", { skip: !mac }, async () => {
  for (const uid of ["0", "1", "-1", "501;touch /tmp/never", "4294967295"])
    await assert.rejects(exec(executable, ["--plan", uid]), /existing Mac user account/);
});

test("updater compares prereleases numerically and rejects malformed versions", { skip: !mac }, async () => {
  for (const [left, right, expected] of [
    ["0.9.0-beta.2", "0.9.0-beta.1", 1],
    ["0.9.0-beta.10", "0.9.0-beta.2", 1],
    ["0.9.0", "0.9.0-beta.10", 1],
    ["0.9.0-beta.2", "0.9.0", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["0.10.0", "0.9.10", 1],
    ["0.9.0-beta.2", "0.9.0-beta.2", 0],
  ]) assert.equal(Number((await exec(executable, ["--compare-versions", left, right])).stdout), expected);
  for (const invalid of ["1", "v1.0.0", "01.0.0", "1.0.0-beta.01", "1.0.0+unexpected", "1.0.0/../../", "999999999999999999999999.0.0"])
    await assert.rejects(exec(executable, ["--compare-versions", invalid, "1.0.0"]), /Invalid Device Deck release version/);
});

test("updater binds requested version and architecture to the Device Deck package payload", { skip: !mac }, async () => {
  const expanded = path.join(scratch, "expanded");
  const contents = path.join(expanded, "component.pkg/Payload/Applications/Device Deck.app/Contents");
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  await writeFile(path.join(expanded, "Distribution"), '<installer-gui-script><pkg-ref id="com.tantawowa.device-deck">component.pkg</pkg-ref></installer-gui-script>');
  const packageInfo = path.join(expanded, "component.pkg/PackageInfo");
  const correctPackage = '<pkg-info identifier="com.tantawowa.device-deck" version="0.9.0" install-location="/"/>';
  await writeFile(packageInfo, correctPackage);
  await writeFile(path.join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.tantawowa.device-deck</string><key>DeviceDeckReleaseVersion</key><string>0.9.0-beta.2</string></dict></plist>');
  const metadataFile = path.join(contents, "Resources/distribution.json");
  const metadata = { schemaVersion: 1, application: "com.tantawowa.device-deck", version: "0.9.0-beta.2", arch: "arm64", media: "bundled", mode: "free", signing: "developer-id-notarized" };
  await writeFile(metadataFile, JSON.stringify(metadata));
  const args = ["--check-package-metadata", expanded, "0.9.0-beta.2", "0.9.0-beta.1", "arm64"];
  assert.match((await exec(executable, args)).stdout, /metadata matches/);
  for (const changed of [
    { application: "com.tantawowa.other-product" }, { arch: "x64" },
    { version: "0.9.0-beta.3" }, { media: "external" }, { signing: "ad-hoc" },
  ]) {
    await writeFile(metadataFile, JSON.stringify({ ...metadata, ...changed }));
    await assert.rejects(exec(executable, args));
  }
  await writeFile(metadataFile, JSON.stringify(metadata));
  await writeFile(packageInfo, correctPackage.replace("com.tantawowa.device-deck", "com.tantawowa.other-product"));
  await assert.rejects(exec(executable, args), /package identity/);
  await writeFile(packageInfo, correctPackage);
  for (const installed of ["0.9.0-beta.2", "0.9.0", "1.0.0"])
    await assert.rejects(exec(executable, ["--check-package-metadata", expanded, "0.9.0-beta.2", installed, "arm64"]), /must be newer/);
  await mkdir(path.join(expanded, "extra.pkg"));
  await assert.rejects(exec(executable, args), /unexpected packages/);
});
