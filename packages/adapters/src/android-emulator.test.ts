import test from "node:test";
import assert from "node:assert/strict";
import {
  configSchema,
  deviceSchema,
  type DeviceConfig,
} from "../../core/src/local/types";
import { AndroidEmulators } from "./android-emulator";
import { Adapters } from "./index";
import type { run } from "./process";

const device = deviceSchema.parse({
  id: "android-tv",
  name: "Android TV",
  platform: "Android",
  kind: "virtual",
  connection: {
    type: "adb",
    serial: "emulator-5554",
    avdName: "TV_API_35",
    port: 5038,
  },
});
type Entry = {
  serial: string;
  state: string;
  name?: string;
  booted?: boolean;
  consoleEmpty?: boolean;
  bootName?: string;
  displayReady?: boolean;
  bootAnimation?: boolean;
};
function fixture(initial: Entry[] = []) {
  const state = {
    entries: initial,
    names: ["TV_API_35", "Pixel_35"],
    launchError: undefined as string | undefined,
    autoBoot: true,
  };
  const calls: { command: string; args: string[] }[] = [],
    launches: { binary: string; args: string[]; port: number }[] = [];
  const config = configSchema.parse({
    schemaVersion: 1,
    settings: { folder: "/tmp/captures" },
    tools: {
      adb: "/sdk/platform-tools/adb",
      emulator: "/sdk/emulator/emulator",
    },
  });
  const execute: typeof run = async (command, args) => {
    calls.push({ command, args });
    let output: string;
    if (args[0] === "-list-avds") output = state.names.join("\n") + "\n";
    else if (args[2] === "devices")
      output =
        "List of devices attached\nphysical-usb\tdevice\n" +
        state.entries.map((e) => `${e.serial}\t${e.state}`).join("\n");
    else {
      assert.deepEqual(
        args.slice(0, 3),
        ["-P", "5038", "-s"],
        "Every device command addresses the configured ADB server and exact serial",
      );
      const entry = state.entries.find((e) => e.serial === args[3]);
      assert(entry, "A command must never address a stale or guessed serial");
      if (args.slice(4).join(" ") === "emu avd name") {
        if (!entry.consoleEmpty && !entry.name)
          throw new Error("Identity still unavailable");
        output = entry.consoleEmpty ? "" : `${entry.name}\nOK\n`;
      } else if (
        args.slice(4).join(" ") === "shell getprop ro.boot.qemu.avd_name"
      ) {
        output = entry.bootName || "";
      } else if (args.slice(4).join(" ") === "shell getprop sys.boot_completed")
        output = entry.booted ? "1\n" : "\n";
      else if (args.slice(4).join(" ") === "shell getprop init.svc.bootanim")
        output = entry.bootAnimation ? "running\n" : "stopped\n";
      else if (args.slice(4).join(" ") === "exec-out screencap -p") {
        const image = entry.displayReady === false ? Buffer.alloc(0) : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHSkAAAAASUVORK5CYII=", "base64");
        return { stdout: image, stderr: "" };
      }
      else if (args.slice(4).join(" ") === "emu kill") {
        state.entries = state.entries.filter((e) => e !== entry);
        output = "OK\n";
      } else throw new Error(`Unexpected command ${args.join(" ")}`);
    }
    return { stdout: Buffer.from(output), stderr: "" };
  };
  const emulator = new AndroidEmulators(
    () => config,
    execute,
    async (binary) => binary.startsWith("/sdk/"),
    (binary, args, port) => {
      launches.push({ binary, args, port });
      if (!state.launchError)
        state.entries.push({
          serial: "emulator-5560",
          state: "device",
          name: args[1],
          booted: state.autoBoot,
        });
      return () => state.launchError;
    },
    async () => {},
  );
  return { emulator, state, calls, launches, config };
}

