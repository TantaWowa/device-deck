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
  transportId?: string;
  meminfo?: string;
};
function fixture(initial: Entry[] = []) {
  const state = {
    entries: initial,
    names: ["TV_API_35", "Pixel_35"],
    launchError: undefined as string | undefined,
    autoBoot: true,
    adbUnavailable: false,
    deferLaunchIdentity: false,
    sleeps: 0,
    processes: [] as { pid: number; command: string }[],
    onSignal: undefined as
      | ((pid: number, signal: NodeJS.Signals) => void)
      | undefined,
    packages: ["com.example.first", "com.example.second"],
    packageOutput: undefined as string | undefined,
    packageError: "",
    users: ["0"],
    userPackages: new Map<string, string[]>(),
    uninstallFailures: new Set<string>(),
    onUninstall: undefined as (() => void) | undefined,
    onPackageList: undefined as (() => void) | undefined,
    onKill: undefined as (() => void) | undefined,
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
    if (state.adbUnavailable && command.endsWith("/adb")) throw new Error("adb: Timed out after 15 seconds.");
    if (command === "/bin/ps")
      output = state.processes
        .map((process) => `${process.pid} ${process.command}`)
        .join("\n");
    else if (args[0] === "-list-avds") output = state.names.join("\n") + "\n";
    else if (args[2] === "devices")
      output =
        "List of devices attached\nphysical-usb\tdevice\n" +
        state.entries.map((e) => `${e.serial}\t${e.state}${args.includes("-l") ? ` transport_id:${e.transportId || e.serial.slice(9)}` : ""}`).join("\n");
    else {
      assert.deepEqual(
        args.slice(0, 2),
        ["-P", "5038"],
        "Every device command addresses the configured ADB server",
      );
      assert(["-s", "-t"].includes(args[2]), "A device command must select an exact serial or transport");
      const entry = state.entries.find((e) => args[2] === "-s" ? e.serial === args[3] : (e.transportId || e.serial.slice(9)) === args[3]);
      if (!entry) throw new Error("The selected Android transport disconnected");
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
      else if (args.slice(4).join(" ") === "shell cat /proc/meminfo")
        output = entry.meminfo ?? "MemTotal:        1506996 kB\nMemFree: 245040 kB\n";
      else if (args.slice(4).join(" ") === "exec-out screencap -p") {
        const image = entry.displayReady === false ? Buffer.alloc(0) : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHSkAAAAASUVORK5CYII=", "base64");
        return { stdout: image, stderr: "" };
      }
      else if (args.slice(4).join(" ") === "emu kill") {
        state.entries = state.entries.filter((e) => e !== entry);
        state.onKill?.();
        output = "OK\n";
      } else if (args.slice(4).join(" ") === "shell pm list users") {
        output = "Users:\n" + state.users.map((id) => `UserInfo{${id}:User ${id}:13} running`).join("\n");
      } else if (args.slice(4, -1).join(" ") === "shell pm list packages -3 --user") {
        const userId = args.at(-1)!;
        assert(state.users.includes(userId), "List apps using a verified numeric user ID");
        output = state.packageOutput ?? (state.userPackages.get(userId) ?? state.packages).map((id) => `package:${id}`).join("\n");
        state.onPackageList?.();
        return { stdout: Buffer.from(output), stderr: state.packageError };
      } else if (args[4] === "uninstall") {
        assert.equal(args.length, 6, "Uninstall must not preserve app data or use a shell command");
        const appId = args[5];
        if (state.uninstallFailures.has(appId)) output = "Failure [DELETE_FAILED_INTERNAL_ERROR]";
        else {
          assert(state.packages.includes(appId), "Only listed third-party packages may be removed");
          state.packages = state.packages.filter((id) => id !== appId);
          output = "Success\n";
        }
        state.onUninstall?.();
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

test("a shared Deck can enable CoreAudio for its full AVD while retaining the CI audio driver on other launches", async (t) => {
  const variable = "DEVICE_DECK_FULL_AVD_AUDIO";
  const previous = process.env[variable];
  process.env[variable] = "coreaudio";
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  for (const tag of ["android-full-ram", "android-low-ram", "ci"]) {
    const f = fixture();
    await f.emulator.control({ ...device, tags: [tag] }, "launch");
    const args = f.launches[0].args;
    if (tag === "android-full-ram") assert.deepEqual(args.slice(args.indexOf("-audio"), args.indexOf("-audio") + 2), ["-audio", "coreaudio"]);
    else assert.ok(!args.includes("-audio"));
  }
});

test("android-low-ram cold starts preserve the headless renderer, ADB port and group ownership", async () => {
  const f = fixture();
  const tagged = { ...device, tags: ["ci", "android-low-ram"] };
  let ownership: SimulatorLaunchOwnership | undefined;
  const result = await f.emulator.control(tagged, "launch", async owned => {
    ownership = owned;
  }, undefined, { headless: true });
  assert.equal(result.changed, true);
  assert.deepEqual(f.launches, [{
    binary: "/sdk/emulator/emulator",
    port: 5038,
    args: [
      "-avd", "TV_API_35", "-no-snapshot", "-lowram", "-memory", "1536",
      "-no-window", "-gpu", "software", "-feature", "-Vulkan",
      "-crash-report-mode", "disabled", "-no-metrics", "-prop", `qemu.devdeck_launch=${ownership?.marker}`,
    ],
  }]);
  assert.equal((await f.emulator.control(tagged, "close", undefined, ownership)).changed, true);
});

test("a warm AVD within the low-RAM budget passes verification on its pinned transport", async () => {
  const f = fixture([{ serial: "emulator-5560", transportId: "982", state: "device", name: "TV_API_35", booted: true }]);
  const tagged = { ...device, tags: ["android-low-ram"] };
  const result = await f.emulator.control(tagged, "launch");
  const target = await f.emulator.resolve(tagged);
  assert(target);
  await f.emulator.verifyMemoryProfile(target);
  assert.deepEqual(f.calls.filter(call => call.args.includes("/proc/meminfo")).map(call => call.args),
    [["-P", "5038", "-t", "982", "shell", "cat", "/proc/meminfo"]]);
  assert.equal(result.changed, false);
  assert.equal(f.launches.length, 0);
  assert(!f.calls.some(call => call.args.includes("kill")));
});

test("the checked memory budget rejects stock or unreadable RAM and leaves the AVD running", async () => {
  const entry: Entry = { serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true, meminfo: "MemTotal: 2531992 kB\n" };
  const f = fixture([entry]);
  const tagged = { ...device, tags: ["android-low-ram"] };
  await assert.rejects(f.emulator.verifyMemoryProfile(tagged), /2473 MiB.*1536 MiB.*launch it through Device Deck/);
  entry.meminfo = "MemTotal: 1572864 kB\n";
  await f.emulator.verifyMemoryProfile(tagged);
  entry.meminfo = "MemAvailable: 300 kB\n";
  await assert.rejects(f.emulator.verifyMemoryProfile(tagged), /Could not read guest RAM/);
  entry.name = "Pixel_35";
  await assert.rejects(f.emulator.verifyMemoryProfile(tagged), /different AVD/);
  assert.equal(f.state.entries.length, 1);
  assert.equal(f.launches.length, 0);
  assert(!f.calls.some(call => call.args.includes("kill")));
});

test("stock AVDs and physical devices skip memory verification", async () => {
  const f = fixture();
  await f.emulator.verifyMemoryProfile(device);
  await f.emulator.verifyMemoryProfile({ ...device, kind: "physical", tags: ["android-low-ram"] });
  assert.equal(f.calls.length, 0);
});

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
  assert.equal(launched.action, "launch");
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

test("cold app cleanup restores the marked emulator when ADB stops responding", async () => {
  const f = fixture();
  f.state.processes.push({ pid: 4999, command: "/sdk/emulator/qemu-system -avd TV_API_35" });
  f.state.onUninstall = () => { f.state.adbUnavailable = true; };
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /Timed out/);
  assert.deepEqual(f.signals, [{ pid: 4123, signal: "SIGTERM" }]);
  assert.deepEqual(f.state.processes.map(p => p.pid), [4999]);
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

test("Android app cleanup removes only third-party packages across profiles on the exact AVD", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "device", name: "Pixel_35", booted: true },
    { serial: "emulator-5562", state: "device", name: "TV_API_35", booted: true },
  ]);
  f.state.users = ["0", "10"];
  f.state.userPackages.set("0", ["com.example.first"]);
  f.state.userPackages.set("10", ["com.example.first", "com.example.second"]);
  assert.deepEqual(await f.emulator.cleanup(device, "uninstall-apps"), { removedApps: 2, state: "booted" });
  assert.deepEqual(f.calls.filter((call) => call.args[4] === "uninstall").map((call) => call.args), [
    ["-P", "5038", "-t", "5562", "uninstall", "com.example.first"],
    ["-P", "5038", "-t", "5562", "uninstall", "com.example.second"],
  ]);
  assert.deepEqual(f.calls.filter((call) => call.args.includes("packages")).map((call) => call.args.at(-1)), ["0", "10"]);
  assert.equal(f.launches.length, 0);
  assert(!f.calls.some((call) => call.args.includes("kill")));
  assert.equal(f.state.entries.length, 2);
});

test("Android app cleanup temporarily boots a stopped AVD and restores shutdown", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "Pixel_35", booted: true }]);
  assert.deepEqual(await f.emulator.cleanup(device, "uninstall-apps"), { removedApps: 2, state: "shutdown" });
  assert.equal(f.launches.length, 1);
  assert(f.launches[0].args.includes("-no-window"));
  assert(!f.launches[0].args.includes("-wipe-data"));
  assert(f.launches[0].args.some((arg) => arg.startsWith("qemu.devdeck_launch=")));
  assert.deepEqual(f.state.entries.map((entry) => entry.name), ["Pixel_35"]);
});

