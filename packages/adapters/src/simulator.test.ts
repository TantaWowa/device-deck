import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { Adapters } from "./index";
import { cleanupSimulator, controlSimulator, simulatorState, verifySimulatorMemoryProfile, wakeSimulator, SimulatorInventory } from "./simulator";
import type { run } from "./process";

const simulator = deviceSchema.parse({
  id: "apple-sim",
  name: "Apple TV",
  platform: "Apple",
  kind: "virtual",
  connection: {
    type: "simulator",
    os: "tvos",
    udid: "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
  },
});
function fixture(
  initial = "Shutdown",
  target = simulator,
  dataPath: unknown = "/tmp",
  includeDataPath = true,
) {
  let state = initial;
  const calls: { command: string; args: string[]; timeout?: number }[] = [];
  const execute: typeof run = async (command, args, timeout) => {
    calls.push({ command, args, timeout });
    if (args[1] === "boot") state = "Booting";
    if (args[1] === "bootstatus") state = "Booted";
    if (args[1] === "shutdown") state = "Shutdown";
    return {
      stdout: Buffer.from(
        command === "xcode-select"
          ? "/Applications/Xcode.app/Contents/Developer\n"
          : JSON.stringify({
              devices: {
                "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
                  {
                    udid:
                      target.connection.type === "simulator"
                        ? target.connection.udid
                        : "",
                    name: "Apple TV",
                    state,
                    isAvailable: true,
                    ...(includeDataPath ? { dataPath } : {}),
                  },
                  {
                    udid: "different-simulator",
                    name: "Apple TV",
                    state: "Booted",
                    isAvailable: true,
                    dataPath: "/tmp",
                  },
                ],
              },
            }),
      ),
      stderr: "",
    };
  };
  return { execute, calls };
}
test("enrolled Apple profiles verify the exact UDID and allow the watcher to finish", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "simslim-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, "profile.json");
  assert.equal(simulator.connection.type, "simulator");
  const udid = simulator.connection.udid;
  let attempts = 0;
  const waits: number[] = [];
  const execute: typeof run = async (file, args, timeout, options) => {
    assert.equal(options?.env?.HOME, os.userInfo().homedir);
    assert.ok(["/opt/homebrew/bin/simslim", "/usr/local/bin/simslim"].includes(file));
    assert.deepEqual(args, ["verify", udid, "--profile", profile, "--json"]);
    assert.equal(timeout, 5000);
    if (++attempts === 1) throw new Error("verify exited 1");
    return { stdout: Buffer.from(JSON.stringify({ udid: udid.toLowerCase(), ok: true })), stderr: "" };
  };
  const wait = async (ms: number) => { waits.push(ms); };
  await verifySimulatorMemoryProfile(simulator, profile, execute, wait);
  assert.equal(attempts, 0, "unenrolled account skips verification");
  await writeFile(profile, "{}");
  await verifySimulatorMemoryProfile({ ...simulator, kind: "physical" }, profile, execute, wait);
  assert.equal(attempts, 0);
  await verifySimulatorMemoryProfile(simulator, profile, execute, wait);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [3000]);
});
test("Apple profile verification refuses drift, malformed responses and other UDIDs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "simslim-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, "profile.json");
  await writeFile(profile, "{}");
  assert.equal(simulator.connection.type, "simulator");
  const udid = simulator.connection.udid;
  for (const [output, expected] of [
    [JSON.stringify({ udid, ok: false }), 6],
    [JSON.stringify({ udid, ok: 1 }), 6],
    [JSON.stringify({ udid: "other", ok: true }), 1],
    ["invalid JSON", 1],
  ] as const) {
    let attempts = 0;
    await assert.rejects(verifySimulatorMemoryProfile(simulator, profile, async () => {
      attempts++;
      return { stdout: Buffer.from(output), stderr: "" };
    }, async () => {}), /devdeck simulator-profile status/);
    assert.equal(attempts, expected);
  }
});
test("simulator launch boots the configured UDID, waits for readiness, and opens the selected Xcode Simulator", async () => {
  const { execute, calls } = fixture();
  let ownershipRecorded = false;
  const result = await controlSimulator(
    simulator,
    "launch",
    execute,
    async () => {
      assert.equal(calls.some((call) => call.args[1] === "boot"), false);
      ownershipRecorded = true;
    },
  );
  assert.equal(ownershipRecorded, true);
  assert.equal(result.state, "booted");
  assert.equal(result.changed, true);
  assert.deepEqual(
    calls
      .filter((c) => c.args[1] === "boot" || c.args[1] === "bootstatus")
      .map((c) => c.args),
    [
      ["simctl", "boot", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1"],
      ["simctl", "bootstatus", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1", "-b"],
    ],
  );
  assert.deepEqual(calls.find((c) => c.command === "/usr/bin/open")?.args, [
    "-a",
    "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app",
    "--args",
    "-CurrentDeviceUDID",
    "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
  ]);
});
test("simulator launch succeeds with a warning when GUI presentation fails after boot", async () => {
  const base = fixture();
  const execute: typeof run = async (command, args, timeout) => {
    const result = await base.execute(command, args, timeout);
    if (command === "/usr/bin/open")
      throw new Error("The application could not be launched (-600)");
    return result;
  };

  const result = await controlSimulator(simulator, "launch", execute);

  assert.equal(result.state, "booted");
  assert.equal(result.changed, true);
  assert.match(result.warning || "", /booted.*could not open.*-600/);
  assert(base.calls.some((call) => call.command === "/usr/bin/open"));
});
test("parallel simulator launches are not failed by independent GUI presentation errors", async () => {
  const second = deviceSchema.parse({
    ...simulator,
    id: "apple-sim-2",
    name: "Second Apple TV",
    connection: {
      ...simulator.connection,
      udid: "8254E351-B35B-40C6-8B99-F186214B4227",
    },
  });
  const firstFixture = fixture("Shutdown", simulator);
  const secondFixture = fixture("Shutdown", second);
  const failingPresentation = (base: ReturnType<typeof fixture>, message: string): typeof run =>
    async (command, args, timeout) => {
      const result = await base.execute(command, args, timeout);
      if (command === "/usr/bin/open") throw new Error(message);
      return result;
    };

  const results = await Promise.all([
    controlSimulator(
      simulator,
      "launch",
      failingPresentation(firstFixture, "LaunchServices error -600"),
    ),
    controlSimulator(
      second,
      "launch",
      failingPresentation(secondFixture, "Invalid argument EINVAL"),
    ),
  ]);

  assert.deepEqual(
    results.map(({ state, changed }) => ({ state, changed })),
    [
      { state: "booted", changed: true },
      { state: "booted", changed: true },
    ],
  );
  assert.match(results[0].warning || "", /-600/);
  assert.match(results[1].warning || "", /EINVAL/);
});
test("a launch that finished booting succeeds when the short readiness probe is slow", async () => {
  for (const initial of ["Shutdown", "Booted"]) {
    const base = fixture(initial);
    const execute: typeof run = async (command, args, timeout) => {
      // A busy host can exceed the 2-second observation limit after the boot wait completed.
      if (args[1] === "bootstatus" && args.length === 3) throw new Error("Timed out after 2 seconds.");
      return base.execute(command, args, timeout);
    };
    const result = await controlSimulator(simulator, "launch", execute);
    assert.equal(result.state, "booted");
    assert.equal(result.changed, initial === "Shutdown");
  }
});
test("a launch still fails when CoreSimulator does not report the simulator booted", async () => {
  const base = fixture();
  let waited = false;
  const execute: typeof run = async (command, args, timeout) => {
    const result = await base.execute(command, args, timeout);
    if (args[1] === "bootstatus") { waited = true; return result; }
    if (waited && args[1] === "list")
      return { stdout: Buffer.from(result.stdout.toString().replace('"state":"Booted"', '"state":"Shutting Down"')), stderr: "" };
    return result;
  };
  await assert.rejects(controlSimulator(simulator, "launch", execute), /Simulator is stopping/);
});
test("an externally booted simulator remains starting until its system apps are ready", async () => {
  const base = fixture("Booted");
  let ready = false;
  const execute: typeof run = async (command, args, timeout) => {
    if (args[1] === "bootstatus") {
      assert.equal(args.length, 3, "health checks must not use the boot flag");
      assert.equal(timeout, 10000);
      if (!ready) throw new Error("System apps still starting");
    }
    return base.execute(command, args, timeout);
  };
  assert.equal(await simulatorState(simulator, execute), "starting");
  const adapters = new Adapters(() => configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" } }), execute);
  const status = await adapters.inspect(simulator);
  assert.equal(status.online, false);
  assert.equal(status.readiness, "starting");
  assert.deepEqual(status.capabilities, []);
  await assert.rejects(adapters.input(simulator, { key: "Home" }), /still booting/);
  await assert.rejects(adapters.startInteractive(simulator), /still booting/);
  await assert.rejects(wakeSimulator(simulator, "/fixture/idb", execute), /Launch this simulator/);
  ready = true;
  assert.equal(await simulatorState(simulator, execute), "booted");
});
test("simulator launch and close are idempotent without affecting another booted simulator", async () => {
  const booted = fixture("Booted");
  assert.equal(
    (await controlSimulator(simulator, "launch", booted.execute)).changed,
    false,
  );
  assert(!booted.calls.some((c) => c.args[1] === "boot"));
  await controlSimulator(simulator, "close", booted.execute);
  assert.deepEqual(booted.calls.find((c) => c.args[1] === "shutdown")?.args, [
    "simctl",
    "shutdown",
    "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
  ]);
  assert.equal(
    (await controlSimulator(simulator, "close", booted.execute)).changed,
    false,
  );
  assert.equal(booted.calls.filter((c) => c.args[1] === "shutdown").length, 1);
});
test("finishing an externally started simulator does not claim cold-start ownership", async () => {
  const starting = fixture("Booting");
  const result = await controlSimulator(simulator, "launch", starting.execute);
  assert.equal(result.state, "booted");
  assert.equal(result.changed, false);
  assert(!starting.calls.some((call) => call.args[1] === "boot"));
});
test("a simulator whose system app never becomes ready reports launch failure instead of success", async () => {
  const base = fixture();
  const execute: typeof run = async (command, args, timeout) => {
    if (args[1] === "bootstatus") throw new Error("Timed out after 240 seconds.");
    return base.execute(command, args, timeout);
  };
  await assert.rejects(controlSimulator(simulator, "launch", execute), /system screen must be ready.*240 seconds/);
  assert(!base.calls.some((call) => call.command === "/usr/bin/open"));
});
test("missing simulator/runtime and physical or Android targets never reach boot or shutdown", async () => {
  const calls: string[][] = [];
  const missing: typeof run = async (_command, args) => {
    calls.push(args);
    return { stdout: Buffer.from('{"devices":{}}'), stderr: "" };
  };
  assert.equal(await simulatorState(simulator, missing), "unavailable");
  await assert.rejects(
    controlSimulator(simulator, "launch", missing),
    /runtime, or its CoreSimulator data directory is unavailable/,
  );
  await assert.rejects(
    controlSimulator({ ...simulator, kind: "physical" }, "close", missing),
    /configured Apple simulators/,
  );
  await assert.rejects(
    controlSimulator(
      {
        ...simulator,
        connection: { type: "adb", serial: "emulator-5554", port: 5037 },
      },
      "close",
      missing,
    ),
    /configured Apple simulators/,
  );
  assert(calls.every((args) => args[1] === "list"));
});
test("missing or invalid simulator data paths are unavailable before ownership or boot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-simulator-path-"));
  const file = path.join(directory, "not-a-directory");
  await writeFile(file, "fixture");
  try {
    for (const { dataPath, includeDataPath } of [
      { dataPath: undefined, includeDataPath: false },
      { dataPath: "relative/device/data", includeDataPath: true },
      { dataPath: path.join(directory, "missing"), includeDataPath: true },
      { dataPath: file, includeDataPath: true },
    ]) {
      const current = fixture(
        "Shutdown",
        simulator,
        dataPath,
        includeDataPath,
      );
      let ownershipRecorded = false;
      assert.equal(
        await simulatorState(simulator, current.execute),
        "unavailable",
      );
      await assert.rejects(
        controlSimulator(
          simulator,
          "launch",
          current.execute,
          async () => {
            ownershipRecorded = true;
          },
        ),
        /runtime, or its CoreSimulator data directory is unavailable/,
      );
      await assert.rejects(
        controlSimulator(simulator, "close", current.execute),
        /runtime, or its CoreSimulator data directory is unavailable/,
      );
      const adapters = new Adapters(
        () =>
          configSchema.parse({
            schemaVersion: 1,
            settings: { folder: "/tmp/captures" },
          }),
        current.execute,
      );
      try {
        await assert.rejects(
          adapters.restart(simulator),
          /runtime, or its CoreSimulator data directory is unavailable/,
        );
      } finally {
        await adapters.close();
      }
      assert.equal(ownershipRecorded, false);
      assert(
        current.calls.every((call) => call.args[1] === "list"),
        "invalid simulator storage never reaches boot",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("wake sends Home only to the exact running simulator without booting a stopped target", async () => {
  const booted = fixture("Booted");
  assert.deepEqual(
    await wakeSimulator(simulator, "/fixture/idb", booted.execute),
    { method: "Simulator Home button" },
  );
  assert.deepEqual(
    booted.calls.filter((call) => call.command === "/fixture/idb"),
    [
      {
        command: "/fixture/idb",
        args: [
          "ui", "button", "HOME", "--udid",
          "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
        ],
        timeout: undefined,
      },
    ],
  );
  for (const state of ["Shutdown", "Booting", "Shutting Down"]) {
    const stopped = fixture(state);
    await assert.rejects(
      wakeSimulator(simulator, "/fixture/idb", stopped.execute),
      /Launch this simulator before waking it/,
    );
    assert(stopped.calls.every((call) => call.args[1] === "list"));
  }
});

test("idle simulator observations reuse readiness but fresh actions reject a regressed target", async () => {
  let clock = 1000, ready = true, bootstatus = 0, state = "Booted";
  const inventory = new SimulatorInventory(() => clock);
  const execute: typeof run = async (_command, args) => {
    if (args[1] === "bootstatus") {
      bootstatus++;
      if (!ready) throw new Error("Still starting");
      return { stdout: Buffer.from(""), stderr: "" };
    }
    return { stdout: Buffer.from(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [{ udid: simulator.connection.type === "simulator" ? simulator.connection.udid : "", state, isAvailable: true, dataPath: "/tmp" }] } })), stderr: "" };
  };
  assert.equal(await inventory.state(simulator, execute), "booted");
  ready = false;
  clock += 30_000;
  assert.equal(await inventory.state(simulator, execute), "booted", "inventory is explicitly an aged display observation");
  assert.equal(bootstatus, 1, "healthy idle inventory does not rerun startup readiness");
  assert.equal(await simulatorState(simulator, execute), "starting", "action checks cannot use cached readiness");
  state = "Shutdown";
  assert.equal(await inventory.state(simulator, execute), "shutdown");
  state = "Booted";
  assert.equal(await inventory.state(simulator, execute), "starting");
  const before = bootstatus;
  assert.equal(await inventory.state(simulator, execute), "starting");
  assert.equal(bootstatus, before, "failed readiness backs off across reads");
  clock += 5000; ready = true;
  assert.equal(await inventory.state(simulator, execute), "booted");
  inventory.invalidate(simulator.id);
  await inventory.state(simulator, execute);
  assert.equal(bootstatus, before + 2);
});

test("readiness finishing after invalidation cannot restore the old simulator cache", async () => {
  const inventory = new SimulatorInventory();
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let bootstatus = 0;
  const execute: typeof run = async (_command, args) => {
    if (args[1] === "bootstatus") { bootstatus++; entered(); await gate; return { stdout: Buffer.from(""), stderr: "" }; }
    return { stdout: Buffer.from(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [{ udid: simulator.connection.type === "simulator" ? simulator.connection.udid : "", state: "Booted", isAvailable: true, dataPath: "/tmp" }] } })), stderr: "" };
  };
  const pending = inventory.state(simulator, execute);
  await started;
  inventory.invalidate(simulator.id);
  finish(); await pending;
  await inventory.state(simulator, execute);
  assert.equal(bootstatus, 2);
});

