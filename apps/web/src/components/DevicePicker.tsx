import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Check,
  ChevronsUpDown,
  Laptop,
  Monitor,
  Search,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import {
  deviceClass,
  filterPickerDevices,
  type DevicePickerItem,
} from "../../../../packages/core/src/device-picker";
import "./device-picker.css";

export type DevicePickerDevice = DevicePickerItem & {
  captureSourceId?: string | null;
  online?: boolean;
  locked?: boolean;
  owner?: string;
  reason?: string;
  recording?: boolean;
  captureOnly?: boolean;
};
type PickerProps = {
  label: string;
  title?: string;
  devices: DevicePickerDevice[];
  value: string | null;
  busy?: boolean;
  disabledReason?: string;
  getDisabledReason?: (device: DevicePickerDevice) => string | undefined;
  onSelect: (id: string | null) => Promise<unknown>;
  onCustom?: (name: string) => Promise<unknown>;
  customName?: string;
  allowUnassign?: boolean;
};
const classes = [
  ["tv", "TV"],
  ["phone", "Phone"],
  ["tablet", "Tablet"],
  ["computer", "Computer"],
  ["other", "Other"],
] as const;
function DeviceIcon({ device }: { device?: DevicePickerDevice }) {
  const kind = device ? deviceClass(device) : "other";
  const Icon =
    kind === "tv"
      ? Monitor
      : kind === "phone"
        ? Smartphone
        : kind === "tablet"
          ? Tablet
          : kind === "computer"
            ? Laptop
            : Box;
  return <Icon size={19} aria-hidden="true" />;
}
function FilterButtons({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="device-picker-filters" role="group" aria-label={label}>
      <span className="device-picker-filter-label" aria-hidden="true">
        {label}
      </span>
      <div>
        {[["", "All"], ...options].map(([key, text]) => (
          <button
            type="button"
            key={key}
            aria-pressed={value === key}
            className={`device-picker-chip family-${key.toLowerCase()}`}
            onClick={() => onChange(key)}
            disabled={disabled}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
function PickerDialog({
  title,
  devices,
  value,
  busy = false,
  disabledReason,
  getDisabledReason,
  onSelect,
  onCustom,
  customName,
  allowUnassign = true,
  onClose,
}: PickerProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [family, setFamily] = useState("");
  const [kind, setKind] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [name, setName] = useState(customName || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = busy || saving;
  const current = devices.find((device) => device.id === value);
  const results = filterPickerDevices(devices, {
    family,
    kind,
    deviceClass: category,
    search,
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    searchInput.current?.focus();
    return () => element?.close();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const save = async (operation: () => Promise<unknown>) => {
    if (pending || disabledReason) return;
    setSaving(true);
    setError("");
    try {
      await operation();
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const focusOptions = () =>
    Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>(
        "[data-picker-option]:not(:disabled)",
      ) || [],
    );
  return (
    <dialog
      ref={dialog}
      className="device-picker-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || pending) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
      <header className="device-picker-header">
        <div>
          <h2 id={titleId}>{title || "Choose a device"}</h2>
          <p>
            {onCustom
              ? "Select a device, or name your own under Other."
              : "Filter the list and select a device."}
          </p>
        </div>
        <button
          type="button"
          className="device-picker-close"
          aria-label="Close device picker"
          onClick={close}
          disabled={pending}
        >
          <X size={19} />
        </button>
      </header>
      <div className="device-picker-tools">
        <label className="device-picker-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label="Search devices"
            placeholder="Search devices by name or model"
            value={search}
            disabled={pending}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusOptions()[0]?.focus();
              }
            }}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear device search"
              onClick={() => {
                setSearch("");
                searchInput.current?.focus();
              }}
              disabled={pending}
            >
              <X size={15} />
            </button>
          )}
        </label>
        <FilterButtons
          label="Family"
          value={family}
          options={[
            ["Roku", "Roku"],
            ["Android", "Android"],
            ["Apple", "Apple"],
            ["Other", "Other"],
          ]}
          onChange={setFamily}
          disabled={pending}
        />
        <FilterButtons
          label="Class"
          value={category}
          options={classes}
          onChange={setCategory}
          disabled={pending}
        />
        <FilterButtons
          label="Type"
          value={kind}
          options={[
            ["physical", "Physical"],
            ["virtual", "Simulator"],
          ]}
          onChange={setKind}
          disabled={pending}
        />
      </div>
      {disabledReason && (
        <p className="device-picker-warning" role="status">
          {disabledReason}
        </p>
      )}
      <div className="device-picker-results-heading">
        <span>
          {results.length} {results.length === 1 ? "device" : "devices"}
        </span>
        {(family || category || kind || search) && (
          <button
            type="button"
            onClick={() => {
              setFamily("");
              setCategory("");
              setKind("");
              setSearch("");
            }}
            disabled={pending}
          >
            Reset filters
          </button>
        )}
      </div>
      <ul
        className="device-picker-list"
        aria-label="Matching devices"
        onKeyDown={(event) => {
          const options = focusOptions();
          const index = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          let next: number;
          if (event.key === "ArrowDown")
            next = Math.min(options.length - 1, index + 1);
          else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = options.length - 1;
          else return;
          event.preventDefault();
          options[next]?.focus();
        }}
      >
        {results.map((device) => {
          const selected = device.id === value;
          const reason = disabledReason || getDisabledReason?.(device);
          const status =
            reason ||
            (device.recording
              ? "Recording"
              : device.owner
                ? `Reserved · ${device.owner}`
                : device.online === false
                  ? "Offline"
                  : "");
          const classLabel = classes.find(
            ([key]) => key === deviceClass(device),
          )![1];
          return (
            <li key={device.id}>
              <button
                type="button"
                data-picker-option
                aria-pressed={selected}
                className="device-picker-option"
                disabled={pending || Boolean(reason)}
                onClick={() => {
                  if (selected) close();
                  else void save(() => onSelect(device.id));
                }}
              >
                <span
                  className={`device-picker-icon family-${device.platform.toLowerCase()}`}
                >
                  <DeviceIcon device={device} />
                </span>
                <span className="device-picker-option-text">
                  <strong>{device.name}</strong>
                  <small>
                    {device.platform} · {classLabel} ·{" "}
                    {device.kind === "virtual" ? "Simulator" : "Physical"}
                  </small>
                  {status && (
                    <span className="device-picker-option-status">
                      {status}
                    </span>
                  )}
                </span>
                {selected && (
                  <Check
                    size={19}
                    className="device-picker-check"
                    aria-label="Assigned"
                  />
                )}
              </button>
            </li>
          );
        })}
        {!results.length && (
          <li className="device-picker-empty">
            <Box size={25} />
            <strong>No matching devices</strong>
            <span>Try another filter or search.</span>
          </li>
        )}
      </ul>
      {family === "Other" && onCustom && (
        <form
          className="device-picker-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void save(() => onCustom(name.trim()));
          }}
        >
          <label htmlFor={`${titleId}-name`}>
            {customName !== undefined
              ? "Rename this device"
              : "Name another device"}
          </label>
          <div>
            <input
              id={`${titleId}-name`}
              aria-label="Custom device name"
              value={name}
              maxLength={64}
              required
              placeholder="e.g. Mac mini"
              disabled={pending || Boolean(disabledReason)}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
            <button
              type="submit"
              className="device-picker-primary"
              disabled={pending || Boolean(disabledReason) || !name.trim()}
            >
              {saving
                ? "Saving…"
                : customName !== undefined
                  ? "Save name"
                  : "Create & assign"}
            </button>
          </div>
          <small>
            {customName !== undefined
              ? "Keeps this device’s capture history."
              : "View and capture an HDMI device without a remote connection."}
          </small>
        </form>
      )}
      {error && (
        <p className="device-picker-error" role="alert">
          {error}
        </p>
      )}
      <footer className="device-picker-footer">
        {value && allowUnassign ? (
          <button
            type="button"
            disabled={pending || Boolean(disabledReason)}
            onClick={() => void save(() => onSelect(null))}
          >
            Unassign
          </button>
        ) : (
          <span>
            {current
              ? `Assigned: ${current.name}`
              : "Choose a device to assign"}
          </span>
        )}
        <button type="button" disabled={pending} onClick={close}>
          Cancel
        </button>
      </footer>
    </dialog>
  );
}

/** Shared single-value picker; callers supply assignment rules and persistence. */
export function DevicePicker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const target = useRef({ value: props.value, customName: props.customName });
  const restoreFocus = useRef(false);
  const current = props.devices.find((device) => device.id === props.value);
  useEffect(() => {
    const changed =
      target.current.value !== props.value ||
      target.current.customName !== props.customName;
    target.current = { value: props.value, customName: props.customName };
    if (changed && open) {
      setOpen(false);
    }
  }, [props.value, props.customName, open]);
  useEffect(() => {
    if (open) restoreFocus.current = true;
    else if (restoreFocus.current && !props.busy) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open, props.busy]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="device-picker-trigger"
        aria-label={props.label}
        aria-describedby={valueId}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen(true)}
      >
        <DeviceIcon device={current} />
        <span>
          <small>Assigned device</small>
          <strong id={valueId}>
            {current?.name || "Choose a device…"}
          </strong>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <PickerDialog
            {...props}
            onClose={() => {
              setOpen(false);
            }}
          />,
          document.fullscreenElement || document.body,
        )}
    </>
  );
}