test("Android cleanup reports partial uninstall failures and still restores a stopped AVD", async () => {
  const f = fixture();
  f.state.uninstallFailures.add("com.example.first");
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /Removed 1 app\. 1 app could not be removed.*com\.example\.first/);
  assert.deepEqual(f.state.packages, ["com.example.first"]);
  assert.equal(f.state.entries.length, 0);
});

test("Android cleanup rejects malformed app lists before any uninstall", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.state.packageOutput = "package:com.example.first\nError: permission denied";
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /invalid installed-app list/);
  assert(!f.calls.some((call) => call.args[4] === "uninstall"));
});

test("Android cleanup rejects profile enumeration errors even when pm exits successfully", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.state.users = ["0", "10"];
  f.state.packageError = "Error: java.lang.SecurityException: Shell cannot access user 10";
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /could not list apps for user.*SecurityException/);
  assert(!f.calls.some((call) => call.args[4] === "uninstall"));
});

test("Android cleanup pins its transport even when another AVD reuses the serial before uninstall", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.state.onPackageList = () => { f.state.entries = [{ serial: "emulator-5554", transportId: "8888", state: "device", name: "Pixel_35", booted: true }]; };
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /Removed 0 apps.*transport disconnected/);
  assert(f.calls.filter((call) => call.args[4] === "uninstall").every((call) => call.args[2] === "-t" && call.args[3] === "5554"));
  assert.deepEqual(f.state.packages, ["com.example.first", "com.example.second"]);
  assert.equal(f.state.entries[0].name, "Pixel_35");
});

