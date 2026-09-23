import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { Adapters } from "./index";
import type { run } from "./process";

const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" }, tools: { adb: "/fixture/adb", idb: "/fixture/idb" } });
const android = deviceSchema.parse({
  id: "phone", name: "Android phone", platform: "Android", kind: "physical", inputMode: "touch",
  connection: { type: "adb", serial: "192.0.2.24:5555", hardwareId: "phone-hardware", port: 5040 },
});
const ios = deviceSchema.parse({
  id: "ios", name: "iOS simulator", platform: "Apple", kind: "virtual",
  connection: { type: "simulator", os: "ios", udid: "0371776A-0FC2-4DD1-8831-8941C7D1088A" },
});

function androidFixture() {
  const state = { serial: "phone-hardware", booted: true };
  const calls: { executable: string; args: string[] }[] = [];
  const execute: typeof run = async (executable, args) => {
    calls.push({ executable, args });
    assert.equal(executable, "/fixture/adb");
    assert.deepEqual(args.slice(0, 4), ["-P", "5040", "-s", "192.0.2.24:5555"]);
    const command = args.slice(4).join(" ");
    const stdout = command === "shell getprop ro.serialno" ? state.serial :
      command === "shell getprop sys.boot_completed" ? state.booted ? "1" : "0" :
        command === "shell getprop init.svc.bootanim" ? "stopped" : "";
    return { stdout: Buffer.from(stdout), stderr: "" };
  };
  return { state, calls, adapters: new Adapters(() => config, execute) };
}

test("Android hardware controls send real keyevents only to the verified phone transport", async () => {
  const f = androidFixture();
  for (const key of ["Back", "Home", "Recents", "VolumeDown", "VolumeUp", "Power"])
    await f.adapters.input(android, { key });
  assert.deepEqual(f.calls.filter(({ args }) => args.includes("input")).map(({ args }) => args), [
    "BACK", "HOME", "APP_SWITCH", "VOLUME_DOWN", "VOLUME_UP", "POWER",
  ].map((key) => ["-P", "5040", "-s", "192.0.2.24:5555", "shell", "input", "keyevent", `KEYCODE_${key}`]));
  f.calls.length = 0;
  f.state.serial = "different-phone";
  await assert.rejects(f.adapters.input(android, { key: "Power" }), /different hardware serial/);
  f.state.serial = "phone-hardware";
  f.state.booted = false;
  await assert.rejects(f.adapters.input(android, { key: "Recents" }), /still booting/);
  f.state.booted = true;
  await assert.rejects(f.adapters.input(android, { key: "SideButton" }), /Unsupported Android key/);
  assert.equal(f.calls.some(({ args }) => args.includes("input")), false);
});

function simulatorFixture(os: "ios" | "tvos" = "ios") {
  const device = { ...ios, connection: { ...ios.connection, type: "simulator" as const, udid: "0371776A-0FC2-4DD1-8831-8941C7D1088A", os } };
  const state = { booted: true };
  const calls: { executable: string; args: string[] }[] = [];
  const execute: typeof run = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === "xcrun") {
      if (args[1] === "list") return { stdout: Buffer.from(JSON.stringify({ devices: { [`com.apple.CoreSimulator.SimRuntime.${os === "ios" ? "iOS" : "tvOS"}-18-0`]: [{ udid: device.connection.udid, state: state.booted ? "Booted" : "Shutdown", isAvailable: true, dataPath: "/tmp" }] } })), stderr: "" };
      assert.deepEqual(args, ["simctl", "bootstatus", device.connection.udid]);
    } else {
      assert.equal(executable, "/fixture/idb");
      assert.deepEqual(args.slice(-2), ["--udid", device.connection.udid]);
    }
    return { stdout: Buffer.from(""), stderr: "" };
  };
  return { device, state, calls, adapters: new Adapters(() => config, execute) };
}

test("iOS hardware controls use idb buttons rather than keyboard keycodes or Android navigation", async () => {
  const f = simulatorFixture();
  for (const key of ["Home", "Lock", "SideButton"]) await f.adapters.input(f.device, { key });
  assert.deepEqual(f.calls.filter(({ executable }) => executable === "/fixture/idb").map(({ args }) => args), [
    "HOME", "LOCK", "SIDE_BUTTON",
  ].map((button) => ["ui", "button", button, "--udid", f.device.connection.udid]));
  f.calls.length = 0;
  for (const key of ["Back", "Recents", "VolumeDown", "VolumeUp", "Power"])
    await assert.rejects(f.adapters.input(f.device, { key }), /system Back|Unsupported simulator key/);
  assert.equal(f.calls.some(({ executable }) => executable === "/fixture/idb"), false);
  f.state.booted = false;
  await assert.rejects(f.adapters.input(f.device, { key: "Home" }), /stopped or still booting/);
  assert.equal(f.calls.some(({ executable }) => executable === "/fixture/idb"), false);
});

test("tvOS retains its remote Home and Back mapping without exposing iOS side buttons", async () => {
  const f = simulatorFixture("tvos");
  await f.adapters.input(f.device, { key: "Home" });
  await f.adapters.input(f.device, { key: "Back" });
  await assert.rejects(f.adapters.input(f.device, { key: "SideButton" }), /Unsupported simulator key/);
  assert.deepEqual(f.calls.filter(({ executable }) => executable === "/fixture/idb").map(({ args }) => args.slice(0, 3)), [
    ["ui", "button", "HOME"], ["ui", "key", "41"],
  ]);
});
