import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { run, available } from "./process";
import { androidBootReady, androidDisplayReady } from "./android-state";
import {
  DeckError,
  fail,
  type Config,
  type DeviceConfig,
  type SimulatorLaunchOwnership,
} from "../../core/src/local/types";
const emulatorSerial = /^emulator-\d+$/;
const avdName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const launchMarker = /^[a-f0-9]{32}$/;
const launchProperty = "qemu.devdeck_launch";
type Runner = typeof run;
export const isAndroidEmulator = (d: DeviceConfig) =>
  d.kind === "virtual" &&
  d.connection.type === "adb" &&
  Boolean(d.connection.avdName || emulatorSerial.test(d.connection.serial));
export class AndroidEmulators {
  private readyBoots = new Map<string, string>();
  constructor(
    private config: () => Config,
    private execute: Runner = run,
    private has = available,
    private launch = (binary: string, args: string[], port: number) => {
      const child = spawn(binary, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) },
      });
      let error: string | undefined;
      child.once("error", (e) => (error = e.message));
      child.once(
        "exit",
        (code) => (error = `Emulator process exited (${code}).`),
      );
      child.unref();
      return () => error;
    },
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    private signal = (pid: number, signal: NodeJS.Signals) =>
      process.kill(pid, signal),
  ) {}
  adb() {
    return this.config().tools.adb || "adb";
  }
  async binary() {
    const configured = this.config().tools.emulator;
    if (configured) {
      if (await this.has(configured)) return configured;
      fail(
        "emulator-missing",
        "Configured Android emulator executable is unavailable. Check Settings.",
      );
    }
    const roots = [
      process.env.ANDROID_SDK_ROOT,
      process.env.ANDROID_HOME,
      path.join(os.homedir(), "Library/Android/sdk"),
      path.join(os.homedir(), "Android/Sdk"),
    ].filter(Boolean) as string[];
    const binaries = [
      ...roots.map((root) => path.join(root, "emulator/emulator")),
      ...(path.isAbsolute(this.adb())
        ? [path.resolve(path.dirname(this.adb()), "../emulator/emulator")]
        : []),
      "emulator",
    ];
    for (const candidate of binaries)
      if (await this.has(candidate)) return candidate;
    fail(
      "emulator-missing",
      "Android emulator executable not found. Set its existing SDK path in Settings → Adapter executables.",
    );
  }
  async names(execute = this.execute) {
    return [
      ...new Set(
        (await execute(await this.binary(), ["-list-avds"])).stdout
          .toString()
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => avdName.test(s)),
      ),
    ];
  }
  async running(port: number, execute = this.execute) {
    const data = (
      await execute(this.adb(), ["-P", String(port), "devices"])
    ).stdout.toString();
    const result: { serial: string; state: string; avdName?: string }[] = [];
    for (const line of data.split(/\r?\n/)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (
        !emulatorSerial.test(serial || "") ||
        !["device", "offline", "unauthorized"].includes(state)
      )
        continue;
      let name: string | undefined;
      try {
        name = (
          await execute(
            this.adb(),
            ["-P", String(port), "-s", serial, "emu", "avd", "name"],
            3000,
          )
        ).stdout
          .toString()
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => avdName.test(s) && s !== "OK");
      } catch {}
      if (!name) {
        try {
          // Some SDK versions return success with no console output. The
          // immutable boot property identifies the AVD on this same transport.
          const bootName = (
            await execute(
              this.adb(),
              [
                "-P",
                String(port),
                "-s",
                serial,
                "shell",
                "getprop",
                "ro.boot.qemu.avd_name",
              ],
              3000,
            )
          ).stdout
            .toString()
            .trim();
          if (bootName.length <= 256 && avdName.test(bootName)) name = bootName;
        } catch {}
      }
      result.push({ serial, state, ...(name ? { avdName: name } : {}) });
    }
    return result;
  }
  private async locate(d: DeviceConfig, execute = this.execute) {
    if (!isAndroidEmulator(d) || d.connection.type !== "adb")
      fail("unsupported-lifecycle", "This target is not an Android emulator.");
    const c = d.connection;
    const entries = await this.running(c.port, execute);
    const matches = entries.filter((entry) =>
      c.avdName ? entry.avdName === c.avdName : entry.serial === c.serial,
    );
    if (matches.length > 1)
      fail(
        "ambiguous-emulator",
        "Multiple running emulator instances use this AVD. Close duplicates in Android Studio before controlling it.",
        409,
      );
    const found = matches[0];
    if (!c.avdName && found?.avdName) {
      const owner = this.config().devices.find(
        (candidate) => candidate.id !== d.id &&
          candidate.connection.type === "adb" &&
          candidate.connection.avdName === found.avdName,
      );
      if (owner)
        fail(
          "emulator-identity-mismatch",
          `This saved emulator connection now belongs to ${owner.name} (${found.avdName}). Select that device, or configure this device's exact AVD name before controlling it.`,
          409,
        );
    }
    if (
      !found &&
      c.avdName &&
      entries.some((entry) => !entry.avdName)
    )
      fail(
        "emulator-identity-pending",
        "An emulator connection is present but its AVD identity is not available yet. Wait and refresh before launching or closing it.",
        409,
      );
    return found;
  }
  private resolved(
    d: DeviceConfig,
    found: { serial: string; avdName?: string },
  ): DeviceConfig {
    if (d.connection.type !== "adb") return d;
    return {
      ...d,
      connection: {
        ...d.connection,
        serial: found.serial,
        ...(found.avdName ? { avdName: found.avdName } : {}),
      },
    };
  }
  async resolve(
    d: DeviceConfig,
    required = true,
    execute = this.execute,
  ): Promise<DeviceConfig | undefined> {
    if (!isAndroidEmulator(d)) return d;
    const found = await this.locate(d, execute);
    if (found && !found.avdName && required)
      fail(
        "emulator-identity-pending",
        "This emulator's AVD identity is not available yet. Wait and refresh before controlling it.",
        409,
      );
    if (!found || found.state !== "device") {
      if (required)
        fail(
          "emulator-offline",
          "This Android emulator is stopped or still starting. Launch it and wait for boot to finish.",
          409,
        );
      return undefined;
    }
    const resolved = this.resolved(d, found);
    if (required && resolved.connection.type === "adb" && !(await androidBootReady(this.adb(), ["-P", String(resolved.connection.port), "-s", resolved.connection.serial], execute)))
      fail("emulator-not-ready", "This Android emulator is still booting. Wait for its system screen before using its feed or controls.", 409);
    return resolved;
  }
  async prepare(d: DeviceConfig) {
    const found = await this.locate(d);
    if (found && !found.avdName)
      fail(
        "emulator-identity-pending",
        "This emulator's AVD identity is not available yet. Wait and refresh before launching or closing it.",
        409,
      );
    // Persist the AVD identity, never its temporary console-port serial. A
    // stopped AVD may boot on a port saved by a different legacy device row.
    return found?.avdName && d.connection.type === "adb" && !d.connection.avdName
      ? { ...d, connection: { ...d.connection, avdName: found.avdName } }
      : d;
  }
  async inspect(d: DeviceConfig, execute = this.execute) {
    const found = await this.locate(d, execute);
    if (!found) {
      if (
        d.connection.type === "adb" &&
        d.connection.avdName &&
        !(await this.names(execute)).includes(d.connection.avdName)
      )
        return { state: "unavailable" as const };
      return { state: "shutdown" as const };
    }
    const resolved = this.resolved(d, found);
    if (found.state !== "device" || resolved.connection.type !== "adb") {
      this.readyBoots.delete(d.id);
      return { state: "starting" as const, resolved };
    }
    const booted = await this.displayReady(resolved, execute);
    return {
      state: booted ? ("booted" as const) : ("starting" as const),
      resolved,
    };
  }
  private async displayReady(d: DeviceConfig, execute = this.execute) {
    if (d.connection.type !== "adb") return false;
    const args = ["-P", String(d.connection.port), "-s", d.connection.serial];
    if (!(await androidBootReady(this.adb(), args, execute))) {
      this.readyBoots.delete(d.id);
      return false;
    }
    // A kernel boot ID changes across reboot, including a complete reboot
    // between two health polls. Validate the expensive screenshot once per boot.
    const bootId = (await execute(this.adb(), [...args, "shell", "cat", "/proc/sys/kernel/random/boot_id"], 3000).catch(() => ({ stdout: Buffer.from("") }))).stdout.toString().trim();
    const identity = /^[\da-f-]{36}$/i.test(bootId) ? `${d.connection.port}:${d.connection.serial}:${bootId}` : undefined;
    if (identity && this.readyBoots.get(d.id) === identity) return true;
    this.readyBoots.delete(d.id);
    if (!(await androidDisplayReady(this.adb(), args, execute))) return false;
    if (identity) this.readyBoots.set(d.id, identity);
    return true;
  }
  private validateOwnership(
    d: DeviceConfig,
    ownership: SimulatorLaunchOwnership,
  ) {
    const configuredName = d.connection.type === "adb"
      ? d.connection.avdName
      : undefined;
    if (
      ownership.type !== "android-emulator" ||
      !launchMarker.test(ownership.marker) ||
      !avdName.test(ownership.avdName) ||
      ownership.avdName !== configuredName
    )
      fail(
        "emulator-ownership-invalid",
        "The saved Android emulator launch identity does not match this configured AVD. Cleanup will not stop an unverified process.",
        409,
      );
    return ownership;
  }
  private async ownedProcess(
    d: DeviceConfig,
    ownership: SimulatorLaunchOwnership,
  ) {
    const owned = this.validateOwnership(d, ownership);
    const listing = await this.execute("/bin/ps", [
      "-axo",
      "pid=,command=",
    ]);
    const escapedName = owned.avdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const property = `${launchProperty}=${owned.marker}`;
    const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`(?:^|\\s)-avd\\s+${escapedName}(?:\\s|$)`);
    const markerPattern = new RegExp(
      `(?:^|\\s)-prop\\s+${escapedProperty}(?:\\s|$)`,
    );
    const matches = listing.stdout
      .toString()
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match && namePattern.test(match[2]) && markerPattern.test(match[2])
          ? [Number(match[1])]
          : [];
      });
    if (matches.length > 1)
      fail(
        "ambiguous-owned-emulator",
        "Multiple emulator processes present the same Device Deck launch marker. Cleanup will not guess which process to stop.",
        409,
      );
    return matches[0];
  }
  private async closeOwnedProcess(
    d: DeviceConfig,
    ownership: SimulatorLaunchOwnership,
  ) {
    const pid = await this.ownedProcess(d, ownership);
    if (!pid) return false;
    try {
      this.signal(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (let attempt = 0; attempt < 80; attempt++) {
      if (!(await this.ownedProcess(d, ownership))) return true;
      await this.sleep(100);
    }
    const remainingPid = await this.ownedProcess(d, ownership);
    if (!remainingPid) return true;
    try {
      // The original PID may have exited and been reused while graceful
      // shutdown was pending. Signal only a process that still presents the
      // exact durable marker immediately before escalation.
      this.signal(remainingPid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await this.sleep(100);
    if (await this.ownedProcess(d, ownership))
      fail(
        "emulator-transition",
        "The Android emulator process owned by this reservation group is still closing. Retry release.",
        409,
      );
    return true;
  }
  private async currentOwnershipMarker(
    d: DeviceConfig,
    serial: string,
    ownership: SimulatorLaunchOwnership,
  ) {
    this.validateOwnership(d, ownership);
    if (d.connection.type !== "adb") return undefined;
    try {
      const marker = (
        await this.execute(
          this.adb(),
          [
            "-P",
            String(d.connection.port),
            "-s",
            serial,
            "shell",
            "getprop",
            launchProperty,
          ],
          3000,
        )
      ).stdout.toString().trim();
      return launchMarker.test(marker) ? marker : undefined;
    } catch {
      return undefined;
    }
  }
  async control(
    d: DeviceConfig,
    action: "launch" | "close",
    beforeLaunch?: (
      ownership?: SimulatorLaunchOwnership,
    ) => Promise<void>,
    ownership?: SimulatorLaunchOwnership,
  ) {
    if (!isAndroidEmulator(d) || d.connection.type !== "adb")
      fail("unsupported-lifecycle", "This target is not an Android emulator.");
    const c = d.connection;
    let current: Awaited<ReturnType<AndroidEmulators["running"]>>[number] | undefined;
    try {
      current = await this.locate(d);
    } catch (error) {
      if (
        action !== "close" ||
        !ownership ||
        !(error instanceof DeckError) ||
        error.code !== "emulator-identity-pending"
      )
        throw error;
      const changed = await this.closeOwnedProcess(d, ownership);
      if (!changed)
        fail(
          "emulator-ownership-missing",
          "An unidentified emulator is present, but it does not carry this reservation group's launch marker. Cleanup will not stop an unrelated process.",
          409,
        );
      return {
        deviceId: d.id,
        action,
        state: "shutdown" as const,
        changed,
      };
    }
    if (current && !current.avdName)
      fail(
        "emulator-identity-pending",
        "This emulator's AVD identity is not available yet. Wait and refresh before launching or closing it.",
        409,
      );
    if (action === "close") {
      if (!current) {
        const changed = ownership
          ? await this.closeOwnedProcess(d, ownership)
          : false;
        return {
          deviceId: d.id,
          action,
          state: "shutdown" as const,
          changed,
        };
      }
      const serial = current.serial;
      if (
        ownership &&
        (await this.currentOwnershipMarker(d, serial, ownership)) !==
          ownership.marker
      ) {
        const changed = await this.closeOwnedProcess(d, ownership);
        if (!changed)
          fail(
            "emulator-ownership-missing",
            "This AVD is running, but its transport does not carry this reservation group's launch marker. Cleanup will not stop a replacement process.",
            409,
          );
        return {
          deviceId: d.id,
          action,
          state: "shutdown" as const,
          changed,
        };
      }
      try {
        await this.execute(this.adb(), [
          "-P",
          String(c.port),
          "-s",
          serial,
          "emu",
          "kill",
        ]);
      } catch (error) {
        if (!ownership || !(await this.closeOwnedProcess(d, ownership)))
          throw error;
        return {
          deviceId: d.id,
          action,
          state: "shutdown" as const,
          changed: true,
        };
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        if (
          !(await this.running(c.port)).some((entry) => entry.serial === serial)
        )
          return {
            deviceId: d.id,
            action,
            state: "shutdown" as const,
            changed: true,
          };
        await this.sleep(1000);
      }
      fail(
        "emulator-transition",
        "Android emulator is still closing. Refresh its status before trying again.",
        409,
      );
    }
    if (!c.avdName)
      fail(
        "emulator-identity-required",
        "Configure this emulator’s AVD name before launching it. Discover available Android virtual devices or set the AVD name in Edit device.",
        409,
      );
    if (!(await this.names()).includes(c.avdName))
      fail(
        "emulator-unavailable",
        "This AVD is unavailable in the configured Android SDK.",
        409,
      );
    let error: () => string | undefined = () => undefined;
    if (!current) {
      const binary = await this.binary();
      const launchOwnership = beforeLaunch
        ? {
            type: "android-emulator" as const,
            avdName: c.avdName,
            marker: randomBytes(16).toString("hex"),
          }
        : undefined;
      await beforeLaunch?.(launchOwnership);
      error = this.launch(
        binary,
        [
          "-avd",
          c.avdName,
          ...(launchOwnership
            ? [
                "-prop",
                `${launchProperty}=${launchOwnership.marker}`,
              ]
            : []),
        ],
        c.port,
      );
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      if (error()) fail("emulator-launch-failed", error()!, 502);
      const inspected = await this.inspect(d).catch((inspectionError) => {
        if (
          inspectionError instanceof DeckError &&
          [
            "emulator-identity-pending",
            "emulator-not-ready",
            "emulator-offline",
          ].includes(inspectionError.code)
        )
          return undefined;
        throw inspectionError;
      });
      if (
        inspected?.state === "booted" &&
        inspected.resolved?.connection.type === "adb"
      )
        return {
          deviceId: d.id,
          action,
          state: "booted" as const,
          changed: !current,
          serial: inspected.resolved.connection.serial,
        };
      await this.sleep(1000);
    }
    fail(
      "emulator-transition",
      "Android emulator is still starting or its display is not ready. Its process was left running; refresh and wait for Android to finish booting.",
      409,
    );
  }
}
