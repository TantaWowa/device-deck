import type { Device, Session, SourceConfig } from "./local/types";

export type DeviceSortColumn =
  "device" | "connection" | "reservation" | "capture" | "visibility";
export type DeviceSort = {
  column: DeviceSortColumn;
  direction: "ascending" | "descending";
};
type TableDevice = Pick<
  Device,
  | "id"
  | "name"
  | "online"
  | "locked"
  | "simulatorState"
  | "captureSourceId"
  | "visibility"
>;
type TableSession = Pick<Session, "deviceId" | "state" | "owner" | "reason">;

export function deviceConnectionLabel(
  device: Pick<Device, "online" | "simulatorState">,
) {
  return device.simulatorState === "starting"
    ? "Launching…"
    : device.simulatorState === "stopping"
      ? "Closing…"
      : device.simulatorState === "shutdown"
        ? "Stopped"
        : device.online
          ? "Online"
          : "Offline";
}

export function deviceAvailabilityLabel(
  device: Pick<Device, "locked" | "online">,
) {
  return device.locked ? "Locked" : device.online ? "Available" : "Unavailable";
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/** Sort by the values shown in the table; equal values keep their inventory order. */
export function sortTableDevices<T extends TableDevice>(
  devices: readonly T[],
  sort: DeviceSort,
  sources: readonly Pick<SourceConfig, "id" | "name">[],
  sessions: readonly TableSession[],
): T[] {
  const sourceNames = new Map(
    sources.map((source) => [source.id, source.name]),
  );
  const active = new Map<string, TableSession>();
  for (const session of sessions)
    if (session.state !== "closed" && !active.has(session.deviceId))
      active.set(session.deviceId, session);
  const value = (device: T) => {
    switch (sort.column) {
      case "device":
        return device.name;
      case "connection":
        return deviceConnectionLabel(device);
      case "reservation": {
        const session = active.get(device.id);
        return session
          ? `${session.owner}\n${session.reason}`
          : deviceAvailabilityLabel(device);
      }
      case "capture":
        return (
          sourceNames.get(device.captureSourceId || "") || "No capture input"
        );
      case "visibility":
        return device.visibility === "local" ? "Local only" : "Shared label";
    }
  };
  const direction = sort.direction === "ascending" ? 1 : -1;
  return devices
    .map((device, index) => ({ device, index, value: value(device) }))
    .sort(
      (a, b) =>
        collator.compare(a.value, b.value) * direction || a.index - b.index,
    )
    .map(({ device }) => device);
}
