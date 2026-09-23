import { ANDROID_GESTURES, startScrcpy } from "./scrcpy";
import { androidBootReady, androidFeatures, avdInputMode } from "./android-state";
import { IOS_GESTURES, startIdbInteractive } from "./interactive";
import type { InteractiveSource, VideoProfile } from "../../core/src/live";
import { androidKeys, rokuKeys, hidKeys, iosHardwareKeys, deviceInputMode } from "../../core/src/remote";
import { controlSimulator, simulatorState, SimulatorInventory, wakeSimulator } from "./simulator";
import { AndroidEmulators, isAndroidEmulator } from "./android-emulator";
import {
  mergeCaptureCards,
} from "../../core/src/capture-cards";
// Adapted from Tawi discovery, Hosanna Tools Roku SSDP, and George Cook's tv-remote.py.
// See docs/source-provenance.md. No personal checkout is a runtime dependency.
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { run, available, start, stop } from "./process";
import { healthProbeRunner, ProbeScheduler } from "./health-probes";
import { CameraDiscovery } from "./camera-discovery";
import {
  type Config,
  type DeviceConfig,
  type Device,
  type Source,
  type SourceConfig,
  fail,
} from "../../core/src/local/types";
let location = path.dirname(fileURLToPath(import.meta.url));
while (
  !existsSync(path.join(location, "native/apple-tv.py")) &&
  path.dirname(location) !== location
)
  location = path.dirname(location);
