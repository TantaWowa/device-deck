import test from "node:test";
import assert from "node:assert/strict";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { Adapters } from "./index";
import { controlSimulator, simulatorState, wakeSimulator } from "./simulator";
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
function fixture(initial = "Shutdown") {
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
                      simulator.connection.type === "simulator"
                        ? simulator.connection.udid
                        : "",
                    name: "Apple TV",
                    state,
                    isAvailable: true,
                  },
                  {
                    udid: "different-simulator",
                    name: "Apple TV",
                    state: "Booted",
                    isAvailable: true,
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
test("simulator launch boots the configured UDID, waits for readiness, and opens the selected Xcode Simulator", async () => {
  const { execute, calls } = fixture();
  const result = await controlSimulator(simulator, "launch", execute);
  assert.equal(result.state, "booted");
  assert.equal(result.changed, true);
  assert.deepEqual(
    calls
      .filter((c) => c.args[1] === "boot" || c.args[1] === "bootstatus")
      .map((c) => c.args),
    [
      ["simctl", "boot", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1"],
      ["simctl", "bootstatus", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1", "-b"],
      ["simctl", "bootstatus", "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1"],
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
test("an externally booted simulator remains starting until its system apps are ready", async () => {
  const base = fixture("Booted");
  let ready = false;
  const execute: typeof run = async (command, args, timeout) => {
    if (args[1] === "bootstatus") {
      assert.equal(args.length, 3, "health checks must not use the boot flag");
      assert.equal(timeout, 2000);
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
    /runtime is unavailable/,
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
