import { Monitor, Usb } from "lucide-react";
import { DevicePicker, type DevicePickerDevice } from "./DevicePicker";
import "./workspace.css";

export type CardView = {
  id: string;
  name: string;
  uniqueId: string;
  status: "connected" | "missing";
  detail?: string;
  deviceId?: string;
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
              ? "Simulated USB capture inputs for this demo."
              : "Physical USB video inputs. Native simulator screens are in Devices."}
          </p>
        </div>
        <button onClick={refresh} disabled={loading || busy}>
          {loading ? "Discovering…" : "Discover / refresh"}
        </button>
      </div>
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
                <div className="capture-card-row">
                  <div className="card-title">
                    <span className="capture-card-icon" aria-hidden="true">
                      <Usb size={22} />
                    </span>
                    <div>
                      <h2 title={card.name}>{card.name}</h2>
                      <p className="card-connection">
                        {card.status === "connected"
                          ? "Connected to this Mac"
                          : "Capture card disconnected"}
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
                      busy={busy}
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
    </section>
  );
}