function cleanupFixture(initial = "Shutdown", apps: unknown = {
  "com.apple.TVWatchList": { ApplicationType: "System", CFBundleIdentifier: "com.apple.TVWatchList" },
  "com.example.first": { ApplicationType: "User", CFBundleIdentifier: "com.example.first" },
  "com.example.second": { ApplicationType: "User", CFBundleIdentifier: "com.example.second" },
}) {
  const base = fixture(initial);
  const files: string[] = [];
  const listing = '{ "com.example.first" = { ApplicationType = User; }; }';
  const execute: typeof run = async (command, args, timeout) => {
    const result = await base.execute(command, args, timeout);
    if (args[1] === "listapps") return { stdout: Buffer.from(listing), stderr: "" };
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args.slice(0, -1), ["-convert", "json", "-o", "-", "--"]);
      const file = args.at(-1)!;
      assert.equal(await readFile(file, "utf8"), listing);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      files.push(file);
      return { stdout: Buffer.from(JSON.stringify(apps)), stderr: "" };
    }
    return result;
  };
  return { ...base, execute, files };
}

test("app cleanup preserves system apps and settings, targets one UDID, and restores a stopped simulator", async () => {
  const current = cleanupFixture();
  const result = await cleanupSimulator(simulator, "uninstall-apps", current.execute);
  assert.deepEqual(result, { removedApps: 2, state: "shutdown" });
  assert.deepEqual(current.calls.filter((call) => call.args[1] === "uninstall").map((call) => call.args), [
    ["simctl", "uninstall", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1", "com.example.first"],
    ["simctl", "uninstall", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1", "com.example.second"],
  ]);
  assert.equal(current.calls.filter((call) => call.args[1] === "boot").length, 1);
  assert.equal(current.calls.filter((call) => call.args[1] === "shutdown").length, 1);
  for (const call of current.calls.filter((call) => call.command === "xcrun" && call.args[1] !== "list"))
    assert.equal(call.args[2], "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1");
  assert(!current.calls.some((call) => call.command === "/usr/bin/open" || call.args[1] === "erase"));
  for (const file of current.files) await assert.rejects(stat(file), { code: "ENOENT" });
});

test("app cleanup leaves an originally booted simulator running", async () => {
  const current = cleanupFixture("Booted");
  assert.deepEqual(await cleanupSimulator(simulator, "uninstall-apps", current.execute), { removedApps: 2, state: "booted" });
  assert(!current.calls.some((call) => ["boot", "shutdown", "erase"].includes(call.args[1])));
});

test("an empty installed-app list completes with zero removals", async () => {
  const current = cleanupFixture("Shutdown", {});
  assert.deepEqual(await cleanupSimulator(simulator, "uninstall-apps", current.execute), { removedApps: 0, state: "shutdown" });
  assert(!current.calls.some((call) => call.args[1] === "uninstall"));
});

test("partial uninstall reports removed count and failed app, continues other apps, and restores shutdown", async () => {
  const current = cleanupFixture();
  const execute: typeof run = async (command, args, timeout) => {
    const result = await current.execute(command, args, timeout);
    if (args[1] === "uninstall" && args[3] === "com.example.first") throw new Error("Application is busy");
    return result;
  };
  await assert.rejects(cleanupSimulator(simulator, "uninstall-apps", execute), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /Removed 1 of 2.*com.example.first: Application is busy/);
    return true;
  });
  assert.equal(current.calls.filter((call) => call.args[1] === "uninstall").length, 2);
  assert.equal(await simulatorState(simulator, execute), "shutdown");
});

