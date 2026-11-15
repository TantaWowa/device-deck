import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupCISigning, setupCISigning, signingIdentities } from "./ci-signing.mjs";

const identityOutput = '1) ABC "Developer ID Application: Device Deck (TEAM123456)"\n2) DEF "Developer ID Installer: Device Deck (TEAM123456)"\n';
const originalKeychain = "/Users/runner/Library/Keychains/login.keychain-db";
const apiKey = { DEVICE_DECK_NOTARY_KEY_ID: "TESTKEY123", DEVICE_DECK_NOTARY_ISSUER: "test-issuer",
  DEVICE_DECK_NOTARY_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nNot a real private key; test fixture only.\n-----END PRIVATE KEY-----\n" };
async function fixture(t, fail) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "device-deck-signing-test-")), calls = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, "environment"),
    DEVICE_DECK_APPLICATION_P12: Buffer.from("application certificate fixture").toString("base64"),
    DEVICE_DECK_INSTALLER_P12: Buffer.from("installer certificate fixture").toString("base64"),
    DEVICE_DECK_P12_PASSWORD: "test password", DEVICE_DECK_APPLE_ID: "release@example.com",
    DEVICE_DECK_APPLE_TEAM_ID: "TEAM123456", DEVICE_DECK_APPLE_APP_PASSWORD: "test application password" };
  const run = (file, args) => {
    calls.push({ file, args });
    if (fail?.(file, args)) throw new Error("simulated command failure");
    if (args[0] === "find-identity") return identityOutput;
    if (["default-keychain", "list-keychains"].includes(args[0]) && !args.includes("-s")) return `    "${originalKeychain}"\n`;
    return "";
  };
  return { env, run, calls, directory };
}

test("release identity selection requires both valid identities from the configured team", () => {
  assert.equal(signingIdentities(identityOutput, "TEAM123456").DEVICE_DECK_INSTALLER_IDENTITY, "Developer ID Installer: Device Deck (TEAM123456)");
  assert.throws(() => signingIdentities(identityOutput, "OTHERTEAM"), /exactly one/);
  assert.throws(() => signingIdentities(identityOutput + identityOutput, "TEAM123456"), /exactly one/);
  assert.throws(() => signingIdentities(identityOutput.split("\n")[0], "TEAM123456"), /Installer/);
});

test("signing setup exports only public settings and cleanup restores runner keychains", async t => {
  const options = await fixture(t);
  await setupCISigning(options);
  const exported = await readFile(options.env.GITHUB_ENV, "utf8");
  assert.match(exported, /DEVICE_DECK_APPLICATION_IDENTITY=Developer ID Application/);
  assert.match(exported, /DEVICE_DECK_NOTARY_PROFILE=device-deck/);
  assert.doesNotMatch(exported, /test password|test application password|release@example.com/);
  assert.deepEqual(await readdir(path.join(options.directory, "device-deck-signing")), ["previous-keychains.json"]);
  await cleanupCISigning(options);
  assert.deepEqual(options.calls.slice(-3).map(call => call.args), [
    ["default-keychain", "-d", "user", "-s", originalKeychain],
    ["list-keychains", "-d", "user", "-s", originalKeychain],
    ["delete-keychain", path.join(options.directory, "device-deck-signing/release.keychain-db")],
  ]);
  await assert.rejects(access(path.join(options.directory, "device-deck-signing")), { code: "ENOENT" });
  await cleanupCISigning(options);
});

test("failed certificate import removes credentials and restores original keychains", async t => {
  const options = await fixture(t, (_file, args) => args[0] === "import");
  await assert.rejects(setupCISigning(options), /simulated command failure/);
  await assert.rejects(access(path.join(options.directory, "device-deck-signing")), { code: "ENOENT" });
  await assert.rejects(access(options.env.GITHUB_ENV), { code: "ENOENT" });
  assert.equal(options.calls.at(-1).args[0], "delete-keychain");
  assert.deepEqual(options.calls.at(-3).args, ["default-keychain", "-d", "user", "-s", originalKeychain]);
});

test("API notarization uses a private temporary key and exports only the saved profile", async t => {
  let keyFile;
  const options = await fixture(t, (file, args) => {
    if (file !== "/usr/bin/xcrun" || args[1] !== "store-credentials") return false;
    keyFile = args[args.indexOf("--key") + 1];
    assert.equal(readFileSync(keyFile, "utf8"), apiKey.DEVICE_DECK_NOTARY_PRIVATE_KEY);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(args[args.indexOf("--key-id") + 1], apiKey.DEVICE_DECK_NOTARY_KEY_ID);
    assert.equal(args[args.indexOf("--issuer") + 1], apiKey.DEVICE_DECK_NOTARY_ISSUER);
    assert.ok(!args.includes("--apple-id") && !args.includes("--password"));
    return false;
  });
  Object.assign(options.env, apiKey);
  delete options.env.DEVICE_DECK_APPLE_ID;
  delete options.env.DEVICE_DECK_APPLE_APP_PASSWORD;
  await setupCISigning(options);
  assert.ok(keyFile);
  await assert.rejects(access(keyFile), { code: "ENOENT" });
  const exported = await readFile(options.env.GITHUB_ENV, "utf8");
  assert.match(exported, /DEVICE_DECK_NOTARY_PROFILE=device-deck/);
  for (const secret of Object.values(apiKey)) assert.ok(!exported.includes(secret));
  await cleanupCISigning(options);
});

test("complete API credentials take precedence over legacy Apple ID credentials", async t => {
  const options = await fixture(t);
  Object.assign(options.env, apiKey);
  await setupCISigning(options);
  const command = options.calls.find(call => call.args[1] === "store-credentials");
  assert.ok(command.args.includes("--key") && !command.args.includes("--apple-id"));
  await cleanupCISigning(options);
});

test("partial CI API credentials fail before touching keychains, including with legacy credentials", async t => {
  const fields = Object.entries(apiKey);
  for (let mask = 1; mask < 7; mask++) {
    const options = await fixture(t);
    Object.assign(options.env, Object.fromEntries(fields.filter((_entry, index) => mask & (1 << index))));
    await assert.rejects(setupCISigning(options), /Missing public release setting: DEVICE_DECK_NOTARY_/);
    assert.equal(options.calls.length, 0);
  }
});

test("failed API credential storage removes the temporary P8 and restores keychains", async t => {
  const options = await fixture(t, (_file, args) => args[1] === "store-credentials");
  Object.assign(options.env, apiKey);
  await assert.rejects(setupCISigning(options), /simulated command failure/);
  await assert.rejects(access(path.join(options.directory, "device-deck-signing")), { code: "ENOENT" });
  await assert.rejects(access(options.env.GITHUB_ENV), { code: "ENOENT" });
  assert.deepEqual(options.calls.at(-3).args, ["default-keychain", "-d", "user", "-s", originalKeychain]);
  assert.equal(options.calls.at(-1).args[0], "delete-keychain");
});

test("missing secrets fail before any keychain mutation", async t => {
  const options = await fixture(t);
  delete options.env.DEVICE_DECK_INSTALLER_P12;
  await assert.rejects(setupCISigning(options), /DEVICE_DECK_INSTALLER_P12/);
  assert.equal(options.calls.length, 0);
});

test("signing bootstrap refuses persistent self-hosted runners", async t => {
  const options = await fixture(t);
  options.env.RUNNER_ENVIRONMENT = "self-hosted";
  await assert.rejects(setupCISigning(options), /ephemeral GitHub runners only/);
  assert.equal(options.calls.length, 0);
});
