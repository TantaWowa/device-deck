import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Monitor, Trash2 } from "lucide-react";
import { CaptureCardThumbnail } from "./CaptureCardThumbnail";
import { DevicePicker, type DevicePickerDevice } from "./DevicePicker";
import "./workspace.css";

export type CardView = {
  id: string;
  name: string;
  uniqueId: string;
  status: "connected" | "missing" | "unknown";
  detail?: string;
  deviceId?: string;
  thumbnailUrl?: string;
};
export type CardDevice = DevicePickerDevice & {
  captureSourceId: string | null;
  online: boolean;
  locked: boolean;
  owner?: string;
  reason?: string;
  recording?: boolean;
  captureOnly?: boolean;
};
export type CardAssignment = { card: CardView; deviceId: string | null };

function CardActionDialog({ kind, cards, devices, busy, error, close, submit }: {
  kind: "assign" | "delete";
  cards: CardView[];
  devices: CardDevice[];
  busy: boolean;
  error: string;
  close: () => void;
  submit: (assignments: CardAssignment[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(cards.map((card) => [card.uniqueId, card.deviceId || ""])),
  );
  useEffect(() => {
    const trigger = document.activeElement;
    dialog.current?.showModal();
    return () => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, []);
  const boundDevices = devices.filter((device) => cards.some((card) => card.deviceId === device.id));
  const customDevices = boundDevices.filter((device) => device.captureOnly);
  const targets = Object.values(values).filter(Boolean);
  const validation = new Set(targets).size !== targets.length
    ? "Each device can have only one capture card. Choose a different device or Unassigned."
    : customDevices.some((device) => !targets.includes(device.id))
      ? "Custom devices must keep a capture card. Assign them another selected card, or delete their card instead."
      : "";
  const changed = cards.some((card) => values[card.uniqueId] !== (card.deviceId || ""));
  const protectedDevice = devices.some((device) =>
    (boundDevices.includes(device) || (kind === "assign" && targets.includes(device.id))) &&
    (device.owner || device.recording),
  );
  return createPortal(
    <dialog ref={dialog} className="capture-card-dialog" aria-labelledby={title}
      onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
      <h2 id={title}>{kind === "delete" ? `Delete ${cards.length === 1 ? "capture card" : `${cards.length} capture cards`}?` : "Assign selected capture cards"}</h2>
      {kind === "delete" ? <>
        <p>These cards will stay hidden, even when connected, until you choose Show deleted cards. They can then be discovered and assigned again.</p>
        <ul>{cards.map((card) => <li key={card.uniqueId}>{card.name}</li>)}</ul>
        {customDevices.length > 0 && <p>These custom devices will also be removed because they depend on the selected cards: <strong>{customDevices.map((device) => device.name).join(", ")}</strong>.</p>}
        <p>Other devices will be unassigned. Saved captures and history will be kept.</p>
      </> : <>
        <p>Choose a device for each card, then save all assignments together.</p>
        <div className="capture-card-assignment-list">{cards.map((card) => <label key={card.uniqueId}>
          <span>{card.name}</span>
          <select aria-label={`Device for ${card.name}`} value={values[card.uniqueId]} disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setValues((current) => ({ ...current, [card.uniqueId]: value }));
            }}>
            <option value="">Unassigned</option>
            {devices.map((device) => {
              const unavailable = device.recording ? "Recording" : device.owner ? "Reserved"
                : device.captureSourceId && !cards.some((item) => item.id === device.captureSourceId)
                  ? "Already has a capture input" : "";
              return <option key={device.id} value={device.id} disabled={Boolean(unavailable)}>{device.name}{unavailable ? ` · ${unavailable}` : ""}</option>;
            })}
          </select>
        </label>)}</div>
        {validation && <p role="alert" className="workspace-error">{validation}</p>}
      </>}
      {protectedDevice && <p role="alert" className="workspace-error">Release the affected reservations and finish recording first.</p>}
      {error && <p role="alert" className="workspace-error">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className={kind === "delete" ? "card-danger" : "card-primary"}
          disabled={busy || protectedDevice || (kind === "assign" && (Boolean(validation) || !changed))}
          onClick={() => submit(cards.map((card) => ({ card, deviceId: values[card.uniqueId] || null })))}>
          {busy ? "Saving…" : kind === "delete" ? `Delete ${cards.length === 1 ? "card" : `${cards.length} cards`}` : "Save assignments"}
        </button>
      </footer>
    </dialog>, document.fullscreenElement || document.body,
  );
}

export function CaptureCards({
  hostName = "this Mac",
  cards,
  devices,
  busy,
  loading = false,
  diagnostics = [],
  refresh,
  assign,
  assignCustom,
  assignMany,
  remove,
  restoreDeleted,
  deletedCount = 0,
  viewMany,
  revision,
  view,
  demo = false,
}: {
  hostName?: string;
  cards: CardView[];
  devices: CardDevice[];
  busy: boolean;
  loading?: boolean;
  diagnostics?: string[];
  refresh: () => void;
  assign: (card: CardView, deviceId: string | null) => Promise<unknown>;
  assignCustom?: (card: CardView, name: string) => Promise<unknown>;
  assignMany?: (assignments: CardAssignment[]) => Promise<unknown>;
  remove?: (cards: CardView[]) => Promise<unknown>;
  restoreDeleted?: () => Promise<unknown>;
  deletedCount?: number;
  viewMany?: (ids: string[]) => void;
  revision?: string;
  view: (id: string) => void;
  demo?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ kind: "assign" | "delete"; cards: CardView[]; revision?: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [thumbnailRefresh, setThumbnailRefresh] = useState(0);
  const selectAll = useRef<HTMLInputElement>(null);
  const pending = busy || working;
  const chosen = cards.filter((card) => selected.includes(card.uniqueId));
  const selectedDevices = devices.filter((device) => chosen.some((card) => card.deviceId === device.id));
  const protectedSelection = selectedDevices.some((device) => device.owner || device.recording);
  const customSelection = selectedDevices.some((device) => device.captureOnly);
  const selectionEnabled = Boolean(assignMany || remove || viewMany);
  useEffect(() => {
    setSelected((current) => {
      const next = current.filter((id) => cards.some((card) => card.uniqueId === id));
      return next.length === current.length ? current : next;
    });
  }, [cards]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && chosen.length < cards.length;
  }, [chosen.length, cards.length]);
  useEffect(() => {
    if (dialog && dialog.revision !== revision && !working) {
      setDialog(null);
      setError("Configuration changed. Review the cards before trying again.");
    }
  }, [revision, dialog, working]);
  const run = async (action: () => Promise<unknown>, message: string) => {
    setWorking(true); setError(""); setNotice("");
    try {
      await action();
      setDialog(null); setSelected([]); setNotice(message);
    } catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  };
  const openDialog = (kind: "assign" | "delete", targets: CardView[]) => {
    setError(""); setNotice(""); setDialog({ kind, cards: targets, revision });
  };
  return (
    <section className="capture-card-page">
      <div className="workspace-heading">
        <div>
          <h1>Capture Cards</h1>
          <p>
            {demo
              ? "Simulated USB capture inputs for this demo."
              : "Physical USB video inputs. Native simulator screens are in Devices."}
          </p>
        </div>
        <div className="capture-card-heading-actions">
        {deletedCount > 0 && restoreDeleted && <button disabled={pending} onClick={() => void run(restoreDeleted, "Deleted cards can be discovered again. Reconnect any missing cards and assign devices as needed.")}>Show deleted cards ({deletedCount})</button>}
        <button onClick={() => { setThumbnailRefresh((value) => value + 1); refresh(); }} disabled={loading || pending}>
          {loading ? "Discovering…" : "Discover / refresh"}
        </button>
        </div>
      </div>
      {diagnostics.map((d, i) => (
        <p className="workspace-error" role="alert" key={i}>
          {d}
        </p>
      ))}
      {error && !dialog && <p className="workspace-error" role="alert">{error}</p>}
      {notice && <p role="status" className="card-scope">{notice}</p>}
      <div className="card-counts">
        <strong>{cards.length} cards</strong>
        <span>
          {cards.filter((c) => c.status === "connected").length} connected
        </span>
        <span>{cards.filter((c) => !c.deviceId).length} unassigned</span>
      </div>
      {selectionEnabled && cards.length > 0 && <div className="capture-card-bulk" role="group" aria-label="Capture card selection">
        <label><input ref={selectAll} type="checkbox" aria-label="Select all capture cards" disabled={pending}
          checked={chosen.length === cards.length} onChange={(event) => setSelected(event.target.checked ? cards.map((card) => card.uniqueId) : [])} />Select all</label>
        <strong>{chosen.length} selected</strong>
        {chosen.length > 0 && <>
          {viewMany && <button disabled={pending || !selectedDevices.length} onClick={() => viewMany(selectedDevices.map((device) => device.id))}>View selected</button>}
          {assignMany && <>
            <button disabled={pending || protectedSelection} onClick={() => openDialog("assign", chosen)}>Assign selected</button>
            <button disabled={pending || protectedSelection || customSelection || !selectedDevices.length}
              onClick={() => void run(() => assignMany(chosen.map((card) => ({ card, deviceId: null }))), "Selected cards unassigned.")}>Unassign selected</button>
          </>}
          {remove && <button className="card-danger" disabled={pending || protectedSelection} onClick={() => openDialog("delete", chosen)}>Delete selected</button>}
          <button disabled={pending} onClick={() => setSelected([])}>Clear selection</button>
          {protectedSelection && <p>Release the selected devices and finish recording before changing or deleting their cards.</p>}
          {!protectedSelection && customSelection && <p>Custom devices need a capture input. Reassign their cards together or delete the cards to remove those custom devices.</p>}
        </>}
      </div>}
      {!cards.length ? (
        <div className="workspace-empty">
          <h2>
            {loading
              ? "Looking for USB capture cards…"
              : "No capture cards found"}
          </h2>
          <p>Connect a USB capture card, then discover again.</p>
        </div>
      ) : (
        <div className="capture-card-grid">
          {cards.map((card) => {
            const device = devices.find((d) => d.id === card.deviceId);
            const reserved = Boolean(device?.owner || device?.recording);
            const state = device?.recording
              ? "Recording"
              : device?.owner
                ? "Reserved"
                : card.status === "unknown"
                  ? "Checking"
                : card.status === "missing"
                  ? "Disconnected"
                  : card.detail
                    ? "Unavailable"
                    : device?.locked
                      ? "Device locked"
                      : device && !device.online
                        ? "Device offline"
                        : "Available";
            return (
              <article
                key={card.uniqueId}
                className={`capture-card${selected.includes(card.uniqueId) ? " is-selected" : ""}`}
                aria-label={card.name}
              >
                <div className="capture-card-row">
                  <div className="card-title">
                    {selectionEnabled && <input type="checkbox" className="capture-card-select" aria-label={`Select ${card.name}`}
                      disabled={pending} checked={selected.includes(card.uniqueId)} onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((current) => checked ? [...current, card.uniqueId] : current.filter((id) => id !== card.uniqueId));
                      }} />}
                    <CaptureCardThumbnail name={device?.name || card.name} endpoint={card.thumbnailUrl}
                      refreshKey={thumbnailRefresh} paused={pending || Boolean(dialog)} sample={demo}
                      unavailable={card.status === "missing" ? "Disconnected" : card.status === "unknown" ? "Checking…" : device?.locked ? "Device locked" : card.detail || ""} />
                    <div>
                      <h2 title={card.name}>{card.name}</h2>
                      <p className="card-connection">
                        {card.status === "connected"
                          ? `Connected to ${hostName}`
                          : card.status === "unknown" ? "Checking capture card…" : "Capture card disconnected"}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`card-state ${state.toLowerCase().replaceAll(" ", "-")}`}
                  >
                    {state}
                  </span>
                  <div className="card-picker">
                    <DevicePicker
                      label={`Assigned device for ${card.name}`}
                      title={`Assign device · ${card.name}`}
                      devices={devices}
                      value={card.deviceId || null}
                      busy={pending}
                      disabledReason={
                        reserved
                          ? "Release the device and finish recording before changing its assignment."
                          : undefined
                      }
                      getDisabledReason={(target) => {
                        if (target.id === card.deviceId) return undefined;
                        if (device?.captureOnly)
                          return "This custom device must keep its USB input. Choose Other to rename it.";
                        if (target.recording)
                          return "Finish recording before assigning this device.";
                        if (target.owner)
                          return "Release this device's reservation before assigning it.";
                        if (target.captureSourceId)
                          return "This device already has a capture input. Unassign that input first.";
                        return undefined;
                      }}
                      onSelect={(id) => assign(card, id)}
                      onCustom={
                        assignCustom
                          ? (name) => assignCustom(card, name)
                          : undefined
                      }
                      customName={
                        device?.captureOnly ? device.name : undefined
                      }
                      allowUnassign={!device?.captureOnly}
                    />
                  </div>
                  <div className="card-view-action">
                    {device && (
                      <button
                        className="capture-card-view"
                        aria-label={`View ${device.name}`}
                        onClick={() => view(device.id)}
                      >
                        <Monitor size={15} aria-hidden="true" />
                        View
                      </button>
                    )}
                    {remove && <button type="button" className="capture-card-delete card-danger" aria-label={`Delete ${card.name}`} title={reserved ? "Release the device and finish recording first." : `Delete ${card.name}`}
                      disabled={pending || reserved} onClick={() => openDialog("delete", [card])}><Trash2 size={15} aria-hidden="true" /><span>Delete</span></button>}
                  </div>
                </div>
                <details className="capture-card-details">
                  <summary aria-label={`Details for ${card.name}`}>
                    Details
                  </summary>
                  <div className="capture-card-detail-content">
                    <div className="hardware-id">
                      Stable hardware ID<code>{card.uniqueId}</code>
                    </div>
                    {device && (
                      <p>
                        {device.owner
                          ? `${device.owner} · ${device.reason || "Reserved"}`
                          : device.online
                            ? "Device online"
                            : "Device offline"}
                        {device.recording && " · Recording in progress"}
                      </p>
                    )}
                    {card.detail && (
                      <p className="workspace-error">{card.detail}</p>
                    )}
                    {reserved && (
                      <p>
                        Release the device and finish recording before changing
                        its assignment.
                      </p>
                    )}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}
      {dialog && <CardActionDialog kind={dialog.kind} cards={dialog.cards.map((card) => cards.find((current) => current.uniqueId === card.uniqueId) || card)}
        devices={devices} busy={pending} error={error} close={() => { setDialog(null); setError(""); }}
        submit={(assignments) => void run(
          () => dialog.kind === "delete" ? remove!(dialog.cards) : assignMany!(assignments),
          dialog.kind === "delete" ? "Capture cards deleted. Saved captures and history were kept." : "Capture card assignments saved.",
        )} />}
    </section>
  );
}
