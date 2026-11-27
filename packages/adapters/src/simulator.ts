import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fail, type DeviceCleanupAction, type DeviceConfig } from "../../core/src/local/types";
import { available, run } from "./process";
import { idbInput, type IdbInput } from "./idb-input";

export type SimulatorState =
  "booted" | "shutdown" | "starting" | "stopping" | "unavailable";
export const SIMULATOR_UNAVAILABLE_MESSAGE =
  "This simulator, its runtime, or its CoreSimulator data directory is unavailable. Check runner storage and Xcode, then rediscover devices.";
export const READINESS_PROBE_MS = 10000;
type Runner = typeof run;
type SimctlDevice = {
  udid?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  dataPath?: unknown;
};
type SimctlDeviceList = {
  devices?: Record<string, unknown>;
};
async function availableDataPath(value: unknown) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

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
  ) as SimctlDeviceList;
  const connection = device.connection;
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    if (!Array.isArray(devices)) continue;
    const found = (devices as SimctlDevice[]).find(
      (entry) =>
        typeof entry?.udid === "string" &&
        entry.udid.toLowerCase() === connection.udid.toLowerCase(),
    );
    if (!found) continue;
    if (
      found.isAvailable === false ||
      !(connection.os === "tvos" ? /tvOS/ : /iOS/).test(runtime) ||
      !(await availableDataPath(found.dataPath))
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
        // A ready simulator answers in well under a second, but a busy host
        // can take several; a short limit refuses input to a ready device.
        await execute("xcrun", ["simctl", "bootstatus", connection.udid], READINESS_PROBE_MS);
        return "booted";
      } catch { return "starting"; }
    }
    return typeof found.state === "string"
      ? states[found.state] || "unavailable"
      : "unavailable";
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

// simslim uses HOME to locate CoreSimulator device sets, including in CI jobs with a temporary HOME.
const simulatorOwnerEnvironment = () => ({ env: { HOME: os.userInfo().homedir } });