test("ambiguous app metadata fails before any uninstall and restores shutdown", async () => {
  for (const apps of [
    { "com.example.first": { CFBundleIdentifier: "com.example.first" } },
    { "com.example.first": { ApplicationType: "User", CFBundleIdentifier: "com.example.other" } },
    [],
  ]) {
    const current = cleanupFixture("Shutdown", apps);
    await assert.rejects(cleanupSimulator(simulator, "uninstall-apps", current.execute), /Removed 0.*Cleanup failed/);
    assert(!current.calls.some((call) => call.args[1] === "uninstall"));
    assert.equal(await simulatorState(simulator, current.execute), "shutdown");
    for (const file of current.files) await assert.rejects(stat(file), { code: "ENOENT" });
  }
});

test("temporary boot readiness failure closes the simulator without uninstalling apps", async () => {
  const current = cleanupFixture();
  const execute: typeof run = async (command, args, timeout) => {
    if (args[1] === "bootstatus" && args.includes("-b")) throw new Error("Startup timed out");
    return current.execute(command, args, timeout);
  };
  await assert.rejects(cleanupSimulator(simulator, "uninstall-apps", execute), /Removed 0.*Startup timed out/);
  assert(!current.calls.some((call) => ["listapps", "uninstall"].includes(call.args[1])));
  assert.equal(await simulatorState(simulator, execute), "shutdown");
});

