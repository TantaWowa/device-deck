import {
  deviceSchema,
  DeckError,
  type Config,
  type DeviceConfig,
  type SourceConfig,
} from "./local/types";
import { deviceIdentity } from "./local/identity";

export type DiscoveredDevices = {
  devices: DeviceConfig[];
  sources: SourceConfig[];
  diagnostics: string[];
};

export function isDeviceConfigured(config: Config, device: DeviceConfig) {
  return config.devices.some(
    (d) =>
      d.id.toLowerCase() === device.id.toLowerCase() ||
      deviceIdentity(d) === deviceIdentity(device) ||
      (d.connection.type === "adb" &&
        device.connection.type === "adb" &&
        (!d.connection.avdName || !device.connection.avdName) &&
        d.connection.serial === device.connection.serial &&
        d.connection.port === device.connection.port),
  );
}

export function registrationIssue(device: DeviceConfig): string | undefined {
  const parsed = deviceSchema.safeParse(device);
  if (!parsed.success)
    return parsed.error.issues.map((i) => i.message).join("; ");
  if (
    device.connection.type === "adb" &&
    device.connection.serial.includes(":") &&
    !device.connection.hardwareId
  )
    return "Authorize ADB and discover again to read this device's hardware serial.";
}

function uniqueName(name: string, used: Set<string>, limit: number) {
  const base = name.trim().slice(0, limit);
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, limit - suffix.length) + suffix;
  }
  return candidate;
}

/** Register a batch in one config save, preserving existing operator choices. */
export function registerDiscoveredDevices(
  current: Config,
  discovery: DiscoveredDevices,
  ids: string[],
) {
  const config = structuredClone(current);
  const added: DeviceConfig[] = [];
  const names = new Set(config.devices.map((d) => d.name.toLowerCase()));
  for (const id of new Set(ids)) {
    const found = discovery.devices.find((d) => d.id === id);
    if (!found)
      throw new Error(
        "A selected device is no longer in discovery. Discover again.",
      );
    if (isDeviceConfigured(config, found)) continue;
    const issue = registrationIssue(found);
    if (issue) throw new Error(`${found.name}: ${issue}`);
    const device = structuredClone(found);
    device.name = uniqueName(device.name, names, 64);
    names.add(device.name.toLowerCase());
    // Native screens are identified by their device. USB cards require explicit pairing.
    device.captureSourceId = null;
    if (["adb", "simulator"].includes(device.connection.type)) {
      let source = config.sources.find(
        (s) => s.kind === "native" && s.deviceId === device.id,
      );
      if (!source) {
        const discovered = discovery.sources.find(
          (s) => s.kind === "native" && s.deviceId === device.id,
        );
        source = {
          id: uniqueName(
            discovered?.id || `native-${device.id}`,
            new Set(config.sources.map((s) => s.id.toLowerCase())),
            160,
          ),
          name: `${device.name} native screen`,
          kind: "native",
          deviceId: device.id,
        };
        config.sources.push(source);
      }
      device.captureSourceId = source.id;
    }
    config.devices.push(device);
    added.push(device);
  }
  return { config, added };
}

export function staleVirtualDevices(current: Config, discovery: DiscoveredDevices) {
  const present = new Set(discovery.devices.map((device) => device.id));
  const missing = current.devices.filter((device) => device.kind === "virtual" && !present.has(device.id));
  if (missing.length && discovery.diagnostics.length)
    throw new DeckError("discovery-incomplete", "Cannot unregister stale devices while discovery reports errors.", 409, { diagnostics: discovery.diagnostics });
  return missing;
}