/** Verify the enrolled account's profile using the exact simulator handed to the caller. */
export async function verifySimulatorMemoryProfile(
  device: DeviceConfig,
  profile: string | undefined,
  execute: Runner = run,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  if (!profile || device.kind !== "virtual" || device.connection.type !== "simulator") return;
  try {
    if (!(await stat(profile)).isFile()) throw new Error("Expected a regular profile file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("simulator-memory-profile", `Cannot read the simulator memory profile at ${profile}: ${(error as Error).message}`, 503);
  }
  const { udid } = device.connection;
  const binary = await available("/opt/homebrew/bin/simslim") ? "/opt/homebrew/bin/simslim" : "/usr/local/bin/simslim";
  const options = simulatorOwnerEnvironment();
  let detail = "The reported profile does not match.";
  for (let attempt = 0; attempt < 6; attempt++) {
    let output: Buffer | undefined;
    try {
      output = (await execute(binary, ["verify", udid, "--profile", profile, "--json"], 5000, options)).stdout;
    } catch (error) {
      detail = (error as Error).message;
      if (/ENOENT|EACCES/.test(detail)) break;
    }
    if (output) {
      let result: { ok?: unknown; udid?: unknown } | undefined;
      try {
        result = JSON.parse(output.toString());
      } catch {
        detail = "The helper returned invalid JSON.";
        break;
      }
      if (typeof result?.udid !== "string" || result.udid.toLowerCase() !== udid.toLowerCase()) {
        detail = "The helper did not confirm the requested UDID.";
        break;
      }
      if (result.ok === true) return { kind: "apple-simslim" as const, udid };
      detail = "The helper reported profile drift.";
    }
    if (attempt < 5) await wait(3000);
  }
  fail("simulator-memory-profile", `Could not verify the simslim profile for ${device.name} (${udid}). Check the host watcher with devdeck simulator-profile status and run simslim verify for this UDID. ${detail}`, 503);
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
      SIMULATOR_UNAVAILABLE_MESSAGE,
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
  // A launch has just waited for `bootstatus -b`. Repeating the 2-second
  // readiness probe here fails a finished boot whenever the host is busy.
  const current = await simulatorState(device, execute, action !== "launch");
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
  input: IdbInput = idbInput,
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
  await input.run(idb, ["ui", "button", "HOME", "--udid", device.connection.udid], { execute });
  return { method: "Simulator Home button" };
}

export async function userInstalledSimulatorApps(udid: string, execute: Runner) {
  const listing = await execute("xcrun", ["simctl", "listapps", udid], 60000);
  // listapps writes a property list, not JSON. Let Apple's parser handle its
  // quoting and escapes; a private file avoids interpolating app data in a shell.
  const directory = await mkdtemp(path.join(os.tmpdir(), "devdeck-simulator-apps-"));
  let apps: unknown;
  try {
    const file = path.join(directory, "apps.plist");
    await writeFile(file, listing.stdout, { mode: 0o600 });
    apps = JSON.parse((await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", file])).stdout.toString());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (!apps || typeof apps !== "object" || Array.isArray(apps))
    fail("simulator-app-list-invalid", "Simulator returned an invalid installed-app list.", 502);
  const identifiers: string[] = [];
  for (const [identifier, metadata] of Object.entries(apps)) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        !("ApplicationType" in metadata) || typeof metadata.ApplicationType !== "string")
      fail("simulator-app-list-invalid", "Simulator app metadata does not identify installed-app types. No apps were removed.", 502);
    if (metadata.ApplicationType !== "User") continue;
    if (!("CFBundleIdentifier" in metadata) || metadata.CFBundleIdentifier !== identifier ||
        !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(identifier))
      fail("simulator-app-list-invalid", "Simulator returned an invalid user-app identifier. No apps were removed.", 502);
    identifiers.push(identifier);
  }
  return identifiers.sort();
}

async function shutdownSimulatorForCleanup(device: DeviceConfig, udid: string, execute: Runner) {
  try {
    await execute("xcrun", ["simctl", "shutdown", udid], 60000);
  } catch (error) {
    if ((await simulatorState(device, execute, false)) !== "shutdown") throw error;
  }
  const state = await simulatorState(device, execute, false);
  if (state !== "shutdown")
    fail("simulator-transition", `Simulator is ${state}; shutdown could not be verified.`, 409);
}

/** Run maintenance against one exact simulator without presenting its UI. */
export async function cleanupSimulator(
  device: DeviceConfig,
  action: DeviceCleanupAction,
  execute: Runner = run,
  keepApps?: ReadonlySet<string>,
): Promise<{ removedApps?: number; state?: "booted" | "shutdown"; warning?: string }> {
  if (device.kind !== "virtual" || device.connection.type !== "simulator" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device.connection.udid))
    fail("unsupported-cleanup", "Cleanup requires one configured Apple simulator with an exact UDID.");
  if (action !== "uninstall-apps" && action !== "reset" && action !== "slim")
    fail("unsupported-cleanup", "Unknown simulator maintenance action.");
  const udid = device.connection.udid;
  const initial = await simulatorState(device, execute);
  if (initial === "unavailable")
    fail("simulator-unavailable", SIMULATOR_UNAVAILABLE_MESSAGE, 409);
  if (initial !== "booted" && initial !== "shutdown")
    fail("simulator-transition", `Simulator is ${initial}. Wait for it to finish before cleanup.`, 409);

  if (action === "slim") {
    // Keep account, purchase, push, media and associated-domain services available for QA.
    const options = simulatorOwnerEnvironment();
    const keep = "store,web,icloud";
    const verify = ["verify", udid, "--except", keep];
    try {
      const mode = initial === "booted" ? ["--no-reboot"] : [];
      await execute("simslim", ["on", udid, "--except", keep, ...mode], 660000, options);
      try {
        await execute("simslim", verify, 30000, options);
      } catch (error) {
        if (initial !== "booted") throw error;
        // Live slimming only adds disables. An older profile can still have our kept services disabled.
        await execute("simslim", ["enable", udid, keep], 660000, options);
        await execute("simslim", verify, 30000, options);
      }
    } finally {
      if (initial === "shutdown" && await simulatorState(device, execute, false) !== "shutdown")
        await shutdownSimulatorForCleanup(device, udid, execute);
    }
    return { state: initial };
  }

  if (action === "reset") {
    if (initial === "booted") await shutdownSimulatorForCleanup(device, udid, execute);
    await execute("xcrun", ["simctl", "erase", udid], 120000);
    const state = await simulatorState(device, execute, false);
    if (state !== "shutdown")
      fail("simulator-transition", `Simulator erase finished, but its state is ${state}; shutdown could not be verified.`, 409);
    return { state: "shutdown" };
  }

  let ownsBoot = false, removedApps = 0;
  let totalApps: number | undefined;
  let operationError: unknown, restorationError: unknown;
  const failedApps: { appId: string; error: string }[] = [];
  try {
    if (initial === "shutdown") {
      await execute("xcrun", ["simctl", "boot", udid]);
      ownsBoot = true;
      await execute("xcrun", ["simctl", "bootstatus", udid, "-b"], 240000);
    }
    const apps = (await userInstalledSimulatorApps(udid, execute)).filter(id => !keepApps?.has(id));
    totalApps = apps.length;
    for (const appId of apps) {
      try {
        await execute("xcrun", ["simctl", "uninstall", udid, appId], 60000);
        removedApps++;
      } catch (error) {
        failedApps.push({ appId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (ownsBoot) {
      try { await shutdownSimulatorForCleanup(device, udid, execute); }
      catch (error) { restorationError = error; }
    }
  }
  if (operationError || restorationError || failedApps.length) {
    const errors = [
      operationError instanceof Error ? operationError.message : operationError ? String(operationError) : "",
      ...failedApps.map(({ appId, error }) => `${appId}: ${error}`),
      restorationError ? `Could not restore the simulator to shutdown: ${restorationError instanceof Error ? restorationError.message : String(restorationError)}` : "",
    ].filter(Boolean);
    fail("simulator-cleanup-failed", `Removed ${removedApps}${totalApps === undefined ? "" : ` of ${totalApps}`} user-installed apps from ${device.name}. Cleanup failed: ${errors.join("; ")}`, 502,
      { removedApps, totalApps, failedApps, expectedState: initial });
  }
  const state = await simulatorState(device, execute);
  if (state !== initial)
    fail("simulator-cleanup-failed", `Removed ${removedApps} user-installed apps, but the simulator is ${state}; expected ${initial}.`, 502,
      { removedApps, expectedState: initial, state });
  return { removedApps, state: initial };
}