test("Android launch addresses an exact AVD, reconciles its new serial, and never controls the emulator occupying its old serial", async () => {
  const f = fixture([
    {
      serial: "emulator-5554",
      state: "device",
      name: "Pixel_35",
      booted: true,
    },
  ]);
  assert.equal((await f.emulator.inspect(device)).state, "shutdown");
  const launched = await f.emulator.control(device, "launch");
  assert.deepEqual(launched, {
    deviceId: device.id,
    action: "launch",
    state: "booted",
    changed: true,
    serial: "emulator-5560",
  });
  assert.deepEqual(f.launches, [
    {
      binary: "/sdk/emulator/emulator",
      args: ["-avd", "TV_API_35"],
      port: 5038,
    },
  ]);
  const adapters = new Adapters(() => f.config);
  adapters.emulators.resolve = f.emulator.resolve.bind(f.emulator);
  const resolved = await adapters.verifyIdentity(device);
  assert.equal(
    resolved.connection.type === "adb" && resolved.connection.serial,
    "emulator-5560",
  );
  assert.equal(
    device.connection.type === "adb" && device.connection.serial,
    "emulator-5554",
    "Config and a previously frozen recording target are not mutated",
  );
  await assert.rejects(
    adapters.verifyCaptureTransport(device),
    /connection changed during recording/,
  );
  await adapters.verifyCaptureTransport(resolved);
  assert.equal((await f.emulator.control(device, "launch")).changed, false);
  assert.equal(f.launches.length, 1);
  assert.equal((await f.emulator.control(device, "close")).changed, true);
  assert.equal((await f.emulator.control(device, "close")).changed, false);
  assert.deepEqual(
    f.calls.filter((c) => c.args.includes("kill")).map((c) => c.args),
    [["-P", "5038", "-s", "emulator-5560", "emu", "kill"]],
  );
  assert.equal(f.state.entries[0].name, "Pixel_35");
});

test("legacy emulator serials can learn their exact AVD and close, but cannot launch an unknown AVD", async () => {
  const legacy: DeviceConfig = {
    ...device,
    connection: { type: "adb", serial: "emulator-5554", port: 5038 },
  };
  const f = fixture([
    {
      serial: "emulator-5554",
      state: "device",
      name: "TV_API_35",
      booted: true,
    },
  ]);
  const resolved = await f.emulator.resolve(legacy);
  assert.equal(
    resolved?.connection.type === "adb" && resolved.connection.avdName,
    "TV_API_35",
  );
  await assert.rejects(
    f.emulator.control(legacy, "launch"),
    /AVD name before launching/,
  );
  await f.emulator.control(legacy, "close");
  assert.equal((await f.emulator.inspect(legacy)).state, "shutdown");
  assert.equal(f.launches.length, 0);
  assert(
    !f.calls.some((c) => c.args[0] === "-list-avds"),
    "Closing a known serial does not require the emulator executable",
  );
});

test("a reused serial cannot turn a legacy row into a second control identity for a configured AVD", async () => {
  const legacy: DeviceConfig = {
    ...device,
    id: "old-phone",
    connection: { type: "adb", serial: "emulator-5554", port: 5038 },
  };
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.config.devices = [device, legacy];
  for (const action of [
    () => f.emulator.resolve(legacy),
    () => f.emulator.prepare(legacy),
    () => f.emulator.inspect(legacy),
    () => f.emulator.control(legacy, "close"),
  ]) await assert.rejects(action, /now belongs to Android TV \(TV_API_35\)/);
  assert.equal((await f.emulator.resolve(device))?.id, device.id);
  assert.equal(f.launches.length, 0);
  assert(!f.calls.some((call) => call.args.includes("kill")));
});

test("booting emulators are not falsely marked stopped or launched twice; unverified AVD identity blocks control", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "offline", name: "TV_API_35" },
  ]);
  assert.equal((await f.emulator.inspect(device)).state, "starting");
  assert.equal(await f.emulator.resolve(device, false), undefined);
  await assert.rejects(f.emulator.resolve(device), /stopped or still starting/);
  await f.emulator.control(device, "close");
  assert.equal(f.state.entries.length, 0);
  f.state.entries = [{ serial: "emulator-5554", state: "offline" }];
  await assert.rejects(
    f.emulator.control(device, "launch"),
    /identity is not available/,
  );
  await assert.rejects(
    f.emulator.control(device, "close"),
    /identity is not available/,
  );
  assert.equal(f.launches.length, 0);
  const legacy: DeviceConfig = {
    ...device,
    connection: { type: "adb", serial: "emulator-5554", port: 5038 },
  };
  await assert.rejects(f.emulator.prepare(legacy), /identity is not available/);
  await assert.rejects(
    f.emulator.control(legacy, "close"),
    /identity is not available/,
  );
  f.state.entries[0].name = "TV_API_35";
  const prepared = await f.emulator.prepare(legacy);
  assert.equal(
    prepared.connection.type === "adb" && prepared.connection.avdName,
    "TV_API_35",
    "Readable identity may be persisted even while the ADB transport is offline",
  );
});