test("shutdown restoration failure reports removal counts without claiming cleanup success", async () => {
  const current = cleanupFixture();
  const execute: typeof run = async (command, args, timeout) => {
    if (args[1] === "shutdown") throw new Error("CoreSimulator unavailable during shutdown");
    return current.execute(command, args, timeout);
  };
  await assert.rejects(cleanupSimulator(simulator, "uninstall-apps", execute), /Removed 2 of 2.*Could not restore.*CoreSimulator unavailable/);
  assert.equal(await simulatorState(simulator, execute), "booted");
});

test("reset shuts down and erases only the configured simulator, leaving it stopped", async () => {
  for (const initial of ["Booted", "Shutdown"]) {
    const current = cleanupFixture(initial);
    assert.deepEqual(await cleanupSimulator(simulator, "reset", current.execute), { state: "shutdown" });
    const mutations = current.calls.filter((call) => ["shutdown", "erase"].includes(call.args[1])).map((call) => call.args);
    assert.deepEqual(mutations, [
      ...(initial === "Booted" ? [["simctl", "shutdown", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1"]] : []),
      ["simctl", "erase", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1"],
    ]);
    assert(!current.calls.some((call) => ["boot", "listapps", "uninstall"].includes(call.args[1]) || call.command === "/usr/bin/open"));
  }
});

test("reset never erases after failed shutdown and propagates erase failures", async () => {
  const booted = cleanupFixture("Booted");
  const failedShutdown: typeof run = async (command, args, timeout) => {
    if (args[1] === "shutdown") throw new Error("Shutdown refused");
    return booted.execute(command, args, timeout);
  };
  await assert.rejects(cleanupSimulator(simulator, "reset", failedShutdown), /Shutdown refused/);
  assert(!booted.calls.some((call) => call.args[1] === "erase"));
  const stopped = cleanupFixture();
  const failedErase: typeof run = async (command, args, timeout) => {
    if (args[1] === "erase") throw new Error("Erase failed");
    return stopped.execute(command, args, timeout);
  };
  await assert.rejects(cleanupSimulator(simulator, "reset", failedErase), /Erase failed/);
});

test("slimming verifies the exact UDID and restores its original boot state", async () => {
  const udid = "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1";
  for (const initial of ["Shutdown", "Booted"]) {
    const device = fixture(initial);
    const commands: string[][] = [];
    const execute: typeof run = async (command, args, timeout, options) => {
      if (command === "simslim") {
        assert.equal(options?.env?.HOME, os.userInfo().homedir);
        commands.push(args);
        if (initial === "Shutdown" && args[0] === "on")
          await device.execute("xcrun", ["simctl", "bootstatus", udid]);
        return { stdout: Buffer.alloc(0), stderr: "" };
      }
      return device.execute(command, args, timeout);
    };
    const result = await cleanupSimulator(simulator, "slim", execute);
    assert.deepEqual(result, { state: initial.toLowerCase() });
    assert.deepEqual(commands, [
      ["on", udid, "--except", "store,web,icloud", ...(initial === "Booted" ? ["--no-reboot"] : [])],
      ["verify", udid, "--except", "store,web,icloud"],
    ]);
    assert.equal(device.calls.some(({ args }) => args[1] === "shutdown"), initial === "Shutdown");
    assert(!device.calls.some(({ args }) => ["uninstall", "erase"].includes(args[1])));
  }
});

test("a live simulator with a stricter profile regains QA services without rebooting", async () => {
  const device = fixture("Booted");
  const udid = "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1";
  let enabled = false;
  let verified = 0;
  const execute: typeof run = async (command, args, timeout, options) => {
    if (command === "simslim") {
      assert.equal(options?.env?.HOME, os.userInfo().homedir);
      if (args[0] === "verify" && !enabled) throw new Error("Managed service disabled beyond profile");
      if (args[0] === "enable") {
        assert.deepEqual(args, ["enable", udid, "store,web,icloud"]);
        enabled = true;
      }
      if (args[0] === "verify") verified++;
      return { stdout: Buffer.alloc(0), stderr: "" };
    }
    return device.execute(command, args, timeout);
  };
  assert.deepEqual(await cleanupSimulator(simulator, "slim", execute), { state: "booted" });
  assert.equal(verified, 1);
  assert(!device.calls.some(({ args }) => args[1] === "shutdown"));
});

test("a profile verification failure still closes a simulator booted for slimming", async () => {
  const device = fixture();
  const execute: typeof run = async (command, args, timeout) => {
    if (command === "simslim" && args[0] === "on")
      return device.execute("xcrun", ["simctl", "bootstatus", args[1]]);
    if (command === "simslim" && args[0] === "verify") throw new Error("Profile drift");
    return device.execute(command, args, timeout);
  };
  await assert.rejects(cleanupSimulator(simulator, "slim", execute), /Profile drift/);
  assert.equal(await simulatorState(simulator, device.execute), "shutdown");
});

test("cleanup rejects physical, alias, unavailable, and transitioning targets before mutation", async () => {
  for (const action of ["uninstall-apps", "reset", "slim"] as const) {
    for (const target of [
      { ...simulator, kind: "physical" as const },
      { ...simulator, connection: { type: "simulator" as const, os: "tvos" as const, udid: "all" } },
      { ...simulator, connection: { type: "simulator" as const, os: "tvos" as const, udid: "booted" } },
    ]) {
      const current = cleanupFixture();
      await assert.rejects(cleanupSimulator(target, action, current.execute), /exact UDID/);
      assert.equal(current.calls.length, 0);
    }
    for (const state of ["Booting", "Shutting Down", "Unknown"]) {
      const current = cleanupFixture(state);
      await assert.rejects(cleanupSimulator(simulator, action, current.execute), /Wait for it to finish|unavailable/);
      assert(current.calls.every((call) => call.args[1] === "list"));
    }
    const unavailable = fixture("Shutdown", simulator, "missing-directory");
    await assert.rejects(cleanupSimulator(simulator, action, unavailable.execute), /unavailable/);
    assert(unavailable.calls.every((call) => call.args[1] === "list"));
  }
});
