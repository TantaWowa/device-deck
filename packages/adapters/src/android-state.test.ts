import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { androidFeatures, avdInputMode, avdProfile } from "./android-state";
import { Adapters } from "./index";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { deviceInputMode } from "../../core/src/remote";
import type { run } from "./process";

test("advertised Android television or leanback features win over touchscreen", () => {
  assert.deepEqual(androidFeatures("feature:android.hardware.touchscreen\n"), { inputMode: "touch", touchscreen: true });
  for (const tv of ["android.hardware.type.television", "android.software.leanback"])
    assert.deepEqual(androidFeatures(`feature:${tv}\nfeature:android.hardware.touchscreen\n`), { inputMode: "remote", touchscreen: true });
  assert.equal(androidFeatures("feature:android.software.leanback_only_similar_name").inputMode, "touch");
});

test("stopped AVD classification uses SDK tags including relocated AVDs, never a TV-looking name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-avd-mode-"));
  try {
    await mkdir(path.join(directory, "TV_named_phone.avd"));
    await writeFile(path.join(directory, "TV_named_phone.avd/config.ini"), "tag.id=google_apis\n");
    await mkdir(path.join(directory, "relocated"));
    await writeFile(path.join(directory, "actual_tv.ini"), `path=${directory}/relocated\n`);
    await writeFile(path.join(directory, "relocated/config.ini"), "tag.ids=android-tv,google_apis\n");
    assert.equal(await avdInputMode("TV_named_phone", [directory]), "touch");
    assert.equal(await avdInputMode("actual_tv", [directory]), "remote");
    assert.equal(await avdInputMode("missing", [directory]), undefined);
    assert.equal(await avdInputMode("../actual_tv", [directory]), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AVD profile reports the hardware model and system image in SDK package form", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-avd-profile-"));
  try {
    await mkdir(path.join(directory, "Pool_pixel_9.avd"));
    await writeFile(path.join(directory, "Pool_pixel_9.avd/config.ini"), "hw.device.name=pixel_9\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\ntag.id=google_apis\n");
    assert.deepEqual(await avdProfile("Pool_pixel_9", [directory]), { model: "pixel_9", runtime: "system-images;android-35;google_apis;arm64-v8a" });
    assert.deepEqual(await avdProfile("missing", [directory]), {});
    assert.deepEqual(await avdProfile("../Pool_pixel_9", [directory]), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const physical = deviceSchema.parse({ id: "phone", name: "Android", platform: "Android", kind: "physical", connection: { type: "adb", serial: "hardware-1", hardwareId: "hardware-1" } });
function fixture() {
  const state = { connected: true, booted: true, animation: "stopped", features: "feature:android.hardware.touchscreen\n", featureError: false };
  const calls: string[][] = [];
  const execute: typeof run = async (_command, args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 4), ["-P", "5037", "-s", "hardware-1"]);
    const command = args.slice(4).join(" ");
    let value: string;
    if (command === "shell getprop ro.serialno") value = "hardware-1";
    else if (command === "get-state") value = state.connected ? "device" : "offline";
    else if (command === "shell getprop sys.boot_completed") value = state.booted ? "1" : "";
    else if (command === "shell getprop init.svc.bootanim") value = state.animation;
    else if (command === "shell pm list features") {
      if (state.featureError) throw new Error("Package manager not ready");
      value = state.features;
    } else throw new Error(`Unexpected command: ${command}`);
    return { stdout: Buffer.from(value), stderr: "" };
  };
  return { state, calls, adapters: new Adapters(() => configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" } }), execute) };
}

test("physical Android stays offline with no input until boot completion and animation finish", async () => {
  const f = fixture();
  for (const transition of [{ booted: false, animation: "running" }, { booted: true, animation: "running" }]) {
    Object.assign(f.state, transition);
    const device = await f.adapters.inspect(physical);
    assert.equal(device.online, false);
    assert.equal(device.readiness, "starting");
    assert.equal(deviceInputMode(device), "touch");
    assert.deepEqual(device.capabilities, []);
    await assert.rejects(f.adapters.input(physical, { key: "Home" }), /still booting/);
    await assert.rejects(f.adapters.startInteractive(physical), /still booting/);
  }
  f.state.animation = "stopped";
  const ready = await f.adapters.inspect(physical);
  assert.equal(ready.online, true);
  assert.equal(ready.readiness, "ready");
  assert(ready.capabilities.includes("key"));
  assert.equal(deviceInputMode(ready), "touch");
  assert(!f.calls.some((args) => args.includes("input")), "booting input was never dispatched");
});

test("verified Android TV input class survives disconnection and a missing feature/helper response", async () => {
  const f = fixture();
  f.state.features = "feature:android.software.leanback\nfeature:android.hardware.touchscreen\n";
  assert.equal(deviceInputMode(await f.adapters.inspect(physical)), "remote");
  f.state.connected = false;
  const offline = await f.adapters.inspect(physical);
  assert.equal(offline.online, false);
  assert.equal(deviceInputMode(offline), "remote");
  f.state.connected = true;
  f.state.featureError = true;
  const missing = await f.adapters.inspect(physical);
  assert.equal(deviceInputMode(missing), "remote");
  assert(!missing.capabilities.includes("touch"));
  assert.equal(deviceInputMode(await f.adapters.inspect({ ...physical, id: "different" })), "touch");
});
