import path from "node:path";
import { fail, type DeviceConfig } from "../../core/src/local/types";
import { run } from "./process";

export type SimulatorState =
  "booted" | "shutdown" | "starting" | "stopping" | "unavailable";
type Runner = typeof run;

/** Every command targets one configured UDID; never use simctl's `all` or `booted` aliases. */
export async function simulatorState(
  device: DeviceConfig,
  execute: Runner = run,
): Promise<SimulatorState> {
  if (device.connection.type !== "simulator" || device.kind !== "virtual")
    fail(
      "unsupported-lifecycle",
      "Launch and close are supported for configured Apple simulators.",
    );
  const data = JSON.parse(
    (
      await execute("xcrun", ["simctl", "list", "devices", "--json"])
    ).stdout.toString(),
  );
  const connection = device.connection;
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    const found = (
      devices as { udid: string; state: string; isAvailable?: boolean }[]
    ).find(
      (entry) => entry.udid.toLowerCase() === connection.udid.toLowerCase(),
    );
    if (!found) continue;
    if (
      found.isAvailable === false ||
      !(connection.os === "tvos" ? /tvOS/ : /iOS/).test(runtime)
    )
      return "unavailable";
    const states: Record<string, SimulatorState> = {
      Booted: "booted",
      Shutdown: "shutdown",
      Booting: "starting",
      "Shutting Down": "stopping",
    };
    return states[found.state] || "unavailable";
  }
  return "unavailable";
}

export async function controlSimulator(
  device: DeviceConfig,
  action: "launch" | "close",
  execute: Runner = run,
) {
  const state = await simulatorState(device, execute);
  if (device.connection.type !== "simulator")
    fail("unsupported-lifecycle", "This is not an Apple simulator.");
  if (state === "unavailable")
    fail(
      "simulator-unavailable",
      "This simulator or its runtime is unavailable. Install its runtime in Xcode, then rediscover devices.",
      409,
    );
  const udid = device.connection.udid;
  if (action === "launch") {
    if (state === "stopping")
      fail(
        "simulator-transition",
        "Simulator is shutting down. Wait a moment and launch again.",
        409,
      );
    if (state === "shutdown") {
      try {
        await execute("xcrun", ["simctl", "boot", udid]);
      } catch (error) {
        // A launch from Xcode may race us; only accept the exact simulator becoming booted.
        if (
          !(["booted", "starting"] as SimulatorState[]).includes(
            await simulatorState(device, execute),
          )
        )
          throw error;
      }
    }
    await execute("xcrun", ["simctl", "bootstatus", udid, "-b"], 120000);
    const developer = (await execute("xcode-select", ["-p"])).stdout
      .toString()
      .trim();
    await execute("/usr/bin/open", [
      "-a",
      path.join(developer, "Applications/Simulator.app"),
      "--args",
      "-CurrentDeviceUDID",
      udid,
    ]);
  } else if (state !== "shutdown") {
    try {
      await execute("xcrun", ["simctl", "shutdown", udid], 60000);
    } catch (error) {
      if ((await simulatorState(device, execute)) !== "shutdown") throw error;
    }
  }
  const current = await simulatorState(device, execute);
  const expected = action === "launch" ? "booted" : "shutdown";
  if (current !== expected)
    fail(
      "simulator-transition",
      `Simulator is ${current}. Refresh its status before trying again.`,
      409,
    );
  return {
    deviceId: device.id,
    action,
    state: current,
    changed: state !== expected,
  };
}

export async function wakeSimulator(
  device: DeviceConfig,
  idb: string,
  execute: Runner = run,
) {
  if ((await simulatorState(device, execute)) !== "booted")
    fail(
      "simulator-not-running",
      "Launch this simulator before waking it.",
      409,
    );
  if (device.connection.type !== "simulator")
    fail("unsupported-capability", "This is not an Apple simulator.");
  // HOME is intentional: LOCK and SIDE_BUTTON can put an awake screen to sleep.
  await execute(idb, ["ui", "button", "HOME", "--udid", device.connection.udid]);
  return { method: "Simulator Home button" };
}
