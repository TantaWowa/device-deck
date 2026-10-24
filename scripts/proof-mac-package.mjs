import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { digest, preinstall, verifyMachOClosure, walk } from "./distribution/package-support.mjs";

const { values } = parseArgs({ options: { app: { type: "string" }, package: { type: "string" } } });
if (!values.app) throw new Error("Use --app PATH/Device Deck.app; this proof never installs into /Applications.");
const app = await realpath(values.app), cli = path.join(app, "Contents/MacOS/devdeck");
if (app === "/Applications/Device Deck.app") throw new Error("Use the staged app, not an installed application.");
const directory = await mkdtemp(path.join(os.tmpdir(), "deck-packaged-proof-"));
const env = { HOME: os.homedir(), USER: process.env.USER, TMPDIR: process.env.TMPDIR || os.tmpdir(),
  PATH: "/usr/bin:/bin", DEVICE_DECK_HOME: directory, DEVICE_DECK_PORT: "0" };
const exec = promisify(execFile);
const command = (args) => exec(cli, args, { env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
let started = false, passed = false;
try {
  const distribution = JSON.parse(await readFile(path.join(app, "Contents/Resources/distribution.json"), "utf8"));
  if (values.package) {
    const packageFile = path.resolve(values.package);
    const metadata = JSON.parse(await readFile(packageFile.replace(/\.pkg$/, ".json"), "utf8"));
    const bytes = await readFile(packageFile);
    assert.equal(bytes.length, metadata.bytes);
    assert.equal(digest(bytes), metadata.sha256);
    assert.equal(metadata.version, distribution.version);
    const expanded = path.join(directory, "package-inspection");
    await exec("/usr/sbin/pkgutil", ["--expand-full", packageFile, expanded]);
    const packagedApp = path.join(expanded, "component.pkg/Payload/Applications/Device Deck.app");
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", packagedApp]);
    for (const file of await walk(app)) {
      const relative = path.relative(app, file);
      assert.equal(digest(await readFile(path.join(packagedApp, relative))), digest(await readFile(file)), `Installer payload differs from staged app: ${relative}`);
    }
    assert.equal(await readFile(path.join(expanded, "component.pkg/Scripts/preinstall"), "utf8"), preinstall);
  }
  await verifyMachOClosure(await walk(app), process.arch);
  const help = await command(["--help"]);
  assert.match(help.stdout, /Device Deck/);
  await command(["init"]);
  const before = await readFile(path.join(directory, "config.json"), "utf8");
  await command(["start"]);
  started = true;
  const health = JSON.parse((await command(["status", "--json"])).stdout);
  assert.ok(health);
  const inventory = JSON.parse((await command(["call", "inventory", "{}"])) .stdout);
  assert.equal(inventory.sessions.filter((session) => session.state !== "closed").length, 0);
  assert.equal(inventory.recordings.length, 0);
  assert.equal(inventory.mode, "local");
  assert.equal(inventory.license.tier, "enterprise");
  assert.equal(inventory.license.state, "active");
  assert.equal(inventory.license.maxSessions, null);
  assert.match(inventory.license.message, /^Monetization disabled\./);
  assert.equal(inventory.license.configured, true);
  const endpoint = JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/);
  // The staged app itself is active; preflight must refuse to overwrite it.
  const script = path.join(directory, "preinstall");
  await writeFile(script, preinstall);
  const payload = path.dirname(path.dirname(app));
  await assert.rejects(exec("/bin/sh", [script, "package", "/", payload]), /Device Deck is running/);
  await command(["stop"]);
  started = false;
  for (let i = 0; i < 30; i++) {
    try { await exec("/bin/sh", [script, "package", "/", payload]); break; }
    catch (error) { if (i === 29) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  env.DEVICE_DECK_HEADLESS = "1";
  assert.equal(await readFile(path.join(directory, "config.json"), "utf8"), before);
  const licensedConfig = JSON.stringify({ ...JSON.parse(before), monetization: { enabled: true } }, null, 2) + "\n";
  await writeFile(path.join(directory, "config.json"), licensedConfig);
  await command(["start"]);
  started = true;
  const headlessHealth = JSON.parse((await command(["status", "--json"])).stdout);
  const headlessProcess = await exec("/bin/ps", ["-p", String(headlessHealth.pid), "-o", "comm="]);
  assert.equal(headlessProcess.stdout.trim(), path.join(app, "Contents/Resources/runtime/bin/node"));
  const headlessInventory = JSON.parse((await command(["call", "inventory", "{}"])) .stdout);
  assert.equal(headlessInventory.license.tier, "free");
  assert.equal(headlessInventory.license.state, "free");
  assert.equal(headlessInventory.license.configured, true);
  await command(["stop"]);
  started = false;
  assert.equal(await readFile(path.join(directory, "config.json"), "utf8"), licensedConfig);
  console.log(JSON.stringify({ application: app, version: distribution.version, mode: distribution.mode,
    signing: distribution.signing, media: distribution.media, checks: [...(values.package ? ["installer checksum, signed payload and preflight contents"] : []), "relocatable Mach-O closure", "CLI with no Node on PATH", "LaunchServices app-owned daemon", "monetization disabled by default", "bundled web assets", "headless bundled runtime with config-enabled Keygen Free entitlement", "upgrade refuses running app", "clean shutdown preserves config"] }, null, 2));
  passed = true;
} finally {
  if (started) await command(["stop"]).catch(() => {});
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Package proof evidence retained: ${directory}`);
}
