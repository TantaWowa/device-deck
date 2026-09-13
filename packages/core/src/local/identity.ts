import type { DeviceConfig, SourceConfig } from "./types";
export function deviceIdentity(d: DeviceConfig) {
  const c = d.connection;
  switch (c.type) {
    case "capture":
      return `capture:${d.captureSourceId}`;
    case "adb":
      return c.avdName ? `avd:${c.avdName}` : `adb:${c.hardwareId || c.serial}`;
    case "roku":
      return `roku:${c.serial}`;
    case "simulator":
      return `simulator:${c.udid.toLowerCase()}`;
    case "apple-tv":
      return `apple-tv:${c.identifier}`;
    case "apple-device":
      return `apple-device:${c.udid}`;
  }
}
export const sourceIdentity = (s: SourceConfig) =>
  s.kind === "usb" ? `usb:${s.uniqueId}` : `native:${s.deviceId}`;
