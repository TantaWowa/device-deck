import { useId, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import {
  deviceFilterFacets,
  emptyDeviceFilters,
  filterTableDevices,
  hasDeviceFilters,
  type DeviceFilterValues,
  type FilterableDevice,
  type FilterSession,
} from "../../../../packages/core/src/device-filters";
import { DeviceTypeFilter } from "./DeviceTypeFilter";
import "./device-filters.css";

const formFactorLabels: Record<string, string> = { tv: "TV", phone: "Phone & tablet", other: "Other" };

export function DeviceFilters({ value, devices, sessions, onChange }: {
  value: DeviceFilterValues;
  devices: readonly FilterableDevice[];
  sessions: readonly FilterSession[];
  onChange: (value: DeviceFilterValues) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const count = deviceFilterFacets.reduce((total, { key }) => total + value[key].length, 0);
  const active = hasDeviceFilters(value);
  const chips = deviceFilterFacets.flatMap(({ key, label, options }) => options
    .filter(([option]) => value[key].includes(option))
    .map(([option, text]) => ({ key, value: option, label, text })));
  const reset = () => { onChange(emptyDeviceFilters()); search.current?.focus(); };

  return <div className="device-filter-toolbar" onKeyDown={(event) => {
    if (event.key === "Escape" && expanded) {
      event.preventDefault(); setExpanded(false); toggle.current?.focus();
    }
  }}>
    <div className="device-filter-toolbar-main">
      <label className="device-filter-search"><Search size={16} aria-hidden="true" /><input
        ref={search} type="search" aria-label="Search devices" placeholder="Search name, model or tags…"
        value={value.search} onChange={(event) => onChange({ ...value, search: event.target.value })}
      />{value.search && <button type="button" aria-label="Clear device search" onClick={() => {
        onChange({ ...value, search: "" }); search.current?.focus();
      }}><X size={14} /></button>}</label>
      <DeviceTypeFilter value={value.formFactor} onChange={(formFactor) => onChange({ ...value, formFactor })} />
      <button ref={toggle} type="button" className="device-filter-toggle" aria-expanded={expanded} aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}><SlidersHorizontal size={15} aria-hidden="true" />Filters{count > 0 && <span>{count}</span>}</button>
    </div>
    {expanded && <div id={panelId} className="device-filter-options">
      {deviceFilterFacets.map((facet) => {
        const contextual = filterTableDevices(devices, value, sessions, facet.key);
        return <fieldset key={facet.key} aria-label={`Filter ${facet.label.toLowerCase()}`}>
          <legend>{facet.label}<span>Select any</span></legend>
          {facet.options.map(([option, text]) => {
            const matching = filterTableDevices(contextual, { ...emptyDeviceFilters(), [facet.key]: [option] }, sessions).length;
            return <label key={option}><input type="checkbox" checked={value[facet.key].includes(option)} onChange={(event) => onChange({
              ...value, [facet.key]: event.target.checked ? [...value[facet.key], option] : value[facet.key].filter((entry) => entry !== option),
            })} /><span>{text}</span><span className="device-filter-option-count" aria-label={`${matching} matching devices`}>{matching}</span></label>;
          })}
        </fieldset>;
      })}
    </div>}
    {active && <div className="device-filter-active" aria-label="Active device filters">
      {value.formFactor && <button type="button" className="device-filter-chip" aria-label={`Remove device type filter: ${formFactorLabels[value.formFactor]}`}
        onClick={() => { onChange({ ...value, formFactor: "" }); toggle.current?.focus(); }}>Device type: {formFactorLabels[value.formFactor]}<X size={12} aria-hidden="true" /></button>}
      {chips.map((chip) => <button key={`${chip.key}:${chip.value}`} type="button" className="device-filter-chip"
        aria-label={`Remove ${chip.label.toLowerCase()} filter: ${chip.text}`} onClick={() => {
          onChange({ ...value, [chip.key]: value[chip.key].filter((entry) => entry !== chip.value) }); toggle.current?.focus();
        }}>{chip.label}: {chip.text}<X size={12} aria-hidden="true" /></button>)}
      <button type="button" className="device-filter-clear" onClick={reset}>Clear all filters</button>
    </div>}
  </div>;
}
