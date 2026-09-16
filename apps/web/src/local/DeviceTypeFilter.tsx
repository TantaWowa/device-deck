import React from "react";
import "./device-type-filter.css";

export function DeviceTypeFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="device-type-filter">Device type
    <select aria-label="Filter device type" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">All device types</option>
      <option value="tv">TV</option>
      <option value="phone">Phone &amp; tablet</option>
      <option value="other">Other</option>
    </select>
  </label>;
}
