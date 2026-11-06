import { deviceIdentity, sourceIdentity } from "../../core/src/local/identity";
export { deviceIdentity, sourceIdentity } from "../../core/src/local/identity";
import { readFile, mkdir, rename, chmod, open, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { configSchema, type Config, fail } from "../../core/src/local/types";
export const expand = (p: string, base: string) =>
  path.resolve(
    base,
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p,
  );
export const revision = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function atomicWrite(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
export function validateConfig(value: unknown) {
  const c = configSchema.parse(value);
  const ids = new Set<string>(),
    physicalSources = new Set<string>(),
    names = new Set<string>(),
    bindings = new Set<string>(),
    locators = new Set<string>(),
    emulatorTransports = new Map<string, string | undefined>();
  for (const s of c.sources) {
    if (ids.has(s.id))
      fail("invalid-config", "Capture source IDs must be unique.");
    ids.add(s.id);
    if (s.kind === "usb" && !s.uniqueId)
      fail("invalid-config", "USB sources require a stable uniqueId.");
    if (s.kind === "usb" && c.ignoredCaptureCardIds.includes(s.uniqueId!))
      fail("invalid-config", "A deleted capture card cannot remain configured.");
    if (s.kind === "native" && !s.deviceId)
      fail("invalid-config", "Native sources require a deviceId.");
    const identity = sourceIdentity(s);
    if (physicalSources.has(identity))
      fail(
        "source-conflict",
        "A physical capture source cannot be registered twice.",
      );
    physicalSources.add(identity);
  }
  const deviceIds = new Set(c.devices.map((d) => d.id.toLowerCase()));
  if (deviceIds.size !== c.devices.length)
    fail("invalid-config", "Device IDs must be unique.");
  for (const d of c.devices) {
    if (
      d.connection.type === "adb" &&
      /^emulator-\d+$/.test(d.connection.serial)
    ) {
      const transport = `${d.connection.port}:${d.connection.serial}`;
      if (
        emulatorTransports.has(transport) &&
        (!emulatorTransports.get(transport) || !d.connection.avdName)
      )
        fail(
          "invalid-config",
          "An emulator ADB transport cannot be registered twice without distinct AVD names.",
        );
      emulatorTransports.set(transport, d.connection.avdName);
    }
    if (
      d.connection.type === "adb" &&
      d.connection.avdName &&
      (d.kind !== "virtual" ||
        d.platform !== "Android" ||
        d.connection.hardwareId)
    )
      fail(
        "invalid-config",
        "An AVD name is only valid for Android virtual devices without a physical hardware serial.",
      );
    if (
      d.connection.type === "capture" &&
      !c.sources.some((s) => s.id === d.captureSourceId && s.kind === "usb")
    )
      fail(
        "invalid-config",
        "Capture-only devices require a USB capture input.",
      );
    if (
      d.connection.type === "adb" &&
      d.connection.serial.includes(":") &&
      !d.connection.hardwareId
    )
      fail(
        "invalid-config",
        "Wireless ADB devices require their stable hardware serial. Discover the connected device or enter it explicitly.",
      );
    const locator = deviceIdentity(d);
    if (locators.has(locator))
      fail("invalid-config", "A hardware identity cannot be registered twice.");
    locators.add(locator);
    if (names.has(d.name.toLowerCase()))
      fail("invalid-config", "Friendly names must be unique.");
    names.add(d.name.toLowerCase());
    if (d.captureSourceId) {
      const s = c.sources.find((s) => s.id === d.captureSourceId);
      if (!s)
        fail(
          "invalid-config",
          `${d.name} refers to an unknown capture source.`,
        );
      if (bindings.has(sourceIdentity(s)))
        fail(
          "source-conflict",
          `${s.name} is already bound to another device.`,
        );
      bindings.add(sourceIdentity(s));
      if (s.kind === "native" && s.deviceId !== d.id)
        fail("source-conflict", "A native screen belongs to its own device.");
      if (
        s.kind === "native" &&
        !(["adb", "simulator"].includes(d.connection.type) ||
          d.connection.type === "apple-device" && d.connection.webDriverAgent)
      )
        fail("invalid-config", "This device has no native capture adapter.");
    }
  }
  if (!c.settings.naming.includes("{time}") || /[\\/]/.test(c.settings.naming))
    fail("invalid-config", "Naming requires {time} and no path separators.");
  return c;
}
/** Serializes the complete read/check/write transaction, including refresh. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
}
export class ConfigStore {
  config: Config;
  revision = "";
  error: string | null = null;
  private raw = "";
  private queue = new SerialQueue();
  constructor(readonly file: string) {
    this.config = validateConfig({
      schemaVersion: 1,
      settings: { folder: "~/Movies/Device Deck" },
    });
  }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      raw = JSON.stringify(this.config, null, 2) + "\n";
      await atomicWrite(this.file, raw);
    }
    this.accept(raw);
  }
  private accept(raw: string) {
    this.config = validateConfig(JSON.parse(raw));
    this.raw = raw;
    this.revision = revision(raw);
    this.error = null;
  }
  refresh(validateChange?: (c: Config) => void | Promise<void>) {
    return this.queue.run(async () => {
      try {
        const raw = await readFile(this.file, "utf8");
        if (raw === this.raw) {
          this.error = null;
          return false;
        }
        const c = validateConfig(JSON.parse(raw));
        await validateChange?.(c);
        this.accept(raw);
        return true;
      } catch (e) {
        this.error = `Configuration rejected; last valid state retained. ${(e as Error).message}`;
        return false;
      }
    });
  }
  save(
    value: unknown,
    expected: string,
    validateChange?: (c: Config) => void | Promise<void>,
  ) {
    return this.queue.run(async () => {
      const current = await readFile(this.file, "utf8");
      if (revision(current) !== expected)
        fail(
          "config-conflict",
          "Configuration changed on disk. Reload it before saving.",
          409,
        );
      const c = validateConfig(value);
      await validateChange?.(c);
      const raw = JSON.stringify(c, null, 2) + "\n";
      await atomicWrite(this.file, raw);
      this.accept(raw);
      return { config: this.config, revision: this.revision };
    });
  }
  get folder() {
    return expand(this.config.settings.folder, path.dirname(this.file));
  }
}
