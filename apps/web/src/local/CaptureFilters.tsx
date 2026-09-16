import { Search, X } from "lucide-react";
import type { Artifact } from "../../../../packages/core/src/local/types";
import { emptyCaptureFilters, hasCaptureFilters, type CaptureDevice, type CaptureFilters as CaptureFilterValues } from "../../../../packages/core/src/capture-library";
import "./capture-filters.css";

type FilterOption = readonly [value: string, label: string, count?: number];

function FilterGroup({ label, ariaLabel, value, options, onChange }: {
  label: string; ariaLabel: string; value: string; options: readonly FilterOption[]; onChange: (value: string) => void;
}) {
  return <div className="capture-filter-group" role="group" aria-label={ariaLabel}>
    <span className="capture-filter-label">{label}</span>
    <div className="capture-filter-buttons">{options.map(([option, text, count]) => <button
      key={option} type="button" className={`capture-filter-${option.toLowerCase() || "all"}`}
      aria-pressed={value === option} onClick={() => onChange(value === option ? "" : option)}>
      {text}{count !== undefined && <span aria-hidden="true">{count}</span>}
    </button>)}</div>
  </div>;
}

/** Device filters mirror the workspace controls; capture-specific filters stay visible beside them. */
export function CaptureFilters({ value, onChange, devices, artifacts }: {
  value: CaptureFilterValues;
  onChange: (value: CaptureFilterValues) => void;
  devices: readonly CaptureDevice[];
  artifacts: readonly Artifact[];
}) {
  const update = (changes: Partial<CaptureFilterValues>) => onChange({ ...value, ...changes });
  const library = artifacts.filter((artifact) => !artifact.purgedAt && Boolean(artifact.deletedAt) === value.trash);
  const deviceMap = new Map(devices.map((device) => [device.id, device]));
  const historicalIds = [...new Set(artifacts.filter((artifact) => !artifact.purgedAt && !deviceMap.has(artifact.deviceId)).map((artifact) => artifact.deviceId))];
  const options = [...devices.map((device) => ({ id: device.id, name: device.name, platform: String(device.platform) })), ...historicalIds.map((id) => ({ id, name: `${id} · removed`, platform: "" }))].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const platforms: FilterOption[] = [["", "All platforms"], ["Apple", "Apple"], ["Roku", "Roku"], ["Android", "Android"], ["Other", "Other"]].map(([platform, label]) => [platform, label, library.filter((artifact) => !platform || deviceMap.get(artifact.deviceId)?.platform === platform).length]);
  return <div className="capture-filter-bar" aria-label="Capture filters">
    <div className="capture-filter-primary">
      <FilterGroup label="Platform" ariaLabel="Filter capture platform" value={value.platform} options={platforms} onChange={(platform) => update({ platform, deviceId: value.deviceId && platform && deviceMap.get(value.deviceId)?.platform !== platform ? "" : value.deviceId })} />
      <FilterGroup label="Device type" ariaLabel="Filter capture device type" value={value.deviceKind || ""} options={[["", "All types"], ["virtual", "Sim"], ["physical", "Real"]]} onChange={(deviceKind) => update({ deviceKind })} />
      <label className="capture-filter-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search captures" placeholder="Search name, device or tags" value={value.search} onChange={(event) => update({ search: event.target.value })} />{value.search && <button type="button" aria-label="Clear capture search" onClick={() => update({ search: "" })}><X size={14} /></button>}</label>
    </div>
    <div className="capture-filter-secondary">
      <FilterGroup label="Connection" ariaLabel="Filter capture connection" value={value.health || ""} options={[["", "All"], ["online", "Online"], ["offline", "Offline"]]} onChange={(health) => update({ health })} />
      <FilterGroup label="Availability" ariaLabel="Filter capture availability" value={value.reservation || ""} options={[["", "All"], ["free", "Available"], ["reserved", "Reserved"], ["locked", "Locked"]]} onChange={(reservation) => update({ reservation })} />
      <FilterGroup label="Visibility" ariaLabel="Filter capture visibility" value={value.visibility || ""} options={[["", "All"], ["local", "Local"], ["shared", "Shared"]]} onChange={(visibility) => update({ visibility })} />
    </div>
    <div className="capture-filter-specific">
      <FilterGroup label="Capture type" ariaLabel="Filter capture type" value={value.kind} options={[["", "All captures"], ["screenshot", "Screenshots"], ["recording", "Recordings"]]} onChange={(kind) => update({ kind })} />
      <label className="capture-filter-device"><span className="capture-filter-label">Device</span><select aria-label="Capture device" value={value.deviceId} onChange={(event) => update({ deviceId: event.target.value })}><option value="">All devices</option>{options.filter((device) => !value.platform || device.platform === value.platform).map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
      <button type="button" className="capture-filter-reset" disabled={!hasCaptureFilters(value)} onClick={() => onChange({ ...emptyCaptureFilters, trash: value.trash })}>Reset filters</button>
    </div>
  </div>;
}
