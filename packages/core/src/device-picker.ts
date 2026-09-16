export interface DevicePickerItem {
  id: string;
  name: string;
  platform: "Roku" | "Android" | "Apple" | "Other";
  kind: "physical" | "virtual";
  model?: string;
  connection?: { type: string; os?: string };
}

export type DeviceClass = "tv" | "phone" | "tablet" | "computer" | "other";

export function deviceClass(item: DevicePickerItem): DeviceClass {
  const connection = item.connection;
  if (
    item.platform === "Roku" ||
    connection?.type === "roku" ||
    connection?.type === "apple-tv" ||
    (connection?.type === "simulator" &&
      connection.os?.toLowerCase() === "tvos")
  )
    return "tv";

  const description = `${item.name} ${item.model || ""}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (
    /\b(?:tv|television|firetv|androidtv|googletv|shieldtv|appletv)\b/.test(
      description,
    )
  )
    return "tv";
  // Pixel tablets must be classified before the broader Pixel phone family.
  if (/\b(?:ipad|tablet)\b/.test(description)) return "tablet";
  if (
    /\b(?:mac\s*mini|macbook(?:\s*(?:air|pro))?|imac|desktop|laptop|computer)\b/.test(
      description,
    )
  )
    return "computer";
  if (
    /\b(?:iphone|phone)\b/.test(description) ||
    /\bpixel(?:\s*\d+[a-z]?\b|\s+(?:fold|phone|emulator)\b|\s*$)/.test(
      description,
    )
  )
    return "phone";
  // An Android or Apple family alone does not identify its form factor.
  return "other";
}

export function filterPickerDevices<T extends DevicePickerItem>(
  items: readonly T[],
  filters: {
    family: string;
    deviceClass: string;
    kind: string;
    search: string;
  },
): T[] {
  const search = filters.search.trim().toLowerCase();
  return items.filter(
    (item) =>
      (!filters.family || item.platform === filters.family) &&
      (!filters.deviceClass || deviceClass(item) === filters.deviceClass) &&
      (!filters.kind || item.kind === filters.kind) &&
      (!search ||
        `${item.name} ${item.model || ""}`.toLowerCase().includes(search)),
  );
}
