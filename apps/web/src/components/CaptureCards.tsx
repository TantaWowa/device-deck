import { useEffect, useState } from "react";
import "./workspace.css";
const CUSTOM_DEVICE = "custom:";
export type CardView = {
  id: string;
  name: string;
  uniqueId: string;
  status: "connected" | "missing";
  detail?: string;
  deviceId?: string;
};
export type CardDevice = {
  id: string;
  name: string;
  captureSourceId: string | null;
  online: boolean;
  locked: boolean;
  owner?: string;
  reason?: string;
  recording?: boolean;
  captureOnly?: boolean;
};
function Assignment({
  card,
  devices,
  busy,
  assign,
  assignCustom,
}: {
  card: CardView;
  devices: CardDevice[];
  busy: boolean;
  assign: (deviceId: string | null) => Promise<unknown>;
  assignCustom?: (name: string) => Promise<unknown>;
}) {
  const [target, setTarget] = useState(card.deviceId || ""),
    [name, setName] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const current = devices.find((d) => d.id === card.deviceId),
    selected = devices.find((d) => d.id === target),
    custom = target === CUSTOM_DEVICE,
    pending = busy || saving;
  useEffect(() => {
    setTarget(card.deviceId || "");
    setError("");
  }, [card.deviceId, current?.name]);
  const conflict =
    target && target !== card.deviceId && selected?.captureSourceId
      ? "That device already has a capture input. Unassign its current input first."
      : "";
  const reserved = Boolean(current?.owner || current?.recording);
  return (
    <form
      className="card-assignment"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending || reserved || conflict) return;
        setError("");
        setSaving(true);
        try {
          if (custom && assignCustom) await assignCustom(name.trim());
          else await assign(target || null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        Assigned device
        <select
          aria-label={`Assigned device for ${card.name}`}
          value={target}
          disabled={pending || reserved}
          onChange={(e) => {
            setTarget(e.target.value);
            if (e.target.value === CUSTOM_DEVICE)
              setName(current?.captureOnly ? current.name : "");
            setError("");
          }}
        >
          <option value="">Unassigned</option>
          {assignCustom && (
            <option value={CUSTOM_DEVICE}>Custom device…</option>
          )}
          {devices.map((d) => (
            <option
              key={d.id}
              value={d.id}
              disabled={
                Boolean(d.owner || d.recording) && d.id !== card.deviceId
              }
            >
              {d.name}
              {d.owner
                ? " · reserved"
                : d.captureSourceId && d.id !== card.deviceId
                  ? " · input assigned"
                  : ""}
            </option>
          ))}
        </select>
      </label>
      {custom && (
        <>
          <label>
            Device name
            <input
              aria-label={`Custom device name for ${card.name}`}
              autoFocus
              required
              maxLength={64}
              placeholder="e.g. Mac mini"
              value={name}
              disabled={pending || reserved}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
            />
          </label>
          <small>
            {current?.captureOnly
              ? "Rename this device and keep its capture history. "
              : "Name any HDMI device, such as a Mac mini or console. "}
            View, screenshot and record through this card. Remote control
            requires a supported connection.
          </small>
        </>
      )}
      <button
        disabled={
          pending ||
          reserved ||
          (custom && !name.trim()) ||
          target === (card.deviceId || "") ||
          Boolean(conflict)
        }
        type="submit"
      >
        {saving
          ? "Saving…"
          : custom
            ? current?.captureOnly
              ? "Save device name"
              : "Create & assign"
            : "Apply assignment"}
      </button>
      {custom ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setTarget(card.deviceId || "");
            setError("");
          }}
        >
          Cancel
        </button>
      ) : (
        card.deviceId && (
          <button
            type="button"
            disabled={pending || reserved}
            onClick={() => {
              setError("");
              void assign(null).catch((e) => setError(e.message));
            }}
          >
            Unassign
          </button>
        )
      )}
      {reserved && (
        <small>
          Release the device and finish recording before changing its binding.
        </small>
      )}
      {conflict && (
        <p className="workspace-error" role="alert">
          {conflict}
        </p>
      )}
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export function CaptureCards({
  cards,
  devices,
  busy,
  loading = false,
  diagnostics = [],
  refresh,
  assign,
  assignCustom,
  view,
  demo = false,
}: {
  cards: CardView[];
  devices: CardDevice[];
  busy: boolean;
  loading?: boolean;
  diagnostics?: string[];
  refresh: () => void;
  assign: (card: CardView, deviceId: string | null) => Promise<unknown>;
  assignCustom?: (card: CardView, name: string) => Promise<unknown>;
  view: (id: string) => void;
  demo?: boolean;
}) {
  return (
    <section className="capture-card-page">
      <div className="workspace-heading">
        <div>
          <h1>Capture Cards</h1>
          <p>
            {demo
              ? "Simulated USB capture cards for this demo."
              : "Physical USB video inputs detected on this Mac, including configured cards that are disconnected."}
          </p>
        </div>
        <button onClick={refresh} disabled={loading || busy}>
          {loading ? "Discovering…" : "Discover / refresh"}
        </button>
      </div>
      <p className="card-scope">
        Native emulator and simulator screens stay in Devices. USB webcams may
        also appear as video inputs; choose the card connected to your device's
        HDMI output.
      </p>
      {diagnostics.map((d, i) => (
        <p className="workspace-error" role="alert" key={i}>
          {d}
        </p>
      ))}
      <div className="card-counts">
        <strong>{cards.length} cards</strong>
        <span>
          {cards.filter((c) => c.status === "connected").length} connected
        </span>
        <span>{cards.filter((c) => !c.deviceId).length} unassigned</span>
      </div>
      {!cards.length ? (
        <div className="workspace-empty">
          <h2>
            {loading
              ? "Looking for USB capture cards…"
              : "No capture cards found"}
          </h2>
          <p>
            Connect a USB capture card, then discover again. Configured cards
            stay here when disconnected.
          </p>
        </div>
      ) : (
        <div className="capture-card-grid">
          {cards.map((card) => {
            const device = devices.find((d) => d.id === card.deviceId);
            const state = device?.recording
              ? "Recording"
              : device?.owner
                ? "Reserved"
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
                className="capture-card"
                aria-label={card.name}
              >
                <div className="card-title">
                  <h2>{card.name}</h2>
                  <span
                    className={`card-state ${state === "Available" ? "available" : ""}`}
                  >
                    {state}
                  </span>
                </div>
                <p className="card-connection">
                  {card.status === "connected"
                    ? "Connected to this Mac"
                    : "Configured card is missing"}
                </p>
                <label className="hardware-id">
                  Stable hardware ID<code>{card.uniqueId}</code>
                </label>
                <div className="card-ownership">
                  {device ? (
                    <>
                      <button
                        className="card-device-link"
                        onClick={() => view(device.id)}
                      >
                        {device.name} →
                      </button>
                      <p>
                        {device.owner
                          ? `${device.owner} · ${device.reason || "Reserved"}`
                          : device.online
                            ? "Device online"
                            : "Device offline"}
                      </p>
                    </>
                  ) : (
                    <p>
                      Unassigned. Choose a device
                      {assignCustom ? " or enter a custom one." : "."}
                    </p>
                  )}
                  {card.detail && !device?.owner && <p>{card.detail}</p>}
                </div>
                <Assignment
                  card={card}
                  devices={devices}
                  busy={busy}
                  assign={(id) => assign(card, id)}
                  assignCustom={
                    assignCustom
                      ? (name) => assignCustom(card, name)
                      : undefined
                  }
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
