import { useEffect, useState } from "react";
import "./workspace.css";
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
};
function Assignment({
  card,
  devices,
  busy,
  assign,
}: {
  card: CardView;
  devices: CardDevice[];
  busy: boolean;
  assign: (deviceId: string | null) => Promise<unknown>;
}) {
  const [target, setTarget] = useState(card.deviceId || ""),
    [error, setError] = useState("");
  useEffect(() => {
    setTarget(card.deviceId || "");
    setError("");
  }, [card.deviceId]);
  const current = devices.find((d) => d.id === card.deviceId),
    selected = devices.find((d) => d.id === target);
  const conflict =
    target && target !== card.deviceId && selected?.captureSourceId
      ? "That device already has a capture input. Unassign its current input first."
      : "";
  const reserved = Boolean(current?.owner || current?.recording);
  return (
    <form
      className="card-assignment"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        void assign(target || null).catch((e) => setError(e.message));
      }}
    >
      <label>
        Assigned device
        <select
          aria-label={`Assigned device for ${card.name}`}
          value={target}
          disabled={busy || reserved}
          onChange={(e) => {
            setTarget(e.target.value);
            setError("");
          }}
        >
          <option value="">Unassigned</option>
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
      <button
        disabled={
          busy ||
          reserved ||
          target === (card.deviceId || "") ||
          Boolean(conflict)
        }
        type="submit"
      >
        Apply assignment
      </button>
      {card.deviceId && (
        <button
          type="button"
          disabled={busy || reserved}
          onClick={() => {
            setError("");
            void assign(null).catch((e) => setError(e.message));
          }}
        >
          Unassign
        </button>
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
                    <p>Unassigned. Choose an available configured device.</p>
                  )}
                  {card.detail && !device?.owner && <p>{card.detail}</p>}
                </div>
                <Assignment
                  card={card}
                  devices={devices}
                  busy={busy}
                  assign={(id) => assign(card, id)}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
