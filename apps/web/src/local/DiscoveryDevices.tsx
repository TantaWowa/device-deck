import React, { useRef, useEffect, useState } from "react";
import {
  isDeviceConfigured,
  registrationIssue,
  type DiscoveredDevices,
} from "../../../../packages/core/src/discovery";
import type {
  Config,
  DeviceConfig,
} from "../../../../packages/core/src/local/types";

export function DiscoveryDevices({
  config,
  discovery,
  add,
  configure,
}: {
  config: Config;
  discovery: DiscoveredDevices;
  add: (ids: string[]) => Promise<void>;
  configure: (device: DeviceConfig) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const all = useRef<HTMLInputElement>(null);
  const available = discovery.devices.filter(
    (d) => !isDeviceConfigured(config, d) && !registrationIssue(d),
  );
  const chosen = available.filter((d) => selected.includes(d.id));
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        chosen.length > 0 && chosen.length < available.length;
  }, [chosen.length, available.length]);
  const register = async (ids: string[]) => {
    setSaving(true);
    setError("");
    try {
      await add(ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <p>
        Add devices together using their discovered names. Duplicate names
        receive a number. Native screens connect automatically; choose USB
        capture cards afterward.
      </p>
      <div className="live-discovery-toolbar">
        <label>
          <input
            ref={all}
            type="checkbox"
            aria-label="Select all new devices"
            disabled={saving || !available.length}
            checked={available.length > 0 && chosen.length === available.length}
            onChange={(e) =>
              setSelected(e.target.checked ? available.map((d) => d.id) : [])
            }
          />{" "}
          Select all
        </label>
        <span>
          {chosen.length} of {available.length} new devices selected
        </span>
        <button
          disabled={saving || !chosen.length}
          onClick={() => void register(chosen.map((d) => d.id))}
        >
          Add selected ({chosen.length})
        </button>
        <button
          className="primary"
          disabled={saving || !available.length}
          onClick={() => void register(available.map((d) => d.id))}
        >
          {saving ? "Adding devices…" : `Add all (${available.length})`}
        </button>
      </div>
      {error && (
        <p className="live-alert" role="alert">
          {error}
        </p>
      )}
      {!discovery.devices.length && (
        <p>No devices found. Connect a device and discover again.</p>
      )}
      {discovery.devices.length > 0 && !available.length && (
        <p role="status">No new devices are ready to add.</p>
      )}
      <div className="live-discovery">
        {discovery.devices.map((device) => {
          const configured = isDeviceConfigured(config, device);
          const issue = configured ? undefined : registrationIssue(device);
          return (
            <div key={device.id}>
              <label className="live-discovery-device">
                <input
                  type="checkbox"
                  aria-label={`Select ${device.name} (${device.id})`}
                  disabled={saving || configured || Boolean(issue)}
                  checked={
                    !configured && !issue && selected.includes(device.id)
                  }
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, device.id]
                        : ids.filter((id) => id !== device.id),
                    )
                  }
                />
                <span>
                  <strong>{device.name}</strong>
                  <small>
                    {device.platform} · {device.kind} · {device.model}
                  </small>
                  {issue && <small>{issue}</small>}
                </span>
              </label>
              {configured ? (
                <span className="live-discovery-configured">Configured</span>
              ) : (
                <button disabled={saving} onClick={() => configure(device)}>
                  Configure…
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