test("ambiguous instances, missing AVDs, physical targets, failed launch and boot timeout fail without guessing", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "device", name: "TV_API_35" },
    { serial: "emulator-5556", state: "device", name: "TV_API_35" },
  ]);
  await assert.rejects(
    f.emulator.control(device, "close"),
    /Multiple running emulator instances/,
  );
  assert(!f.calls.some((c) => c.args.includes("kill")));
  f.state.entries = [];
  f.state.names = [];
  assert.equal((await f.emulator.inspect(device)).state, "unavailable");
  await assert.rejects(
    f.emulator.control(device, "launch"),
    /AVD is unavailable/,
  );
  await assert.rejects(
    f.emulator.control({ ...device, kind: "physical" }, "close"),
    /not an Android emulator/,
  );
  f.state.names = ["TV_API_35"];
  f.state.launchError = "Missing system image";
  await assert.rejects(
    f.emulator.control(device, "launch"),
    /Missing system image/,
  );
  f.state.launchError = undefined;
  f.state.autoBoot = false;
  await assert.rejects(
    f.emulator.control(device, "launch"),
    /process was left running/,
  );
  assert.equal(
    f.state.entries.length,
    1,
    "A slow boot is not killed on timeout",
  );
});

test("available AVD discovery uses the configured existing emulator executable and filters invalid names", async () => {
  const f = fixture();
  f.state.names = ["TV_API_35", "TV_API_35", "Pixel_35", "-bad", "Bad Name"];
  assert.deepEqual(await f.emulator.names(), ["TV_API_35", "Pixel_35"]);
  assert.deepEqual(f.calls, [
    { command: "/sdk/emulator/emulator", args: ["-list-avds"] },
  ]);
  const missing = new AndroidEmulators(
    () => f.config,
    undefined,
    async () => false,
  );
  await assert.rejects(
    missing.names(),
    /Configured Android emulator executable is unavailable/,
  );
});

test("empty emulator console output falls back to the boot AVD property on the exact same serial", async () => {
  const f = fixture([
    {
      serial: "emulator-5558",
      state: "device",
      consoleEmpty: true,
      bootName: "TV_API_35",
      booted: true,
    },
  ]);
  const resolved = await f.emulator.resolve(device);
  assert.equal(
    resolved?.connection.type === "adb" && resolved.connection.serial,
    "emulator-5558",
  );
  assert.equal(
    resolved?.connection.type === "adb" && resolved.connection.avdName,
    "TV_API_35",
  );
  assert.deepEqual(
    f.calls
      .filter((c) => c.args.includes("ro.boot.qemu.avd_name"))
      .map((c) => c.args),
    [
      [
        "-P",
        "5038",
        "-s",
        "emulator-5558",
        "shell",
        "getprop",
        "ro.boot.qemu.avd_name",
      ],
    ],
  );
  assert.equal(f.launches.length, 0);
  const legacy: DeviceConfig = {
    ...device,
    connection: { type: "adb", serial: "emulator-5558", port: 5038 },
  };
  f.state.entries[0].consoleEmpty = false;
  const recovered = await f.emulator.prepare(legacy);
  assert.equal(
    recovered.connection.type === "adb" && recovered.connection.avdName,
    "TV_API_35",
    "A failed console query uses the same verified boot-property fallback",
  );
  for (const invalid of [
    "",
    "wrong/name",
    "-invalid",
    "two\nnames",
    "a".repeat(257),
  ]) {
    f.state.entries[0].bootName = invalid;
    await assert.rejects(
      f.emulator.prepare(legacy),
      /identity is not available/,
    );
    await assert.rejects(
      f.emulator.control(legacy, "close"),
      /identity is not available/,
    );
  }
  assert(!f.calls.some((c) => c.args.includes("kill")));
});


test("Launch waits for both boot animation completion and a capturable display", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true, bootAnimation: true }]);
  await assert.rejects(f.emulator.control(device, "launch"), /display is not ready/);
  assert.equal(f.launches.length, 0, "An existing booting emulator is never duplicated");
  assert.equal(f.calls.some((c) => c.args.includes("screencap")), false, "Do not declare the boot animation a ready screen");
  f.state.entries[0].bootAnimation = false;
  f.state.entries[0].displayReady = false;
  await assert.rejects(f.emulator.control(device, "launch"), /display is not ready/);
  assert(f.calls.some((c) => c.args.includes("screencap")));
  f.state.entries[0].displayReady = true;
  assert.equal((await f.emulator.control(device, "launch")).state, "booted");
  assert.equal(f.launches.length, 0);
});