test("Android reset wipes only the configured AVD, starts without loading a snapshot, then closes it", async () => {
  const f = fixture([
    { serial: "emulator-5554", state: "device", name: "Pixel_35", booted: true },
    { serial: "emulator-5562", state: "device", name: "TV_API_35", booted: true },
  ]);
  const result = await f.emulator.cleanup(device, "reset");
  assert.equal(result.state, "shutdown");
  assert.match(result.warning || "", /SD-card image is preserved/);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0].args.slice(0, 4), ["-avd", "TV_API_35", "-wipe-data", "-no-snapshot"]);
  assert(f.launches[0].args.includes("-no-window"));
  assert.deepEqual(f.calls.filter((call) => call.args.includes("kill")).map((call) => call.args.slice(2, 4)), [["-t", "5562"], ["-t", "5560"]]);
  assert.deepEqual(f.state.entries.map((entry) => entry.name), ["Pixel_35"]);
  assert(!f.calls.some((call) => call.args[4] === "uninstall"));
});

test("Android reset fails if the AVD is restarted by another process before the wipe launch", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  f.state.onKill = () => { f.state.entries.push({ serial: "emulator-5562", state: "device", name: "TV_API_35", booted: true }); };
  await assert.rejects(f.emulator.cleanup(device, "reset"), /started again before cleanup/);
  assert.equal(f.launches.length, 0);
  assert.equal(f.state.entries[0].serial, "emulator-5562");
});

test("Android cleanup rejects physical, ambiguous and transitional targets before mutation", async () => {
  const f = fixture([{ serial: "emulator-5554", state: "device", name: "TV_API_35", booted: true }]);
  await assert.rejects(f.emulator.cleanup({ ...device, kind: "physical" }, "reset"), /only for Android emulators/);
  f.state.entries.push({ serial: "emulator-5556", state: "device", name: "TV_API_35", booted: true });
  await assert.rejects(f.emulator.cleanup(device, "uninstall-apps"), /Multiple running emulator/);
  f.state.entries.pop();
  f.state.entries[0].booted = false;
  await assert.rejects(f.emulator.cleanup(device, "reset"), /finish starting or closing/);
  assert.equal(f.launches.length, 0);
  assert(!f.calls.some((call) => call.args.includes("kill") || call.args[4] === "uninstall"));
});

test("Android cleanup stops its marked temporary process when launch fails", async () => {
  const f = fixture();
  f.state.launchError = "System image failed to boot";
  await assert.rejects(f.emulator.cleanup(device, "reset"), /Reset did not finish.*System image failed to boot/);
  assert.deepEqual(f.signals, [{ pid: 4123, signal: "SIGTERM" }]);
  assert.equal(f.state.processes.length, 0);
});
