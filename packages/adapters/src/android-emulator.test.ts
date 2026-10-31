import test from "node:test";
import assert from "node:assert/strict";
import {
  configSchema,
  deviceSchema,
  type DeviceConfig,
  type SimulatorLaunchOwnership,
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
  bootId?: string;
  launchMarker?: string;
};
function fixture(initial: Entry[] = []) {
  const state = {
    entries: initial,
    names: ["TV_API_35", "Pixel_35"],
    launchError: undefined as string | undefined,
    autoBoot: true,
    deferLaunchIdentity: false,
    sleeps: 0,
    processes: [] as { pid: number; command: string }[],
    onSignal: undefined as
      | ((pid: number, signal: NodeJS.Signals) => void)
      | undefined,
  };
  const calls: { command: string; args: string[] }[] = [],
    launches: { binary: string; args: string[]; port: number }[] = [],
    signals: { pid: number; signal: NodeJS.Signals }[] = [];
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
    if (command === "/bin/ps")
      output = state.processes
        .map((process) => `${process.pid} ${process.command}`)
        .join("\n");
    else if (args[0] === "-list-avds") output = state.names.join("\n") + "\n";
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
      } else if (
        args.slice(4).join(" ") === "shell getprop qemu.devdeck_launch"
      ) {
        output = entry.launchMarker || "";
      } else if (args.slice(4).join(" ") === "shell getprop sys.boot_completed")
        output = entry.booted ? "1\n" : "\n";
      else if (args.slice(4).join(" ") === "shell getprop init.svc.bootanim")
        output = entry.bootAnimation ? "running\n" : "stopped\n";
      else if (args.slice(4).join(" ") === "shell cat /proc/sys/kernel/random/boot_id")
        output = entry.bootId || "00000000-0000-0000-0000-000000000001";
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
      state.processes.push({
        pid: 4123,
        command: `/sdk/emulator/qemu-system -avd ${args[1]} ${args.slice(2).join(" ")}`,
      });
      if (!state.launchError)
        state.entries.push({
          serial: "emulator-5560",
          state: "device",
          name: state.deferLaunchIdentity ? undefined : args[1],
          booted: state.autoBoot,
          launchMarker: args
            .find((argument) => argument.startsWith("qemu.devdeck_launch="))
            ?.split("=")[1],
        });
      return () => state.launchError;
    },
    async () => {
      state.sleeps++;
      if (state.deferLaunchIdentity && state.sleeps === 1)
        state.entries.at(-1)!.name = "TV_API_35";
    },
    (pid, signal) => {
      signals.push({ pid, signal });
      if (state.onSignal) state.onSignal(pid, signal);
      else
        state.processes = state.processes.filter(
          (process) => process.pid !== pid,
        );
      return true;
    },
  );
  return { emulator, state, calls, launches, signals, config, execute };
}

test("externally started emulators wait for display readiness and cache proof only for the same boot UUID", async () => {
  const entry: Entry = { serial: "emulator-5560", state: "device", name: "TV_API_35", booted: true, displayReady: false };
  const f = fixture([entry]);
  assert.equal((await f.emulator.inspect(device)).state, "starting");
  entry.displayReady = true;
  assert.equal((await f.emulator.inspect(device)).state, "booted");
  const screenshots = () => f.calls.filter((call) => call.args.includes("screencap")).length;
  const before = screenshots();
  assert.equal((await f.emulator.inspect(device)).state, "booted");
  assert.equal(screenshots(), before, "steady health checks reuse proof without recapturing the screen");
  entry.bootId = "00000000-0000-0000-0000-000000000002";
  entry.displayReady = false;
  assert.equal((await f.emulator.inspect(device)).state, "starting");
  assert.equal(screenshots(), before + 1, "a reboot entirely between polls still invalidates display proof");
  entry.booted = false;
  await assert.rejects(f.emulator.resolve(device), /still booting/);
});

