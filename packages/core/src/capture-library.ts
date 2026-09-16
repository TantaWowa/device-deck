import type { Artifact, Device, Session } from "./local/types";

export type CaptureSortColumn = "name" | "device" | "kind" | "createdAt" | "bytes" | "status";
export type CaptureSort = { column: CaptureSortColumn; direction: "ascending" | "descending" };
export type CaptureFilters = {
  search: string; deviceId: string; platform: string; kind: string; trash: boolean;
  deviceKind?: string; health?: string; reservation?: string; visibility?: string;
};
export type CaptureDevice = Pick<Device, "id" | "name" | "platform"> & Partial<Pick<Device, "kind" | "online" | "locked" | "visibility">>;
export type CaptureSession = Pick<Session, "deviceId" | "state">;
export type CaptureVariant = "file" | "clean" | "log";
export const emptyCaptureFilters: CaptureFilters = { search: "", deviceId: "", platform: "", kind: "", trash: false, deviceKind: "", health: "", reservation: "", visibility: "" };
export const hasCaptureFilters = (filters: CaptureFilters) => Boolean(filters.search.trim() || filters.deviceId || filters.platform || filters.kind || filters.deviceKind || filters.health || filters.reservation || filters.visibility);
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function captureIsBusy(artifact: Pick<Artifact, "status">) {
  return artifact.status === "recording" || artifact.status === "finalizing";
}

export function visibleCaptures(artifacts: readonly Artifact[], devices: readonly CaptureDevice[], filters: CaptureFilters, sort: CaptureSort, sessions: readonly CaptureSession[] = []): Artifact[] {
  const deviceMap = new Map(devices.map((device) => [device.id, device]));
  const reservedDevices = new Set(sessions.filter((session) => session.state !== "closed").map((session) => session.deviceId));
  const query = filters.search.trim().toLocaleLowerCase();
  const rows = artifacts.filter((artifact) => {
    const device = deviceMap.get(artifact.deviceId);
    return !artifact.purgedAt && Boolean(artifact.deletedAt) === filters.trash &&
      (!filters.deviceId || artifact.deviceId === filters.deviceId) &&
      (!filters.platform || device?.platform === filters.platform) &&
      (!filters.kind || artifact.kind === filters.kind) &&
      (!filters.deviceKind || device?.kind === filters.deviceKind) &&
      (!filters.visibility || device?.visibility === filters.visibility) &&
      (!filters.health || (filters.health === "online" ? device?.online === true : filters.health === "offline" && device?.online === false)) &&
      (!filters.reservation || Boolean(device && (filters.reservation === "locked"
        ? device.locked === true
        : filters.reservation === "reserved"
          ? reservedDevices.has(device.id)
          : filters.reservation === "free" && device.online === true && device.locked === false && !reservedDevices.has(device.id)))) &&
      (!query || [artifact.name, artifact.deviceId, device?.name, device?.platform, artifact.kind, artifact.status, ...artifact.tags].join(" ").toLocaleLowerCase().includes(query));
  });
  const value = (artifact: Artifact): string | number => sort.column === "device"
    ? deviceMap.get(artifact.deviceId)?.name || artifact.deviceId
    : artifact[sort.column];
  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows.map((artifact, index) => ({ artifact, index })).sort((a, b) => {
    const left = value(a.artifact), right = value(b.artifact);
    const comparison = typeof left === "number" && typeof right === "number"
      ? left - right : collator.compare(String(left), String(right));
    return comparison * direction || a.index - b.index;
  }).map(({ artifact }) => artifact);
}

/** Only visible, completed/stopped captures may participate in a bulk action. */
export function visibleCaptureSelection(selected: readonly string[], visible: readonly Artifact[]): string[] {
  const eligible = new Set(visible.filter((artifact) => !captureIsBusy(artifact)).map((artifact) => artifact.id));
  return [...new Set(selected)].filter((id) => eligible.has(id));
}

export function captureBatches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += 100) batches.push(unique.slice(index, index + 100));
  return batches;
}

export function captureStorage(artifacts: readonly Artifact[]) {
  return artifacts.reduce((sum, artifact) => {
    if (artifact.purgedAt) return sum;
    const bucket = artifact.deletedAt ? sum.trash : sum.library;
    bucket.count++;
    bucket.bytes += Math.max(0, artifact.bytes || 0);
    return sum;
  }, { library: { count: 0, bytes: 0 }, trash: { count: 0, bytes: 0 } });
}

export function captureDownloadName(artifact: Pick<Artifact, "name" | "kind" | "path" | "cleanPath" | "logPath">, variant: CaptureVariant = "file") {
  const path = variant === "log" ? artifact.logPath : variant === "clean" ? artifact.cleanPath || artifact.path : artifact.path;
  const extension = path.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0] || (variant === "log" ? ".json" : artifact.kind === "recording" ? ".mp4" : ".png");
  const name = artifact.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "capture";
  const stem = name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? name.slice(0, -extension.length) : name;
  return `${stem}${variant === "clean" ? "-clean" : variant === "log" ? "-metadata" : ""}${extension}`;
}

export function formatCaptureBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: exponent ? 1 : 0 })} ${units[exponent]}`;
}