export const root = location;
export const helper = path.join(root, "build/native/deck-camera");
const uid = (prefix: string, value: string) =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export type Discovery = {
  devices: DeviceConfig[];
  sources: SourceConfig[];
  diagnostics: string[];
};
export function appleHardwareInputMode(hardware: {
  platform?: string;
  deviceType?: string;
  productType?: string;
  marketingName?: string;
} = {}): "touch" | "remote" {
  if (hardware.platform?.toLowerCase() === "tvos" || hardware.deviceType?.toLowerCase() === "appletv" || /^AppleTV\d/i.test(hardware.productType || "")) return "remote";
  if (hardware.platform?.toLowerCase() === "ios" || /^(?:iphone|ipad|ipod)$/i.test(hardware.deviceType || "")) return "touch";
  return deviceInputMode({ connection: { type: "apple-device", udid: "metadata" }, model: hardware.marketingName || hardware.productType || "" }) === "remote" ? "remote" : "touch";
}
export class Adapters {
  readonly emulators: AndroidEmulators;
  readonly cameras: CameraDiscovery;
  readonly simulatorInventory: SimulatorInventory;
  private readonly probes: ProbeScheduler;
  private discoveryPending?: Promise<Discovery>;
  private discoveryResult?: Discovery;
  private discoveryAt = -Infinity;
  private discoveryStarted = -Infinity;
  private discoveryCounters = { requests: 0, hits: 0, shared: 0, starts: 0 };
  private inputModes = new Map<string, "touch" | "remote">();
  constructor(private getConfig: () => Config, private execute = run, private now: () => number = Date.now) {
    this.emulators = new AndroidEmulators(getConfig, execute);
    this.probes = new ProbeScheduler(execute);
    this.cameras = new CameraDiscovery(helper, this.probes.run, now);
    this.simulatorInventory = new SimulatorInventory(now);
  }
  invalidateInventory(deviceId?: string) {
    if (!deviceId) this.cameras.invalidate();
    this.simulatorInventory.invalidate(deviceId);
    this.discoveryAt = -Infinity;
  }
  inventoryStats() { return { camera: this.cameras.stats(), probes: this.probes.stats(), discovery: { ...this.discoveryCounters, active: Boolean(this.discoveryPending) } }; }
  async close() { await Promise.all([this.cameras.close(), this.probes.close()]); }
  private inputModeKey(d: DeviceConfig) {
    const c = d.connection;
    return c.type === "adb" ? `${d.id}:${c.port}:${c.avdName || c.hardwareId || c.serial}` : d.id;
  }
  private async androidFeatures(d: DeviceConfig, execute = this.execute) {
    const output = (await execute(this.tool("adb"), [...this.adb(d), "shell", "pm", "list", "features"], 5000)).stdout.toString();
    if (!/^feature:/m.test(output)) throw new Error("Android features are not available yet.");
    const result = androidFeatures(output);
    this.inputModes.set(this.inputModeKey(d), result.inputMode);
    return result;
  }
  tool(name: keyof Config["tools"]) {
    return (
      this.getConfig().tools[name] || (name === "python" ? "python3" : name)
    );
  }
  adb(d: DeviceConfig) {
    if (d.connection.type !== "adb") return [];
    return ["-P", String(d.connection.port), "-s", d.connection.serial];
  }
  async diagnostics() {
    return (
      await Promise.all(
        ["adb", "ffmpeg", "ffprobe", "idb"].map(async (n) =>
          (await available(this.tool(n as keyof Config["tools"])))
            ? ""
            : n === "ffmpeg" || n === "ffprobe"
              ? `${n} not found. Recording needs ffmpeg and ffprobe; USB screenshots also need ffmpeg. Install with brew install ffmpeg, then reopen Device Deck, or set the ffmpeg/ffprobe executable paths in Settings configuration.`
              : `${n} not found; its capabilities are unavailable.`,
        ),
      )
    ).filter(Boolean);
  }
  async discover(force = false): Promise<Discovery> {
    this.discoveryCounters.requests++;
    if (this.discoveryPending) { this.discoveryCounters.shared++; return structuredClone(await this.discoveryPending); }
    if (this.discoveryResult && (this.now() - this.discoveryStarted < 5000 || (!force && this.now() - this.discoveryAt < 30_000))) {
      this.discoveryCounters.hits++;
      return structuredClone(this.discoveryResult);
    }
    this.discoveryCounters.starts++;
    this.discoveryStarted = this.now();
    const signal = AbortSignal.timeout(30_000);
    const execute: typeof run = (command, args, timeout, options) => this.probes.run(command, args, timeout, { ...options, signal });
    this.discoveryPending = this.discoverNow(force, execute).then((result) => {
      this.discoveryResult = result;
      this.discoveryAt = this.now();
      return result;
    }).finally(() => { this.discoveryPending = undefined; });
    return structuredClone(await this.discoveryPending);
  }
  private async discoverNow(force: boolean, execute: typeof run): Promise<Discovery> {
    const devices: DeviceConfig[] = [],
      sources: SourceConfig[] = [],
      diagnostics: string[] = [];
    const safe = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        diagnostics.push(`${name}: ${(e as Error).message}`);
      }
    };
    await Promise.all([
      safe("Android", async () => {
        if (!(await available(this.tool("adb")))) return;
        for (const port of [
          ...new Set([
            5037,
            ...this.getConfig().devices.flatMap((d) =>
              d.connection.type === "adb" ? [d.connection.port] : [],
            ),
          ]),
        ]) {
          const { stdout } = await execute(this.tool("adb"), [
            "-P",
            String(port),
            "devices",
            "-l",
          ]);
          const emulators = await this.emulators.running(port, execute);
          for (const line of stdout.toString().split("\n").slice(1)) {
            const [serial, state, ...parts] = line.trim().split(/\s+/);
            if (
              !serial ||
              !["device", "offline", "unauthorized"].includes(state)
            )
              continue;
            const model =
              parts.find((p) => p.startsWith("model:"))?.slice(6) || serial;
            let hardwareId: string | undefined;
            const avdName = emulators.find((e) => e.serial === serial)?.avdName;
            if (state === "device" && !serial.startsWith("emulator-")) {
              hardwareId =
                (
                  await execute(this.tool("adb"), [
                    "-P",
                    String(port),
                    "-s",
                    serial,
                    "shell",
                    "getprop",
                    "ro.serialno",
                  ]).catch(() => ({ stdout: Buffer.from("") }))
                ).stdout
                  .toString()
                  .trim() || undefined;
            }
            const id = avdName
                ? uid("avd", avdName)
                : uid("adb", hardwareId || serial),
              nativeId = `native-${id}`;
            if (devices.some((d) => d.id === id)) continue;
            const features = state === "device" ? (await execute(this.tool("adb"), ["-P", String(port), "-s", serial, "shell", "pm", "list", "features"], 5000).catch(() => ({ stdout: Buffer.from("") }))).stdout.toString() : "";
            const inputMode = /^feature:/m.test(features) ? androidFeatures(features).inputMode : avdName ? await avdInputMode(avdName) : undefined;
            devices.push({
              id,
              name: model,
              model,
              ...(inputMode ? { inputMode } : {}),
              platform: "Android",
              kind: serial.startsWith("emulator-") ? "virtual" : "physical",
              visibility: "local",
              connection: {
                type: "adb",
                serial,
                port,
                ...(hardwareId ? { hardwareId } : {}),
                ...(avdName ? { avdName } : {}),
              },
              captureSourceId: nativeId,
            });
            sources.push({
              id: nativeId,
              name: `${model} native screen`,
              kind: "native",
              deviceId: id,
            });
          }
          try {
            for (const avdName of await this.emulators.names(execute)) {
              const configured = this.getConfig().devices.find(
                (d) =>
                  d.connection.type === "adb" &&
                  d.connection.avdName === avdName,
              );
              const configuredPort =
                configured?.connection.type === "adb"
                  ? configured.connection.port
                  : 5037;
              if (
                configuredPort !== port ||
                devices.some(
                  (d) =>
                    d.connection.type === "adb" &&
                    d.connection.avdName === avdName,
                )
              )
                continue;
              const id = uid("avd", avdName),
                nativeId = `native-${id}`;
              devices.push({
                id,
                name: avdName,
                model: "Android virtual device",
                inputMode: configured?.inputMode || await avdInputMode(avdName) || "touch",
                platform: "Android",
                kind: "virtual",
                visibility: "local",
                connection: { type: "adb", serial: `avd-${id}`, port, avdName },
                captureSourceId: nativeId,
              });
              sources.push({
                id: nativeId,
                name: `${avdName} native screen`,
                kind: "native",
                deviceId: id,
              });
            }
          } catch (e) {
            diagnostics.push(
              `Android virtual devices: ${(e as Error).message}`,
            );
          }
        }
      }),
      safe("Simulators", async () => {
        const result = await execute("xcrun", [
          "simctl",
          "list",
          "devices",
          "available",
          "--json",
        ]);
        const data = JSON.parse(result.stdout.toString());
        for (const [runtime, list] of Object.entries(data.devices || {})) {
          if (!/iOS|tvOS/.test(runtime)) continue;
          for (const d of list as { udid: string; name: string }[]) {
            const id = uid("sim", d.udid),
              sourceId = `native-${id}`;
            devices.push({
              id,
              name: d.name,
              model: runtime.split(".").at(-1) || "",
              platform: "Apple",
              kind: "virtual",
              visibility: "local",
              connection: {
                type: "simulator",
                udid: d.udid,
                os: /tvOS/.test(runtime) ? "tvos" : "ios",
              },
              captureSourceId: sourceId,
            });
            sources.push({
              id: sourceId,
              name: `${d.name} native screen`,
              kind: "native",
              deviceId: id,
            });
          }
        }
      }),
      safe("Apple devices", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "deck-discovery-"));
        try {
          const file = path.join(dir, "devices.json");
          await execute("xcrun", [
            "devicectl",
            "list",
            "devices",
            "--json-output",
            file,
            "--quiet",
          ]);
          const data = JSON.parse(await readFile(file, "utf8"));
          for (const d of data.result?.devices || [])
            devices.push({
              id: uid("apple", d.identifier),
              name: d.deviceProperties?.name || "Apple device",
              model: d.hardwareProperties?.marketingName || d.hardwareProperties?.productType || "",
              inputMode: appleHardwareInputMode(d.hardwareProperties),
              platform: "Apple",
              kind: "physical",
              visibility: "local",
              connection: { type: "apple-device", udid: d.identifier },
              captureSourceId: null,
            });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      safe("USB capture", async () => {
        const result = await this.cameras.read({ force });
        if (result.error) diagnostics.push(`USB capture: ${result.error}`);
        for (const s of result.devices)
          sources.push({
            id: uid("usb", s.uniqueId),
            name: s.name,
            kind: "usb",
            uniqueId: s.uniqueId,
          });
      }),
      safe("Roku", async () => {
        for (const host of await this.scanRoku()) {
          try {
            const info = await this.rokuInfo(host);
            if (!info.serial) continue;
            devices.push({
              id: uid("roku", info.serial),
              name: info.name,
              model: info.model,
              platform: "Roku",
              kind: "physical",
              visibility: "local",
              connection: { type: "roku", host, serial: info.serial },
              captureSourceId: null,
            });
          } catch {}
        }
      }),
      safe("Apple TV", async () => {
        if (!(await available(this.tool("python")))) return;
        const r = await execute(
          this.tool("python"),
          [path.join(root, "native/apple-tv.py"), "scan"],
          10000,
        );
        for (const d of JSON.parse(r.stdout.toString()))
          devices.push({
            id: uid("atv", d.identifier),
            name: d.name,
            model: "Apple TV · Companion",
            platform: "Apple",
            kind: "physical",
            visibility: "local",
            connection: {
              type: "apple-tv",
              host: d.host,
              identifier: d.identifier,
            },
            captureSourceId: null,
          });
      }),
    ]);
    return { devices, sources, diagnostics };
  }
  async captureCards(configs: SourceConfig[], force = false) {
    await this.cameras.read({ force });
    return this.cachedCaptureCards(configs);
  }
  /** Project the existing observation without launching discovery from image requests. */
  cachedCaptureCards(configs: SourceConfig[]) {
    const { devices: detected, ...observation } = this.cameras.peek();
    return {
      sources: mergeCaptureCards(configs, detected, (id) => uid("usb", id)).map((source): Source => ({
        ...source,
        status: observation.observedAt === null ? "unknown" : source.status,
        detail: observation.error || source.detail,
        observation,
      })),
      diagnostics: observation.error ? [`USB discovery unavailable: ${observation.error}`] : [],
      observation,
    };
  }
  async inspectSources(configs: SourceConfig[], _execute = this.execute, force = false): Promise<Source[]> {
    if (!configs.some((source) => source.kind === "usb"))
      return configs.map((source) => ({ ...source, status: "connected" }));
    const { devices: list, ...observation } = await this.cameras.read({ force });
    return configs.map((s) =>
      s.kind === "native"
        ? { ...s, status: "connected" }
        : {
            ...s,
            status: observation.observedAt === null ? "unknown" : list.some((x) => x.uniqueId === s.uniqueId)
              ? "connected"
              : "missing",
            detail:
              observation.error || (list.find((x) => x.uniqueId === s.uniqueId)?.inUse === "true"
                ? "In use by another application"
                : undefined),
            observation,
          },
    );
  }
  private async appleDevices(execute = this.execute) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deck-device-"));
    try {
      const file = path.join(dir, "d.json");
      await execute("xcrun", ["devicectl", "list", "devices", "--json-output", file, "--quiet"]);
      return JSON.parse(await readFile(file, "utf8")).result?.devices || [];
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  /** Coalesce read-only probes within this inventory scan only. Inputs and
   * lifecycle operations use their normal fresh identity/readiness checks. */
  async inspectAll(devices: readonly DeviceConfig[], signal?: AbortSignal, observed?: (device: Device) => void): Promise<Device[]> {
    const execute = healthProbeRunner(this.probes.run, 2, signal);
    let apple: ReturnType<Adapters["appleDevices"]> | undefined;
    const results: Device[] = new Array(devices.length);
    let cursor = 0;
    const worker = async () => {
      while (!signal?.aborted && cursor < devices.length) {
        const index = cursor++;
        const result = await this.inspect(devices[index], execute, () => apple ??= this.appleDevices(execute), true);
        results[index] = result;
        if (!signal?.aborted) observed?.(result);
      }
    };
    // Bound pending inspection work as well as subprocesses. Each worker keeps
    // at most one adapter probe pending; shared listings still span the scan.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(8, devices.length) }, worker));
    signal?.throwIfAborted();
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results;
  }
  async inspect(d: DeviceConfig, execute = this.execute, appleDevices = () => this.appleDevices(execute), inventory = false): Promise<Device> {
    const result: Device = {
      ...d,
      online: false,
      healthDetail: "Not connected",
      locked: false,
      capabilities: [],
      readiness: "offline",
    };
    const c = d.connection;
    try {
      if (c.type === "capture") {
        const source = this.getConfig().sources.find(
          (s) => s.id === d.captureSourceId,
        );
        const status = source ? (await this.inspectSources([source], execute, !inventory))[0] : undefined;
        result.online = status?.status === "connected" && (inventory || !status.observation || (status.observation.observedAt !== null && !status.observation.error));
        result.observation = status?.observation;
        result.healthDetail = result.online
          ? "USB capture connected · configure a control connection for remote input"
          : status?.observation?.error || (status?.status === "unknown" ? "Checking capture connection" : "Capture card disconnected");
      }
      if (c.type === "adb") {
        result.inputMode = this.inputModes.get(this.inputModeKey(d)) || d.inputMode || (c.avdName ? await avdInputMode(c.avdName) : undefined) || "touch";
        if (isAndroidEmulator(d)) {
          const status = await this.emulators.inspect(d, execute);
          result.simulatorState = status.state;
          result.readiness = status.state === "starting" ? "starting" : "offline";
          result.healthDetail =
            status.state === "shutdown"
              ? "Android emulator stopped · Launch to use it"
              : status.state === "unavailable"
                ? "Android AVD unavailable in the configured SDK"
                : status.state === "starting" ? "Android emulator booting…" : `Android emulator ${status.state}`;
          if (status.resolved) {
            d = status.resolved;
            result.connection = d.connection;
          }
          if (status.state !== "booted") return result;
        }
        d = await this.verifyIdentity(d, execute);
        const { stdout } = await execute(this.tool("adb"), [
          ...this.adb(d),
          "get-state",
        ]);
        result.online = stdout.toString().trim() === "device";
        if (result.online && !(await androidBootReady(this.tool("adb"), this.adb(d), execute))) {
          result.online = false;
          result.readiness = "starting";
          result.healthDetail = "Android booting… Wait for its system screen before using the feed or controls.";
          return result;
        }
        if (result.online) {
          result.capabilities.push("key", "text", "restart");
          const features = await this.androidFeatures(d, execute).catch(() => undefined);
          if (features) result.inputMode = features.inputMode;
          if (existsSync(path.join(root, "build/native/scrcpy-server-v4.1")) && features?.touchscreen) {
            result.gestureCapabilities = [...ANDROID_GESTURES];
            result.capabilities.push("touch");
          }
        }
      }
      if (c.type === "roku") {
        const info = await this.rokuInfo(c.host);
        if (info.serial !== c.serial)
          fail(
            "identity-mismatch",
            "Roku at this address has a different serial number.",
          );
        result.online = true;
        result.capabilities.push("key", "text");
      }
      if (c.type === "simulator") {
        result.simulatorState = await (inventory ? this.simulatorInventory.state(d, execute) : simulatorState(d, execute));
        result.online = result.simulatorState === "booted";
        result.readiness = result.simulatorState === "starting" ? "starting" : "offline";
        result.healthDetail =
          result.simulatorState === "booted"
            ? "Simulator running"
            : result.simulatorState === "shutdown"
              ? "Simulator stopped · Launch to use it"
              : result.simulatorState === "starting" ? "Simulator booting…" : `Simulator ${result.simulatorState}`;
        if (result.online) {
          result.capabilities.push("restart");
          if (
            (await available(this.tool("idb"))) &&
            (await available("idb_companion"))
          ) {
            result.capabilities.push("key", "text");
            if (c.os === "ios") {
              result.gestureCapabilities = [...IOS_GESTURES];
              result.capabilities.push("touch");
            }
          }
        }
      }
      if (c.type === "apple-tv") {
        const info = JSON.parse(
          (
            await execute(this.tool("python"), [
              path.join(root, "native/apple-tv.py"),
              "inspect",
              c.host,
              c.identifier,
            ])
          ).stdout.toString(),
        );
        result.online = true;
        if (info.paired) result.capabilities.push("key", "text");
        else result.healthDetail = "Pair Companion using devdeck apple-pair";
      }
      if (c.type === "apple-device") {
        const list = await appleDevices();
        const found = list.find((x: any) => x.identifier === c.udid);
        result.online = Boolean(found && ["connected", "available"].includes(found.connectionProperties?.tunnelState || found.deviceProperties?.connectionState));
        if (found?.hardwareProperties) {
          result.inputMode = appleHardwareInputMode(found.hardwareProperties);
          result.model = found.hardwareProperties.marketingName || found.hardwareProperties.productType || result.model;
        }
        result.healthDetail =
          deviceInputMode(result) === "remote"
            ? "This Apple TV was discovered by Xcode. Configure and pair an Apple TV Companion connection for remote input. A connected USB capture feed is view-only."
            : "Touch input on physical iPhones and iPads is not supported by this adapter. A connected USB capture feed is view-only; use an iOS simulator for touch control.";
      }
      const source = this.getConfig().sources.find(
        (s) => s.id === d.captureSourceId,
      );
      if (
        result.online &&
        source &&
        (source.kind === "usb" || ["adb", "simulator"].includes(c.type))
      ) {
        result.capabilities.push("preview", "screenshot");
        if (
          (await available(this.tool("ffmpeg"))) &&
          (await available(this.tool("ffprobe")))
        )
          result.capabilities.push("record");
      }
      if (result.online && result.healthDetail === "Not connected")
        result.healthDetail = "Connected";
    } catch (e) {
      result.online = false;
      result.capabilities = [];
      result.gestureCapabilities = [];
      result.healthDetail = (e as Error).message;
      if (
        isAndroidEmulator(d) &&
        [
          "emulator-identity-pending",
          "emulator-not-ready",
          "emulator-offline",
        ].includes((e as { code?: string }).code || "")
      ) {
        result.simulatorState = "starting";
        result.readiness = "starting";
      }
      result.observation = { observedAt: null, refreshing: false, stale: true, error: (e as Error).message, nextRefreshAt: Date.now() + 5000 };
    }
    if (result.online) result.readiness = "ready";
    return result;
  }
  async simulator(
    d: DeviceConfig,
    action: "launch" | "close",
    beforeLaunch?: () => Promise<void>,
  ) {
    if (isAndroidEmulator(d))
      return this.emulators.control(d, action, beforeLaunch);
    return controlSimulator(d, action, undefined, beforeLaunch);
  }
  async prepareSimulator(d: DeviceConfig) {
    if (isAndroidEmulator(d)) return this.emulators.prepare(d);
    return d;
  }
  async verifyIdentity(d: DeviceConfig, execute?: typeof run) {
    if (isAndroidEmulator(d)) d = (await this.emulators.resolve(d, true, execute))!;
    if (d.connection.type === "adb" && d.connection.hardwareId) {
      const serial = (
        await (execute ?? this.execute)(this.tool("adb"), [
          ...this.adb(d),
          "shell",
          "getprop",
          "ro.serialno",
        ])
      ).stdout
        .toString()
        .trim();
      if (serial !== d.connection.hardwareId)
        fail(
          "identity-mismatch",
          "The Android device at this transport has a different hardware serial.",
          409,
        );
    }
    return d;
  }
  async verifyCaptureTransport(d: DeviceConfig) {
    if (!isAndroidEmulator(d)) return;
    const current = await this.verifyIdentity(d);
    if (
      d.connection.type !== "adb" ||
      current.connection.type !== "adb" ||
      current.connection.serial !== d.connection.serial ||
      current.connection.port !== d.connection.port
    )
      fail(
        "capture-disconnected",
        "The emulator connection changed during recording. The original recorder cannot be finalized on a different ADB transport.",
        409,
      );
  }
  async input(
    d: DeviceConfig,
    input: { key?: string; text?: string; x?: number; y?: number },
  ) {
    const c = d.connection;
    if (c.type === "adb") {
      d = await this.verifyIdentity(d);
      if (!(await androidBootReady(this.tool("adb"), this.adb(d), this.execute)))
        fail("device-not-ready", "Android is still booting. Wait for its system screen before sending input.", 409);
      if (input.x !== undefined && input.y !== undefined) {
        await this.execute(this.tool("adb"), [
          ...this.adb(d),
          "shell",
          "input",
          "tap",
          String(Math.round(input.x)),
          String(Math.round(input.y)),
        ]);
        return;
      }
      if (input.text !== undefined) {
        if (/[^\x20-\x7e]/.test(input.text))
          fail("unsupported-text", "ADB text supports printable ASCII.");
        for (const [index, part] of input.text.split("%").entries()) {
          if (index)
            await this.execute(this.tool("adb"), [
              ...this.adb(d),
              "shell",
              "input",
              "text",
              "'%'",
            ]);
          if (part)
            await this.execute(this.tool("adb"), [
              ...this.adb(d),
              "shell",
              "input",
              "text",
              shellQuote(part.replaceAll(" ", "%s")),
            ]);
        }
        return;
      }
      const key = androidKeys[input.key || ""];
      if (!key) fail("unsupported-key", "Unsupported Android key.");
      await this.execute(this.tool("adb"), [
        ...this.adb(d),
        "shell",
        "input",
        "keyevent",
        `KEYCODE_${key}`,
      ]);
      return;
    }
    if (c.type === "roku") {
      const info = await this.rokuInfo(c.host);
      if (info.serial !== c.serial)
        fail("identity-mismatch", "Roku serial changed.");
      const keys =
        input.text !== undefined
          ? [...input.text].map((t) => `Lit_${t}`)
          : [rokuKeys[input.key || ""]];
      if (keys.some((k) => !k))
        fail("unsupported-key", "Unsupported Roku key.");
      for (const key of keys) {
        const r = await fetch(
          `http://${c.host}:8060/keypress/${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "",
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          },
        );
        if (!r.ok) fail("input-failed", `Roku returned ${r.status}`, 502);
      }
      return;
    }
    if (c.type === "simulator") {
      if (await simulatorState(d, this.execute) !== "booted")
        fail("device-not-ready", "This simulator is stopped or still booting. Wait for its system screen before sending input.", 409);
      const args = ["--udid", c.udid];
      if (input.text !== undefined)
        await this.execute(this.tool("idb"), ["ui", "text", input.text, ...args]);
      else if (input.x !== undefined && input.y !== undefined)
        await this.execute(this.tool("idb"), [
          "ui",
          "tap",
          String(input.x),
          String(input.y),
          ...args,
        ]);
      else if (c.os === "ios" && iosHardwareKeys[input.key || ""])
        await this.execute(this.tool("idb"), ["ui", "button", iosHardwareKeys[input.key!], ...args]);
      else if (input.key === "Home")
        await this.execute(this.tool("idb"), ["ui", "button", "HOME", ...args]);
      else {
        if (c.os === "ios" && input.key === "Back")
          fail("unsupported-key", "iOS has no system Back button. Use the app's on-screen navigation.");
        const key = hidKeys[input.key || ""];
        if (!key) fail("unsupported-key", "Unsupported simulator key.");
        await this.execute(this.tool("idb"), ["ui", "key", key, ...args]);
      }
      return;
    }
    if (c.type === "apple-tv") {
      await run(
        this.tool("python"),
        [
          path.join(root, "native/apple-tv.py"),
          input.text !== undefined ? "text" : "key",
          c.host,
          c.identifier,
          input.text ?? input.key ?? "",
        ],
        25000,
      );
      return;
    }
    fail(
      "unsupported-capability",
      "Remote input is not available for this device.",
    );
  }
  async startInteractive(d: DeviceConfig, control = true, profile: VideoProfile = "balanced"): Promise<InteractiveSource> {
    if (d.connection.type === "adb") {
      d = await this.verifyIdentity(d);
      if (!(await androidBootReady(this.tool("adb"), this.adb(d), this.execute)))
        fail("device-not-ready", "Android is still booting. Wait for its system screen before opening the feed.", 409);
      return startScrcpy(d, this.tool("adb"), path.join(root, "build/native/scrcpy-server-v4.1"), control, profile);
    }
    if (d.connection.type === "simulator" && await simulatorState(d, this.execute) !== "booted")
      fail("device-not-ready", "This simulator is stopped or still booting. Wait for its system screen before opening the feed.", 409);
    return startIdbInteractive(d, this.tool("idb"), control);
  }
  async pair(d: DeviceConfig) {
    if (d.connection.type !== "apple-tv")
      fail(
        "unsupported-pairing",
        "PIN pairing is available for Apple TV Companion.",
      );
    const handle = start(this.tool("python"), [
      path.join(root, "native/apple-tv.py"),
      "pair",
      d.connection.host,
      d.connection.identifier,
    ]);
    for (let i = 0; i < 200; i++) {
      if (handle.exited())
        fail("pairing-failed", handle.log() || handle.output(), 502);
      if (handle.output().includes("PIN shown on Apple TV:")) return handle;
      await new Promise((r) => setTimeout(r, 100));
    }
    await stop(handle);
    fail("pairing-timeout", "Apple TV did not show a pairing PIN.", 504);
  }
  async wake(d: DeviceConfig): Promise<{ method: string }> {
    const c = d.connection;
    if (c.type === "adb") {
      d = await this.verifyIdentity(d);
      // Unlike POWER, WAKEUP does nothing when the device is already awake.
      await run(this.tool("adb"), [
        ...this.adb(d),
        "shell",
        "input",
        "keyevent",
        "KEYCODE_WAKEUP",
      ]);
      return { method: "Android wake key" };
    }
    if (c.type === "roku") {
      const info = await this.rokuInfo(c.host);
      if (info.serial !== c.serial)
        fail("identity-mismatch", "Roku serial changed.");
      const key = info.isTv ? "PowerOn" : "Home";
      const response = await fetch(`http://${c.host}:8060/keypress/${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        fail("wake-failed", `Roku returned ${response.status}`, 502);
      return { method: info.isTv ? "Roku TV power on" : "Roku Home button" };
    }
    if (c.type === "simulator") return wakeSimulator(d, this.tool("idb"));
    if (c.type === "apple-tv") {
      await run(
        this.tool("python"),
        [path.join(root, "native/apple-tv.py"), "wake", c.host, c.identifier],
        25000,
      );
      return { method: "Apple TV power on" };
    }
    fail("unsupported-capability", "Wake is not available for this device.");
  }
  async screenshot(d: DeviceConfig) {
    d = await this.verifyIdentity(d);
    if (d.connection.type === "adb")
      return (
        await run(this.tool("adb"), [
          ...this.adb(d),
          "exec-out",
          "screencap",
          "-p",
        ])
      ).stdout;
    if (d.connection.type === "simulator")
      return (
        await run("xcrun", [
          "simctl",
          "io",
          d.connection.udid,
          "screenshot",
          "--type=png",
          ...(d.connection.os === "tvos" ? ["--display=external"] : []),
          "-",
        ])
      ).stdout;
    fail(
      "unsupported-capability",
      "Configure a USB capture input for this device.",
    );
  }
  async restart(d: DeviceConfig) {
    if (d.connection.type === "adb") {
      d = await this.verifyIdentity(d);
      await run(this.tool("adb"), [...this.adb(d), "reboot"]);
      return;
    }
    if (d.connection.type === "simulator") {
      await run("xcrun", ["simctl", "shutdown", d.connection.udid]);
      await run("xcrun", ["simctl", "boot", d.connection.udid]);
      await run(
        "xcrun",
        ["simctl", "bootstatus", d.connection.udid, "-b"],
        120000,
      );
      return;
    }
    fail("unsupported-capability", "Restart is not supported for this device.");
  }
  private async rokuInfo(host: string) {
    const r = await fetch(`http://${host}:8060/query/device-info`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!r.ok) fail("device-offline", `Roku returned ${r.status}`);
    const text = await r.text();
    const tag = (name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1] || "";
    return {
      name: tag("friendly-device-name") || tag("model-name") || "Roku",
      model: tag("model-name"),
      serial: tag("serial-number"),
      isTv: tag("is-tv").trim().toLowerCase() === "true",
    };
  }
  private scanRoku(): Promise<string[]> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      const hosts = new Set<string>();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          socket.close();
        } catch {}
        resolve([...hosts]);
      };
      const timer = setTimeout(finish, 2000);
      socket.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      socket.on("message", (m, remote) => {
        if (/st:\s*roku:ecp/i.test(m.toString())) hosts.add(remote.address);
      });
      socket.bind(() =>
        socket.send(
          'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: roku:ecp\r\n\r\n',
          1900,
          "239.255.255.250",
        ),
      );
    });
  }
}