test("group-owned Android launch is noninteractive, reconciles its new serial, and never controls the emulator occupying its old serial", async () => {
  const f = fixture([
    {
      serial: "emulator-5554",
      state: "device",
      name: "Pixel_35",
      booted: true,
    },
  ]);
  assert.equal((await f.emulator.inspect(device)).state, "shutdown");
  let ownership: SimulatorLaunchOwnership | undefined;
  const launched = await f.emulator.control(device, "launch", async (owned) => {
    assert.equal(f.launches.length, 0);
    ownership = owned;
  });
  assert.equal(ownership?.type, "android-emulator");
  assert.equal(ownership?.avdName, "TV_API_35");
  assert.match(ownership?.marker || "", /^[a-f0-9]{32}$/);
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
      args: [
        "-avd",
        "TV_API_35",
        "-crash-report-mode",
        "disabled",
        "-no-metrics",
        "-prop",
        `qemu.devdeck_launch=${ownership?.marker}`,
      ],
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

test("ordinary Android launches preserve interactive emulator arguments", async () => {
  const f = fixture();
  await f.emulator.control(device, "launch");
  assert.deepEqual(f.launches, [
    {
      binary: "/sdk/emulator/emulator",
      args: ["-avd", "TV_API_35"],
      port: 5038,
    },
  ]);
});

test("Android launch waits for its newly spawned AVD identity to become readable", async () => {
  const f = fixture();
  f.state.deferLaunchIdentity = true;
  const launched = await f.emulator.control(device, "launch");
  assert.equal(launched.changed, true);
  assert.equal(launched.serial, "emulator-5560");
  assert.equal(f.state.sleeps, 1);
  assert.equal(f.launches.length, 1);
});

test("group-owned Android launch cleanup uses its durable marker when ADB identity is unavailable", async () => {
  const f = fixture();
  let ownership: SimulatorLaunchOwnership | undefined;
  await f.emulator.control(device, "launch", async (owned) => {
    ownership = owned;
  });
  assert(ownership);
  f.state.entries = [
    { serial: "emulator-5554", state: "offline" },
  ];
  f.state.processes.push({
    pid: 4999,
    command: "/sdk/emulator/qemu-system -avd TV_API_35",
  });

  const closed = await f.emulator.control(
    device,
    "close",
    undefined,
    ownership,
  );
  assert.deepEqual(closed, {
    deviceId: device.id,
    action: "close",
    state: "shutdown",
    changed: true,
  });
  assert.deepEqual(f.signals, [{ pid: 4123, signal: "SIGTERM" }]);
  assert.deepEqual(
    f.state.processes.map((process) => process.pid),
    [4999],
    "an unmarked emulator using the same AVD name is never stopped",
  );
  assert(
    !f.calls.some((call) => call.args.includes("kill")),
    "offline ADB is not used for owned fallback cleanup",
  );
});

test("group-owned Android cleanup verifies the live ADB transport marker before graceful close", async () => {
  const f = fixture();
  let ownership: SimulatorLaunchOwnership | undefined;
  await f.emulator.control(device, "launch", async (owned) => {
    ownership = owned;
  });
  assert(ownership);
  const closed = await f.emulator.control(
    device,
    "close",
    undefined,
    ownership,
  );
  assert.equal(closed.changed, true);
  assert.deepEqual(
    f.calls
      .filter((call) => call.args.includes("qemu.devdeck_launch"))
      .map((call) => call.args),
    [[
      "-P",
      "5038",
      "-s",
      "emulator-5560",
      "shell",
      "getprop",
      "qemu.devdeck_launch",
    ]],
  );
  assert.deepEqual(
    f.calls.filter((call) => call.args.includes("kill")).map((call) => call.args),
    [["-P", "5038", "-s", "emulator-5560", "emu", "kill"]],
  );
  assert.deepEqual(f.signals, []);
});

test("group-owned cleanup never closes an online same-AVD replacement without its marker", async () => {
  const f = fixture([
    {
      serial: "emulator-5554",
      state: "device",
      name: "TV_API_35",
      booted: true,
    },
  ]);
  f.state.processes = [{
    pid: 4999,
    command: "/sdk/emulator/qemu-system -avd TV_API_35",
  }];
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "TV_API_35",
    marker: "c".repeat(32),
  };
  await assert.rejects(
    f.emulator.control(device, "close", undefined, ownership),
    (error) =>
      (error as { code?: string }).code === "emulator-ownership-missing",
  );
  assert.deepEqual(f.signals, []);
  assert(
    !f.calls.some((call) => call.args.includes("kill")),
    "a replacement AVD is never addressed by graceful close",
  );
  assert.deepEqual(f.state.processes.map((process) => process.pid), [4999]);
});

test("group-owned cleanup refuses an unidentified emulator without the exact launch marker", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "offline" },
  ]);
  f.state.processes = [{
    pid: 4999,
    command: "/sdk/emulator/qemu-system -avd TV_API_35",
  }];
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "TV_API_35",
    marker: "a".repeat(32),
  };
  await assert.rejects(
    f.emulator.control(device, "close", undefined, ownership),
    (error) =>
      (error as { code?: string }).code === "emulator-ownership-missing",
  );
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.state.processes.map((process) => process.pid), [4999]);
});

