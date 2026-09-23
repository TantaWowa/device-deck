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
  checkReadiness = true,
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
    if (found.state === "Booted" && checkReadiness) {
      try {
        // CoreSimulator reports Booted before SpringBoard finishes startup.
        // Without -b this only observes the exact UDID; it cannot boot a device.
        await execute("xcrun", ["simctl", "bootstatus", connection.udid], 2000);
        return "booted";
      } catch { return "starting"; }
    }
    return states[found.state] || "unavailable";
  }
  return "unavailable";
}

/** Display observations only. Action admission always uses simulatorState fresh. */
export class SimulatorInventory {
  private ready = new Map<string, { identity: string; nextRetry: number; failures: number; ready: boolean }>();
  private generation = 0;
  constructor(private now = Date.now) {}
  invalidate(deviceId?: string) {
    this.generation++;
    if (deviceId) this.ready.delete(deviceId);
    else this.ready.clear();
  }
  async state(device: DeviceConfig, execute: Runner = run): Promise<SimulatorState> {
    const generation = this.generation;
    const state = await simulatorState(device, execute, false);
    if (generation !== this.generation) return state === "booted" ? "starting" : state;
    if (state !== "booted") { this.ready.delete(device.id); return state; }
    const identity = JSON.stringify(device.connection);
    const previous = this.ready.get(device.id);
    if (previous?.identity === identity) {
      if (previous.ready) return "booted";
      if (previous.nextRetry > this.now()) return "starting";
    }
    if (device.connection.type !== "simulator") return "unavailable";
    try {
      await execute("xcrun", ["simctl", "bootstatus", device.connection.udid], 2000);
      if (generation === this.generation) this.ready.set(device.id, { identity, nextRetry: 0, failures: 0, ready: true });
      return "booted";
    } catch {
      const failures = previous?.identity === identity ? previous.failures + 1 : 1;
      const delay = [5000, 15000, 30000, 60000][Math.min(failures - 1, 3)];
      if (generation === this.generation) this.ready.set(device.id, { identity, nextRetry: this.now() + delay, failures, ready: false });
      return "starting";
    }
  }
}

export async function controlSimulator(
  device: DeviceConfig,
  action: "launch" | "close",
  execute: Runner = run,
  beforeLaunch?: () => Promise<void>,
) {
  let presentationWarning: string | undefined;
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
      await beforeLaunch?.();
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
    try {
      // A first iOS boot can spend several minutes starting SpringBoard.
      await execute("xcrun", ["simctl", "bootstatus", udid, "-b"], 240000);
    } catch (error) {
      fail("simulator-not-ready", `${device.name} did not finish starting. Its system screen must be ready before opening the feed. Wait for Simulator to finish, then open its feed, or close and relaunch this simulator from Devices. ${(error as Error).message}`, 502);
    }
    try {
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
    } catch (error) {
      // CoreSimulator lifecycle is independent of GUI presentation. In
      // headless sessions (and when several simulators start together), macOS
      // can reject `open` even though the exact simulator is fully booted.
      presentationWarning = `${device.name} is booted, but Device Deck could not open its Simulator window: ${(error as Error).message}`;
    }
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
    changed:
      action === "launch" ? state === "shutdown" : state !== "shutdown",
    ...(presentationWarning ? { warning: presentationWarning } : {}),
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
