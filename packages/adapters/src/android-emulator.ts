import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { run, available } from "./process";
import {
  fail,
  type Config,
  type DeviceConfig,
} from "../../core/src/local/types";
const emulatorSerial = /^emulator-\d+$/;
const avdName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
type Runner = typeof run;
export const isAndroidEmulator = (d: DeviceConfig) =>
  d.kind === "virtual" &&
  d.connection.type === "adb" &&
  Boolean(d.connection.avdName || emulatorSerial.test(d.connection.serial));
export class AndroidEmulators {
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
  async names() {
    return [
      ...new Set(
        (await this.execute(await this.binary(), ["-list-avds"])).stdout
          .toString()
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => avdName.test(s)),
      ),
    ];
  }
  async running(port: number) {
    const data = (
      await this.execute(this.adb(), ["-P", String(port), "devices"])
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
          await this.execute(
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
            await this.execute(
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
  private async locate(d: DeviceConfig) {
    if (!isAndroidEmulator(d) || d.connection.type !== "adb")
      fail("unsupported-lifecycle", "This target is not an Android emulator.");
    const c = d.connection;
    const entries = await this.running(c.port);
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
      entries.some((entry) => entry.serial === c.serial && !entry.avdName)
    )
      fail(
        "emulator-identity-pending",
        "The last emulator connection is present but its AVD identity is not available yet. Wait and refresh before launching or closing it.",
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
  ): Promise<DeviceConfig | undefined> {
    if (!isAndroidEmulator(d)) return d;
    const found = await this.locate(d);
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
    return this.resolved(d, found);
  }
  async prepare(d: DeviceConfig) {
    const found = await this.locate(d);
    if (found && !found.avdName)
      fail(
        "emulator-identity-pending",
        "This emulator's AVD identity is not available yet. Wait and refresh before launching or closing it.",
        409,
      );
    return found ? this.resolved(d, found) : d;
  }
  async inspect(d: DeviceConfig) {
    const found = await this.locate(d);
    if (!found) {
      if (
        d.connection.type === "adb" &&
        d.connection.avdName &&
        !(await this.names()).includes(d.connection.avdName)
      )
        return { state: "unavailable" as const };
      return { state: "shutdown" as const };
    }
    const resolved = this.resolved(d, found);
    if (found.state !== "device" || resolved.connection.type !== "adb")
      return { state: "starting" as const, resolved };
    const booted =
      (
        await this.execute(this.adb(), [
          "-P",
          String(resolved.connection.port),
          "-s",
          resolved.connection.serial,
          "shell",
          "getprop",
          "sys.boot_completed",
        ])
      ).stdout
        .toString()
        .trim() === "1";
    return {
      state: booted ? ("booted" as const) : ("starting" as const),
      resolved,
    };
  }
  private async displayReady(d: DeviceConfig) {
    if (d.connection.type !== "adb") return false;
    const args = ["-P", String(d.connection.port), "-s", d.connection.serial];
    try {
      const animation = (await this.execute(this.adb(), [...args, "shell", "getprop", "init.svc.bootanim"], 3000)).stdout.toString().trim();
      if (animation && animation !== "stopped") return false;
      // ADB and sys.boot_completed can become ready before SurfaceFlinger can
      // capture the display. Wait for a complete PNG before returning Launch.
      const image = (await this.execute(this.adb(), [...args, "exec-out", "screencap", "-p"], 5000)).stdout;
      return image.length >= 33 &&
        image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        image.subarray(12, 16).toString() === "IHDR" &&
        image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0 &&
        image.subarray(-8, -4).toString() === "IEND";
    } catch { return false; }
  }
  async control(d: DeviceConfig, action: "launch" | "close") {
    if (!isAndroidEmulator(d) || d.connection.type !== "adb")
      fail("unsupported-lifecycle", "This target is not an Android emulator.");
    const c = d.connection,
      current = await this.locate(d);
    if (current && !current.avdName)
      fail(
        "emulator-identity-pending",
        "This emulator's AVD identity is not available yet. Wait and refresh before launching or closing it.",
        409,
      );
    if (action === "close") {
      if (!current)
        return {
          deviceId: d.id,
          action,
          state: "shutdown" as const,
          changed: false,
        };
      const serial = current.serial;
      await this.execute(this.adb(), [
        "-P",
        String(c.port),
        "-s",
        serial,
        "emu",
        "kill",
      ]);
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
    const error = current
      ? () => undefined
      : this.launch(await this.binary(), ["-avd", c.avdName], c.port);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (error()) fail("emulator-launch-failed", error()!, 502);
      const inspected = await this.inspect(d);
      if (
        inspected.state === "booted" &&
        inspected.resolved?.connection.type === "adb" &&
        await this.displayReady(inspected.resolved)
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