test("group-owned cleanup refuses duplicate processes carrying the same launch marker", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "offline" },
  ]);
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "TV_API_35",
    marker: "b".repeat(32),
  };
  const command = `/sdk/emulator/qemu-system -avd TV_API_35 -prop qemu.devdeck_launch=${ownership.marker}`;
  f.state.processes = [
    { pid: 4998, command },
    { pid: 4999, command },
  ];
  await assert.rejects(
    f.emulator.control(device, "close", undefined, ownership),
    (error) =>
      (error as { code?: string }).code === "ambiguous-owned-emulator",
  );
  assert.deepEqual(f.signals, []);
});

test("group-owned cleanup revalidates the marked PID before forced termination", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "offline" },
  ]);
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "TV_API_35",
    marker: "f".repeat(32),
  };
  const ownedCommand = `/sdk/emulator/qemu-system -avd TV_API_35 -prop qemu.devdeck_launch=${ownership.marker}`;
  f.state.processes = [{ pid: 4123, command: ownedCommand }];
  f.state.onSignal = (pid, signal) => {
    if (signal === "SIGTERM") {
      assert.equal(pid, 4123);
      f.state.processes = [
        {
          pid: 4123,
          command: "/usr/bin/unrelated-process --important",
        },
        { pid: 4999, command: ownedCommand },
      ];
    } else {
      f.state.processes = f.state.processes.filter(
        (process) => process.pid !== pid,
      );
    }
  };

  const closed = await f.emulator.control(
    device,
    "close",
    undefined,
    ownership,
  );
  assert.equal(closed.changed, true);
  assert.deepEqual(f.signals, [
    { pid: 4123, signal: "SIGTERM" },
    { pid: 4999, signal: "SIGKILL" },
  ]);
  assert.deepEqual(f.state.processes, [
    { pid: 4123, command: "/usr/bin/unrelated-process --important" },
  ]);
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

test("preparing and closing a known AVD keeps its stored placeholder when its live port belongs to a legacy row", async () => {
  const known: DeviceConfig = {
    ...device,
    connection: { type: "adb", serial: "avd-phone-35", avdName: "TV_API_35", port: 5038 },
  };
  const legacy: DeviceConfig = {
    ...device,
    id: "legacy-phone",
    connection: { type: "adb", serial: "emulator-5554", port: 5038 },
  };
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.config.devices = [known, legacy];
  assert.deepEqual(await f.emulator.prepare(known), known);
  const live = await f.emulator.resolve(known);
  assert.equal(live?.connection.type === "adb" && live.connection.serial, "emulator-5554");
  await f.emulator.control(await f.emulator.prepare(known), "close");
  assert.deepEqual(f.calls.filter((call) => call.args.includes("kill")).map((call) => call.args), [["-P", "5038", "-s", "emulator-5554", "emu", "kill"]]);
  assert.deepEqual(f.config.devices, [known, legacy]);
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

test("an unidentified emulator on a changed serial remains starting and cannot trigger a duplicate launch", async () => {
  const f = fixture([
    { serial: "emulator-5558", state: "device", booted: true },
  ]);
  await assert.rejects(
    f.emulator.inspect(device),
    /AVD identity is not available/,
  );
  await assert.rejects(
    f.emulator.control(device, "launch"),
    /AVD identity is not available/,
  );
  assert.equal(f.launches.length, 0);

  const adapters = new Adapters(() => f.config, f.execute);
  try {
    const inspected = await adapters.inspect(device);
    assert.equal(inspected.online, false);
    assert.equal(inspected.readiness, "starting");
    assert.equal(inspected.simulatorState, "starting");
    assert.match(inspected.healthDetail, /AVD identity is not available/);
  } finally {
    await adapters.close();
  }
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


test("headless Android launch uses software rendering without an emulator window", async (t) => {
  const previous = process.env.DEVICE_DECK_HEADLESS;
  t.after(() => {
    if (previous === undefined) delete process.env.DEVICE_DECK_HEADLESS;
    else process.env.DEVICE_DECK_HEADLESS = previous;
  });
  process.env.DEVICE_DECK_HEADLESS = "1";
  const f = fixture();
  await f.emulator.control(device, "launch", async () => {});
  assert.deepEqual(f.launches[0].args.slice(0, 7), ["-avd", "TV_API_35", "-no-window", "-gpu", "software", "-feature", "-Vulkan"]);
  assert.equal(f.launches[0].port, 5038);
  assert(f.launches[0].args.some(argument => argument.startsWith("qemu.devdeck_launch=")));
});
