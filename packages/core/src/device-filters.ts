import type { Device, Session } from "./local/types";
import { deviceFormFactor } from "./device-form-factor";
import type { DeviceSort, DeviceSortColumn } from "./device-table";

export const deviceFilterFacets = [
  { key: "platform", label: "Platform", options: [["Apple", "Apple"], ["Roku", "Roku"], ["Android", "Android"], ["Other", "Other"]] },
  { key: "kind", label: "Environment", options: [["physical", "Physical"], ["virtual", "Simulator"]] },
  { key: "health", label: "Connection", options: [["online", "Online"], ["offline", "Offline"]] },
  { key: "reservation", label: "Availability", options: [["free", "Available"], ["reserved", "Reserved"], ["locked", "Locked"]] },
  { key: "visibility", label: "Visibility", options: [["local", "Local"], ["shared", "Shared"]] },
] as const;

export type DeviceFilterFacet = typeof deviceFilterFacets[number]["key"];
export type DeviceFilterValues = Record<DeviceFilterFacet, string[]> & {
  search: string;
  formFactor: string;
};
export type FilterableDevice = Pick<Device, "id" | "name" | "model" | "tags" | "platform" | "kind" | "connection" | "inputMode" | "online" | "locked" | "visibility">;
export type FilterSession = Pick<Session, "deviceId" | "state">;

export function emptyDeviceFilters(): DeviceFilterValues {
  return { search: "", formFactor: "", platform: [], kind: [], health: [], reservation: [], visibility: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Keep saved views compatible with the existing string-valued config schema. */
export function readDeviceFilters(saved: unknown): DeviceFilterValues {
  const filters = emptyDeviceFilters();
  if (!isRecord(saved)) return filters;
  filters.search = typeof saved.search === "string" ? saved.search : "";
  filters.formFactor = typeof saved.formFactor === "string" && ["tv", "phone", "other"].includes(saved.formFactor) ? saved.formFactor : "";
  for (const facet of deviceFilterFacets) {
    const savedValue = saved[facet.key];
    const values = (typeof savedValue === "string" ? savedValue : "").split(",").map((value) => value.trim());
    filters[facet.key] = facet.options.map(([value]) => value).filter((value) => values.includes(value));
  }
  return filters;
}

export function readDeviceSort(saved: unknown): DeviceSort {
  const columns: DeviceSortColumn[] = ["device", "connection", "reservation", "capture", "visibility"];
  if (isRecord(saved)) {
    const column = columns.find((value) => value === saved.column);
    if (column && (saved.direction === "ascending" || saved.direction === "descending"))
      return { column, direction: saved.direction };
  }
  return { column: "device", direction: "ascending" };
}

export function saveDeviceFilters(filters: DeviceFilterValues): Record<string, string> {
  return {
    search: filters.search,
    formFactor: filters.formFactor,
    ...Object.fromEntries(deviceFilterFacets.map(({ key, options }) => [key, options.map(([value]) => value).filter((value) => filters[key].includes(value)).join(",")])),
  };
}

export function hasDeviceFilters(filters: DeviceFilterValues) {
  return Boolean(filters.search.trim() || filters.formFactor || deviceFilterFacets.some(({ key }) => filters[key].length));
}

/** Values within one facet are alternatives; separate facets must all match. */
export function filterTableDevices<T extends FilterableDevice>(
  devices: readonly T[],
  filters: DeviceFilterValues,
  sessions: readonly FilterSession[],
  ignoreFacet?: DeviceFilterFacet,
): T[] {
  const reserved = new Set(sessions.filter((session) => session.state !== "closed").map((session) => session.deviceId));
  const terms = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return devices.filter((device) => {
    const searchable = [device.name, device.model, device.id, device.platform, ...(device.tags || [])].join(" ").toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) return false;
    if (filters.formFactor && deviceFormFactor(device) !== filters.formFactor) return false;
    return deviceFilterFacets.every(({ key }) => {
      if (key === ignoreFacet || !filters[key].length) return true;
      return filters[key].some((value) => {
        if (key === "health") return value === "online" ? device.online : !device.online;
        if (key === "reservation") return value === "locked" ? device.locked
          : value === "reserved" ? reserved.has(device.id)
          : device.online && !device.locked && !reserved.has(device.id);
        return device[key] === value;
      });
    });
  });
}

export function toggleVisibleDeviceSelection(selected: readonly string[], visible: readonly string[], checked: boolean): string[] {
  const visibleIds = new Set(visible);
  return checked ? [...new Set([...selected, ...visible])]
    : selected.filter((id) => !visibleIds.has(id));
}
