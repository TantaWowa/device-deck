import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const exec = promisify(execFile);
const root = process.cwd();
const location = path.join(root, "work/George's relocated app");
await mkdir(location, { recursive: true });
await exec("/usr/bin/tar", [
  "-xzf",
  path.resolve("../../outputs/device-deck-0.2.0-macos-arm64.tar.gz"),
  "-C",
  location,
]);
const app = path.join(location, "device-deck");
const directory = path.join(location, "State");
const env = {
  HOME: os.homedir(),
  PATH: [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":"),
  DEVICE_DECK_HOME: directory,
  DEVICE_DECK_PORT: "0",
};
const cli = async (...args) =>
  (
    await exec(path.join(app, "devdeck"), args, {
      cwd: "/private/tmp",
      env,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
const call = async (op, args = {}) =>
  JSON.parse(await cli("call", op, JSON.stringify(args), "--json"));
await cli("init");
let lease;
let installed = false;
try {
  await cli("start");
  assert.equal(JSON.parse(await cli("status")).status, "ready");
  const current = await call("config.get");
  const config = current.config;
  assert.equal(
    config.devices.length,
    0,
    "Release must start with an empty inventory",
  );
  config.settings.folder = path.join(location, "George's capture files");
  config.tools.adb = path.join(
    os.homedir(),
    "Library/Android/sdk/platform-tools/adb",
  );
  config.devices = [
    {
      id: "relocated-android",
      name: "Relocated Android TV",
      platform: "Android",
      kind: "virtual",
      model: "Dedicated proof AVD",
      visibility: "local",
      connection: { type: "adb", serial: "emulator-5580", port: 5037 },
      captureSourceId: "android-native",
    },
  ];
  config.sources = [
    {
      id: "android-native",
      name: "Native Android proof screen",
      kind: "native",
      deviceId: "relocated-android",
    },
  ];
  await call("config.save", { config, revision: current.revision });
  const r = await call("sessions.reserve", {
    selector: { device: "relocated-android" },
    owner: "Release proof",
    reason: "Relocated package with minimal environment",
  });
  lease = { sessionId: r.session.id, leaseToken: r.leaseToken };
  await call("remote.input", { ...lease, key: "Home" });
  const screenshot = await call("captures.screenshot", {
    ...lease,
    clipboard: true,
  });
  assert.equal(screenshot.clipboardError, undefined);
  await call("recordings.start", { ...lease, mode: "annotated" });
  await new Promise((r) => setTimeout(r, 1000));
  await call("remote.input", { ...lease, key: "Down" });
  await new Promise((r) => setTimeout(r, 1000));
  const video = await call("recordings.stop", lease);
  assert.equal(video.status, "completed", video.error);
  assert.ok(video.duration >= 2);
  assert.ok(video.cleanPath);
  await call("captures.edit", {
    id: video.id,
    name: "George's Android proof",
    tags: ["release"],
  });
  const manifest = JSON.parse(await readFile(video.logPath, "utf8"));
  assert.equal(manifest.artifact.name, "George's Android proof");
  assert.ok(manifest.inputs.some((i) => i.key === "Down"));
  const ep = JSON.parse(
    await readFile(path.join(directory, "endpoint.json"), "utf8"),
  );
  const file = await fetch(
    `http://127.0.0.1:${ep.port}/v1/artifacts/${video.id}/file`,
    { headers: { Authorization: `Bearer ${ep.token}`, Range: "bytes=0-63" } },
  );
  assert.equal(file.status, 206);
  assert.match(
    file.headers.get("Content-Disposition"),
    /George.*Android%20proof\.mp4/,
  );
  assert.equal((await file.arrayBuffer()).byteLength, 64);
  await call("sessions.release", lease);
  lease = undefined;
  await cli("install");
  installed = true;
  assert.equal(JSON.parse(await cli("status")).status, "ready");
  const plist = await readFile(
    path.join(
      os.homedir(),
      "Library/LaunchAgents/com.tantawowa.device-deck.plist",
    ),
    "utf8",
  );
  assert.ok(plist.includes(path.join(app, "build/daemon.mjs")));
  await cli("uninstall");
  installed = false;
  await assert.rejects(
    stat(
      path.join(
        os.homedir(),
        "Library/LaunchAgents/com.tantawowa.device-deck.plist",
      ),
    ),
    { code: "ENOENT" },
  );
  assert.ok(await stat(video.path));
  assert.ok(await stat(path.join(directory, "config.json")));
  await assert.rejects(cli("status"));
  const result = {
    passed: true,
    minimalEnvironment: true,
    emptyInitialInventory: true,
    relocatedApp: app,
    outputFolder: config.settings.folder,
    screenshot: screenshot.path,
    video: video.path,
    duration: video.duration,
    metadataAndRangeDownload: true,
    nativeClipboard: true,
    loginInstallAndUninstall: true,
    retainedCaptureAndConfig: true,
  };
  await writeFile(
    "work/package-proof-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (lease) await call("sessions.release", lease).catch(() => {});
  if (installed) await cli("uninstall").catch(() => {});
  await cli("stop").catch(() => {});
}
