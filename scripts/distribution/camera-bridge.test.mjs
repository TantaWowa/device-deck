import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile), enabled = process.platform === "darwin";
let root, bridge;
before(async () => {
  if (!enabled) return;
  const scratch = path.join(os.homedir(), "hope-scratch");
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, "camera-ipc-"));
  bridge = path.join(root, "deck-camera");
  await exec("clang", [`-DDEVICE_DECK_USB_ROOT="${root}"`, "-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2", "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`, "native/macos/camera-bridge.c", "-o", bridge]);
  // No AVFoundation, devices or real clipboard access occurs in this suite.
  const fixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [command, argument] = process.argv.slice(2);
const directory = process.env.CAMERA_FIXTURE_DIRECTORY;
fs.appendFileSync(path.join(directory, 'calls'), command + '\\n');
if (command === 'list-usb') process.stdout.write(JSON.stringify(process.argv.slice(3)));
else if (command === 'stream-usb') process.stdout.write(argument);
else if (command === 'list') { process.stdout.write('[{"uniqueId":"fixture","name":"Test camera"}]'); process.stderr.write('discovery fixture\\n'); }
else if (command === 'clipboard') process.stdout.write(argument);
else if (argument === 'burst') {
  fs.writeFileSync(path.join(directory, 'burst.pid'), String(process.pid));
  (async () => { for (let i = 0; i < 96; i++) await new Promise((resolve, reject) => process.stdout.write(Buffer.alloc(32768, 120), error => error ? reject(error) : resolve())); process.stderr.write('stream complete\\n'); process.exitCode = 7; })();
} else if (argument.startsWith('hang')) {
  fs.writeFileSync(path.join(directory, argument + '.pid'), String(process.pid));
  process.on('SIGTERM', () => { fs.writeFileSync(path.join(directory, argument + '.stopped'), 'stopped'); process.exit(0); });
  setInterval(() => {}, 100);
} else { process.stderr.write('unknown fixture stream\\n'); process.exitCode = 2; }
`;
  await writeFile(path.join(root, "deck-camera-native"), fixture, { mode: 0o755 });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
const exists = file => lstat(file).then(() => true, () => false);
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise(resolve => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function fixture(t, start = true) {
  const profile = await mkdtemp(path.join(root, "p-"));
  await chmod(profile, 0o700);
  const socket = path.join(profile, "camera.sock");
  const env = { ...process.env, DEVICE_DECK_HOME: profile, DEVICE_DECK_SYSTEM_SERVICE: "1", CAMERA_FIXTURE_DIRECTORY: profile };
  let broker;
  if (start) {
    broker = spawn(bridge, ["--broker", socket], { env, stdio: "pipe" });
    let diagnostics = "";
    broker.stderr.on("data", chunk => diagnostics += chunk);
    t.after(() => terminate(broker));
    await until(() => exists(socket), `Broker did not start: ${diagnostics}`);
  }
  return { profile, socket, env, broker, command: args => exec(bridge, args, { env, maxBuffer: 5 * 1024 * 1024 }) };
}

const macTest = (name, callback) => test(name, { skip: !enabled }, callback);
macTest("camera broker starts without hardware access and preserves discovery stdout/stderr", async t => {
  const f = await fixture(t);
  assert.equal(await exists(path.join(f.profile, "calls")), false);
  assert.equal((await lstat(f.socket)).mode & 0o777, 0o600);
  const result = await f.command(["list"]);
  assert.deepEqual(JSON.parse(result.stdout), [{ uniqueId: "fixture", name: "Test camera" }]);
  assert.equal(result.stderr, "discovery fixture\n");
  assert.equal((await f.command(["clipboard", "/Users/host/My image.png"])).stdout, "/Users/host/My image.png");
});
macTest("camera proxy transports bounded frames with backpressure and native exit status", async t => {
  const f = await fixture(t);
  await assert.rejects(f.command(["stream", "burst"]), error => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout.length, 96 * 32768);
    assert.equal(error.stdout, "x".repeat(96 * 32768));
    assert.equal(error.stderr, "stream complete\n");
    return true;
  });
});
macTest("disconnecting a proxy cancels its native stream while other clients keep working", async t => {
  const f = await fixture(t);
  const proxy = spawn(bridge, ["stream", "hang-one"], { env: f.env, stdio: "pipe" });
  t.after(() => terminate(proxy));
  await until(() => exists(path.join(f.profile, "hang-one.pid")), "Native stream did not start");
  assert.ok(JSON.parse((await f.command(["list"])).stdout).length);
  await terminate(proxy);
  await until(() => exists(path.join(f.profile, "hang-one.stopped")), "Native stream survived proxy cancellation");
});
macTest("a client that stops reading cannot block broker discovery or stream cancellation", async t => {
  const f = await fixture(t);
  const proxy = spawn(bridge, ["stream", "burst"], { env: f.env, stdio: "pipe" });
  // Leave stdout paused so both the proxy's pipe and its Unix socket fill.
  t.after(() => terminate(proxy));
  await until(() => exists(path.join(f.profile, "burst.pid")), "Native stream did not start");
  const pid = Number(await readFile(path.join(f.profile, "burst.pid"), "utf8"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.parse((await f.command(["list"])).stdout)[0].uniqueId, "fixture");
  await terminate(proxy);
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, "Backpressured native helper survived cancellation");
});
macTest("stopping the desktop broker cancels native children and removes its socket", async t => {
  const f = await fixture(t);
  const proxy = spawn(bridge, ["stream", "hang-two"], { env: f.env, stdio: "pipe" });
  t.after(() => terminate(proxy));
  await until(() => exists(path.join(f.profile, "hang-two.pid")), "Native stream did not start");
  await terminate(f.broker);
  await until(() => exists(path.join(f.profile, "hang-two.stopped")), "Native stream survived desktop shutdown");
  assert.equal(await exists(f.socket), false);
});
macTest("camera helpers terminate after an unexpected broker death", async t => {
  const f = await fixture(t);
  const proxy = spawn(bridge, ["stream", "hang-orphan"], { env: f.env, stdio: "pipe" });
  t.after(() => terminate(proxy));
  await until(() => exists(path.join(f.profile, "hang-orphan.pid")), "Native stream did not start");
  f.broker.kill("SIGKILL");
  await until(() => exists(path.join(f.profile, "hang-orphan.stopped")), "Native stream survived broker failure");
});
macTest("system service never falls back to direct capture when no desktop is available", async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.command(["list"]), error => error.code === 69 && /Sign in as the host and open Device Deck from Applications/.test(error.stderr));
  assert.equal(await exists(path.join(f.profile, "calls")), false);
  const direct = await exec(bridge, ["list"], { env: { ...f.env, DEVICE_DECK_SYSTEM_SERVICE: "0" } });
  assert.equal(JSON.parse(direct.stdout)[0].uniqueId, "fixture");
});
macTest("broker rejects symlinks, public profile directories and an already active socket", async t => {
  const f = await fixture(t, false);
  const target = path.join(f.profile, "do-not-replace");
  await writeFile(target, "preserve me");
  await symlink(target, f.socket);
  await assert.rejects(exec(bridge, ["--broker", f.socket], { env: f.env }), /unsafe camera bridge path/);
  assert.equal(await readFile(target, "utf8"), "preserve me");
  await rm(f.socket);
  await chmod(f.profile, 0o755);
  await assert.rejects(exec(bridge, ["--broker", f.socket], { env: f.env }), /private directory/);
  const active = await fixture(t);
  await assert.rejects(exec(bridge, ["--broker", active.socket], { env: active.env }), /already running/);
  assert.equal(JSON.parse((await active.command(["list"])).stdout)[0].uniqueId, "fixture");
});
macTest("broker rejects malformed requests without executing its helper", async t => {
  const f = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.socket), chunks = [];
    socket.on("error", reject);
    socket.on("connect", () => socket.write(Buffer.from([68, 68, 67, 49, 90, 0, 0, 0, 0])));
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
  });
  assert.match(response.toString(), /Unsupported camera command/);
  assert.equal(await exists(path.join(f.profile, "calls")), false);
  await assert.rejects(f.command(["clipboard", "relative.png"]), error => error.code === 64);
  await assert.rejects(f.command(["stream", "x".repeat(4096)]), error => error.code === 64);
});

macTest("a USB desktop shares only its selected inputs and never accepts clipboard work", async t => {
  const uid = String(process.getuid());
  const f = await fixture(t, false);
  const socket = path.join(root, "com.tantawowa.device-deck.usb-" + uid, "camera.sock");
  const provider = spawn(bridge, ["--share-usb", uid, "first", "second"], { env: f.env });
  t.after(() => terminate(provider));
  await until(() => exists(socket), "USB provider did not start");
  const request = args => exec(bridge, ["--desktop", uid, ...args], { env: f.env });
  assert.deepEqual(JSON.parse((await request(["list"])).stdout), ["first", "second"]);
  assert.equal((await request(["stream", "second"])).stdout, "second");
  await assert.rejects(request(["stream", "private"]), /has not shared/);
  await assert.rejects(request(["clipboard", "/private/example"]));
  assert.deepEqual((await readFile(path.join(f.profile,"calls"), "utf8")).trim().split("\n"), ["list-usb","stream-usb"]);
});
