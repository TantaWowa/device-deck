import { Reports } from "../components/Reports";
import { CaptureCards, type CardView } from "../components/CaptureCards";
import { assignCaptureCard } from "../../../../packages/core/src/capture-cards";
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Monitor,
  Usb,
  Camera,
  History,
  BarChart3,
  Settings,
  Plus,
  Search,
  ArrowLeft,
  RefreshCw,
  Play,
  Square,
  Download,
  Copy,
  Trash2,
  Terminal,
  Columns2,
  Lock,
  Unlock,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  CornerUpLeft,
} from "lucide-react";
import { Brand } from "../../../../packages/ui/src";
import type {
  Snapshot,
  Device,
  DeviceConfig,
  Config,
  Artifact,
  Session,
  SourceConfig,
  Operation,
} from "../../../../packages/core/src/local/types";
import { api, bootstrap } from "./api";
import "../style.css";
import "./style.css";
type Lease = { session: Session; leaseToken: string };
type Tab =
  "Capture Cards" | "Devices" | "Captures" | "History" | "Reports" | "Settings";
const time = (value: number) => new Date(value).toLocaleString();
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const fileUrl = (a: Artifact, kind = "file") => `/v1/artifacts/${a.id}/${kind}`;
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="live-modal" onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <button onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
function Preview({
  device,
  active = true,
}: {
  device: Device;
  active?: boolean;
}) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let done = false,
      url = "",
      timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const r = await fetch(`/v1/preview/${encodeURIComponent(device.id)}`);
        if (!r.ok) {
          const e = await r.json();
          throw new Error(e.message);
        }
        const blob = await r.blob();
        if (done) return;
        const next = URL.createObjectURL(blob);
        if (url) URL.revokeObjectURL(url);
        url = next;
        setSrc(next);
        setError("");
      } catch (e) {
        if (!done) setError((e as Error).message);
      } finally {
        if (!done) timer = setTimeout(update, 1000);
      }
    };
    void update();
    return () => {
      done = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [device.id, active]);
  return (
    <div className="live-screen">
      {src && !error ? (
        <img src={src} alt={`Live screen of ${device.name}`} />
      ) : (
        <div className="live-screen-message">
          <Monitor size={32} />
          <strong>{error || "Connecting to capture input…"}</strong>
          <span>
            {device.captureSourceId
              ? "Check device, source and host permissions."
              : "Choose a capture input for this device."}
          </span>
        </div>
      )}
      <span className="live-screen-label">
        Local capture · refreshes about once a second
      </span>
    </div>
  );
}
function App() {
  const [cards, setCards] = useState<{
    sources: (SourceConfig & {
      status: "connected" | "missing";
      detail?: string;
    })[];
    diagnostics: string[];
  }>({ sources: [], diagnostics: [] });
  const [cardsLoading, setCardsLoading] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<Tab>("Devices");
  const refreshCards = async () => {
    setCardsLoading(true);
    try {
      setCards(await api("capture-cards.list"));
    } catch (e) {
      setCards((prev) => ({ ...prev, diagnostics: [(e as Error).message] }));
    } finally {
      setCardsLoading(false);
    }
  };
  useEffect(() => {
    if (tab !== "Capture Cards" || !data) return;
    void refreshCards();
    const timer = setInterval(refreshCards, 10000);
    return () => clearInterval(timer);
  }, [tab, Boolean(data), data?.configRevision]);
  const [filter, setFilter] = useState({
      search: "",
      platform: "",
      health: "",
      reservation: "",
      kind: "",
      visibility: "",
    }),
    [selected, setSelected] = useState<string[]>([]),
    [viewing, setViewing] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [hover, setHover] = useState("");
  const [leases, setLeases] = useState<Record<string, Lease>>(() => {
    try {
      return JSON.parse(localStorage.getItem("deck-local-leases") || "{}");
    } catch {
      return {};
    }
  });
  const [discovery, setDiscovery] = useState<{
      devices: DeviceConfig[];
      sources: SourceConfig[];
      diagnostics: string[];
    } | null>(null),
    [showDiscovery, setShowDiscovery] = useState(false),
    [editing, setEditing] = useState<DeviceConfig | false | null>(null);
  const [deviceEditRevision, setDeviceEditRevision] = useState("");
  useEffect(() => {
    if (editing !== null && data) setDeviceEditRevision(data.configRevision);
  }, [editing]);
  const [reserve, setReserve] = useState<{
      device: Device;
      takeover?: boolean;
    } | null>(null),
    [maintenance, setMaintenance] = useState<
      "lock" | "unlock" | "restart" | null
    >(null),
    [reason, setReason] = useState(""),
    [owner, setOwner] = useState("You"),
    [text, setText] = useState("");
  const [captureMode, setCaptureMode] = useState<"clean" | "annotated">(
      "clean",
    ),
    [overlay, setOverlay] = useState(true),
    [captureSearch, setCaptureSearch] = useState(""),
    [trash, setTrash] = useState(false),
    [artifact, setArtifact] = useState<Artifact | null>(null),
    [captureSelection, setCaptureSelection] = useState<string[]>([]),
    [purging, setPurging] = useState(false);
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const d = await api("inventory");
      setData(d);
      setConnectionError("");
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      polling.current = false;
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    void bootstrap()
      .then(async () => {
        if (!stopped) await refresh();
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(refresh, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(
    () => localStorage.setItem("deck-local-leases", JSON.stringify(leases)),
    [leases],
  );
  const initialized = useRef(false);
  useEffect(() => {
    if (data && !initialized.current) {
      setOwner(data.config.settings.owner);
      setCaptureMode(data.config.settings.captureMode);
      setOverlay(data.config.settings.overlay);
      initialized.current = true;
    }
  }, [data]);
  const action = async (op: Operation, args: unknown = {}, success = "") => {
    setBusy(true);
    setError("");
    try {
      const result = await api(op, args);
      if (success) setNotice(success);
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const perform = (fn: () => Promise<unknown>) => {
    void fn().catch(() => {});
  };
  const activeSession = (id: string) =>
    data?.sessions.find((s) => s.deviceId === id && s.state !== "closed");
  const credentials = (id: string) => {
    const lease = leases[id];
    const current = activeSession(id);
    return lease &&
      current?.id === lease.session.id &&
      current.state === "active" &&
      current.expiresAt > Date.now()
      ? { sessionId: current.id, leaseToken: lease.leaseToken }
      : null;
  };
  const saveConfig = async (config: Config, revision = data!.configRevision) =>
    action("config.save", { config, revision }, "Configuration saved.");
  const send = async (key: string) => {
    const lease = credentials(target);
    if (!lease) throw new Error("Reserve the target device first.");
    return action("remote.input", { ...lease, key });
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        !viewing.length ||
        busy ||
        document.querySelector("dialog[open]") ||
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      const keys: Record<string, string> = {
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Enter: "OK",
        Escape: "Back",
        " ": "Play",
      };
      if (keys[event.key] && credentials(target)) {
        event.preventDefault();
        perform(() => send(keys[event.key]));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const openViewer = (ids: string[]) => {
    setViewing(ids);
    setTarget(ids[0] || "");
    setHover("");
  };
  if (!data)
    return (
      <main className="live-loading">
        <Brand />
        <h1>Your local device workspace</h1>
        <p>{connectionError || error || "Connecting to Device Deck…"}</p>
        <pre>
          devdeck start
          <br />
          devdeck ui
        </pre>
      </main>
    );
  const devices = data.devices.filter(
    (d) =>
      (!filter.search ||
        `${d.name} ${d.model}`
          .toLowerCase()
          .includes(filter.search.toLowerCase())) &&
      (!filter.platform || d.platform === filter.platform) &&
      (!filter.health || (filter.health === "online" ? d.online : !d.online)) &&
      (!filter.kind || d.kind === filter.kind) &&
      (!filter.visibility || d.visibility === filter.visibility) &&
      (!filter.reservation ||
        (filter.reservation === "locked"
          ? d.locked
          : filter.reservation === "reserved"
            ? !!activeSession(d.id)
            : !activeSession(d.id) && !d.locked && d.online)),
  );
  const chosen = data.devices.find((d) => d.id === target),
    lease = credentials(target),
    current = activeSession(target),
    recording = data.recordings.find((r) => r.deviceId === target);
  const sources: SourceConfig[] = [
    ...data.config.sources,
    ...cards.sources,
    ...(discovery?.sources || []),
  ]
    .filter(
      (s, index, list) =>
        list.findIndex((x) =>
          s.kind === "usb" && s.uniqueId
            ? x.kind === "usb" && x.uniqueId === s.uniqueId
            : x.id === s.id,
        ) === index,
    )
    .map(({ id, name, kind, uniqueId, deviceId }) => ({
      id,
      name,
      kind,
      uniqueId,
      deviceId,
    }));
  const changeSource = (d: Device, id: string) => {
    const config = structuredClone(data.config);
    config.devices = config.devices.map((x) =>
      x.id === d.id ? { ...x, captureSourceId: id || null } : x,
    );
    const source = sources.find((s) => s.id === id);
    if (source && !config.sources.some((s) => s.id === id))
      config.sources.push(source);
    return saveConfig(config);
  };
  const reserveDevice = async () => {
    if (!reserve) return;
    const r = await action(
      reserve.takeover ? "sessions.takeover" : "sessions.reserve",
      reserve.takeover
        ? { deviceId: reserve.device.id, owner, reason, confirmed: true }
        : { selector: { device: reserve.device.id }, owner, reason },
    );
    setLeases((prev) => ({ ...prev, [reserve.device.id]: r }));
    setReserve(null);
    setReason("");
  };
  const openReserve = (device: Device, takeover = false) => {
    setReason("");
    setReserve({ device, takeover });
  };
  const menu: { name: Tab; icon: ReactNode }[] = [
    { name: "Devices", icon: <Monitor size={18} /> },
    { name: "Capture Cards", icon: <Usb size={18} /> },
    { name: "Captures", icon: <Camera size={18} /> },
    { name: "History", icon: <History size={18} /> },
    { name: "Reports", icon: <BarChart3 size={18} /> },
    { name: "Settings", icon: <Settings size={18} /> },
  ];
  return (
    <div className="live-app">
      <aside className="live-sidebar">
        <Brand />
        <span className="live-workspace">LOCAL WORKSPACE</span>
        <nav>
          {menu.map((item) => (
            <button
              key={item.name}
              className={tab === item.name ? "active" : ""}
              onClick={() => {
                setTab(item.name);
                setViewing([]);
              }}
            >
              {item.icon}
              {item.name}
              {item.name === "Devices" && <span>{data.devices.length}</span>}
            </button>
          ))}
        </nav>
        <div className="live-sidebar-footer">
          <span className="live-dot" /> Running on this Mac
          <p>One daemon. Every client.</p>
          <code>devdeck tui</code>
          <small>
            Visibility labels are for this Mac. Multi-host sharing is not
            enabled.
          </small>
        </div>
      </aside>
      <main className="live-main">
        <div className="live-topline">
          <span>Workspace / {viewing.length ? "Device viewer" : tab}</span>
          <span>
            <span className="live-dot" />{" "}
            {connectionError
              ? "Service unavailable"
              : "Local service connected"}
          </span>
        </div>
        {connectionError && (
          <div className="live-alert" role="alert">
            {connectionError}
          </div>
        )}
        {error && (
          <div className="live-alert" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {data.configError && (
          <div className="live-alert">{data.configError}</div>
        )}
        {notice && (
          <div className="live-notice" role="status">
            {notice}
            <button onClick={() => setNotice("")}>Dismiss</button>
          </div>
        )}
        {tab === "Devices" && !viewing.length && (
          <>
            <div className="live-heading">
              <div>
                <span className="eyebrow">DEVICE WORKSPACE</span>
                <h1>Devices</h1>
                <p>
                  See what's connected, who's using it and where the picture
                  comes from.
                </p>
              </div>
              <div className="live-actions">
                <button
                  onClick={() =>
                    perform(async () => {
                      setDiscovery(await action("discover"));
                      setShowDiscovery(true);
                    })
                  }
                  disabled={busy}
                >
                  <RefreshCw size={16} />
                  Discover
                </button>
                <button className="primary" onClick={() => setEditing(false)}>
                  <Plus size={16} />
                  Add device
                </button>
              </div>
            </div>
            <div className="live-stats">
              <span>
                <strong>{data.devices.length}</strong> devices
              </span>
              <span>
                <strong>{data.devices.filter((d) => d.online).length}</strong>{" "}
                online
              </span>
              <span>
                <strong>
                  {data.sessions.filter((s) => s.state !== "closed").length}
                </strong>{" "}
                reserved
              </span>
              <span>
                <strong>{data.recordings.length}</strong> recording
              </span>
            </div>
            <div className="live-panel">
              <div className="live-filters">
                <label className="live-search">
                  <Search size={17} />
                  <input
                    aria-label="Search devices"
                    placeholder="Search devices…"
                    value={filter.search}
                    onChange={(e) =>
                      setFilter({ ...filter, search: e.target.value })
                    }
                  />
                </label>
                {(
                  [
                    ["platform", "Platform", ["Roku", "Android", "Apple"]],
                    ["health", "Connection", ["online", "offline"]],
                    [
                      "reservation",
                      "Availability",
                      ["free", "reserved", "locked"],
                    ],
                    ["kind", "Device type", ["physical", "virtual"]],
                    ["visibility", "Visibility", ["local", "shared"]],
                  ] as const
                ).map(([field, label, options]) => (
                  <select
                    aria-label={label}
                    key={field}
                    value={filter[field]}
                    onChange={(e) =>
                      setFilter({ ...filter, [field]: e.target.value })
                    }
                  >
                    <option value="">All {label.toLowerCase()}</option>
                    {options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ))}
                <button
                  onClick={() =>
                    setFilter({
                      search: "",
                      platform: "",
                      health: "",
                      reservation: "",
                      kind: "",
                      visibility: "",
                    })
                  }
                >
                  Reset
                </button>
              </div>
              <div className="live-subtoolbar">
                <span>
                  {devices.length} of {data.devices.length} devices
                </span>
                <div className="live-actions">
                  <select
                    aria-label="Saved view"
                    onChange={(e) => {
                      const view = data.config.savedViews.find(
                        (v) => v.name === e.target.value,
                      );
                      if (view) setFilter({ ...filter, ...view.filters });
                    }}
                  >
                    <option value="">Saved views</option>
                    {data.config.savedViews.map((v) => (
                      <option key={v.name}>{v.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const name = window.prompt("Name this view");
                      if (name)
                        perform(() =>
                          saveConfig({
                            ...data.config,
                            savedViews: [
                              ...data.config.savedViews.filter(
                                (v) => v.name !== name,
                              ),
                              { name, filters: filter },
                            ],
                          }),
                        );
                    }}
                  >
                    Save view
                  </button>
                  {selected.length > 0 && (
                    <>
                      <span>{selected.length} selected</span>
                      <button onClick={() => openViewer(selected)}>
                        <Columns2 size={16} />
                        View selected
                      </button>
                      {(["lock", "unlock", "restart"] as const).map((a) => (
                        <button
                          key={a}
                          onClick={() => {
                            setReason("");
                            setMaintenance(a);
                          }}
                        >
                          {a}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
              <div className="live-table-scroll">
                <table className="live-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          aria-label="Select visible devices"
                          type="checkbox"
                          checked={
                            devices.length > 0 &&
                            devices.every((d) => selected.includes(d.id))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked ? devices.map((d) => d.id) : [],
                            )
                          }
                        />
                      </th>
                      <th>Device</th>
                      <th>Connection</th>
                      <th>Reservation / reason</th>
                      <th>Capture input</th>
                      <th>Visibility</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => {
                      const s = activeSession(d.id);
                      return (
                        <tr key={d.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${d.name}`}
                              checked={selected.includes(d.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, d.id]
                                    : selected.filter((x) => x !== d.id),
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              className="live-device-name"
                              onClick={() => openViewer([d.id])}
                              onMouseEnter={() => setHover(d.id)}
                              onMouseLeave={() => setHover("")}
                              onFocus={() => setHover(d.id)}
                              onBlur={() => setHover("")}
                            >
                              {d.name}
                            </button>
                            <small>
                              {d.platform} ·{" "}
                              {d.kind === "virtual"
                                ? "Emulator / simulator"
                                : "Physical"}
                              <br />
                              {d.model}
                            </small>
                            {hover === d.id && d.captureSourceId && (
                              <div className="live-hover">
                                <Preview device={d} />
                              </div>
                            )}
                          </td>
                          <td>
                            <span
                              className={`live-status ${d.online ? "green" : ""}`}
                            >
                              {d.online ? "Online" : "Offline"}
                            </span>
                            {d.locked && (
                              <span className="live-status amber">
                                Maintenance lock
                              </span>
                            )}
                            <small title={d.healthDetail}>
                              {d.lockReason || d.healthDetail}
                            </small>
                          </td>
                          <td>
                            {s ? (
                              <>
                                <strong>{s.owner}</strong>
                                <small>{s.reason}</small>
                                <small>
                                  {s.state} · until{" "}
                                  {new Date(s.expiresAt).toLocaleTimeString()}
                                </small>
                              </>
                            ) : (
                              <span className="live-muted">
                                {d.locked
                                  ? "Locked"
                                  : d.online
                                    ? "Available"
                                    : "Unavailable"}
                              </span>
                            )}
                          </td>
                          <td>
                            <select
                              aria-label={`Capture input for ${d.name}`}
                              value={d.captureSourceId || ""}
                              disabled={!!s || busy}
                              onChange={(e) =>
                                perform(() => changeSource(d, e.target.value))
                              }
                            >
                              <option value="">No capture input</option>
                              {sources
                                .filter(
                                  (s) =>
                                    s.kind === "usb" || s.deviceId === d.id,
                                )
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                            </select>
                            <small>
                              {data.sources.find(
                                (s) => s.id === d.captureSourceId,
                              )?.status || "Remote only"}
                            </small>
                          </td>
                          <td>
                            {d.visibility === "local"
                              ? "Local only"
                              : "Shared label"}
                          </td>
                          <td>
                            <div className="live-row-actions">
                              <button onClick={() => openViewer([d.id])}>
                                View
                              </button>
                              <button onClick={() => setEditing(d)}>
                                Edit
                              </button>
                              <button
                                aria-label={`Copy CLI command for ${d.name}`}
                                onClick={() =>
                                  perform(async () => {
                                    await navigator.clipboard.writeText(
                                      `devdeck remote --device '${d.name.replaceAll("'", "'\\''")}'`,
                                    );
                                    setNotice("CLI command copied.");
                                  })
                                }
                              >
                                <Terminal size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!devices.length && (
                  <div className="live-empty">
                    <Monitor size={36} />
                    <h2>
                      {data.devices.length
                        ? "No matching devices"
                        : "Connect your first device"}
                    </h2>
                    <p>
                      Discover a connected target, give it a friendly name and
                      choose its capture input.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {tab === "Devices" && viewing.length > 0 && (
          <>
            <div className="live-heading">
              <div>
                <button className="live-back" onClick={() => setViewing([])}>
                  <ArrowLeft size={16} />
                  All devices
                </button>
                <h1>
                  {viewing.length > 1 ? "Multi-device view" : chosen?.name}
                </h1>
                <p>
                  {viewing.length > 1
                    ? "Choose one remote target. Controls always address that device."
                    : "Live input, remote control and captures in one session."}
                </p>
              </div>
              <span className="live-status">
                {data.recordings.length} recording
              </span>
            </div>
            <div
              className={`live-viewer ${viewing.length > 1 ? "multiple" : ""}`}
            >
              <div className="live-video-grid">
                {data.devices
                  .filter((d) => viewing.includes(d.id))
                  .map((d) => (
                    <section
                      key={d.id}
                      className={`live-view-tile ${target === d.id ? "target" : ""}`}
                    >
                      <button
                        className="live-tile-heading"
                        onClick={() => setTarget(d.id)}
                      >
                        <strong>{d.name}</strong>
                        <span>
                          {target === d.id ? "Remote target" : "Select target"}
                        </span>
                      </button>
                      <Preview device={d} />
                      {overlay &&
                        data.inputs
                          .filter(
                            (i) =>
                              i.deviceId === d.id && Date.now() - i.at < 2000,
                          )
                          .slice(-1)
                          .map((i) => (
                            <span className="live-key-overlay" key={i.id}>
                              {i.key}
                            </span>
                          ))}
                      <footer>
                        {activeSession(d.id)?.owner || "No reservation"} ·{" "}
                        {data.sources.find((s) => s.id === d.captureSourceId)
                          ?.name || "No capture input"}
                      </footer>
                    </section>
                  ))}
              </div>
              {chosen && (
                <aside className="live-controls">
                  <h2>Remote control</h2>
                  <p>
                    Target: <strong>{chosen.name}</strong>
                  </p>
                  <div className="live-session">
                    <span className="live-label">RESERVATION</span>
                    {current ? (
                      <>
                        <strong>{current.owner}</strong>
                        <p>{current.reason}</p>
                        <small>
                          {current.state} · expires{" "}
                          {new Date(current.expiresAt).toLocaleTimeString()}
                        </small>
                        {lease ? (
                          <div className="live-actions">
                            <button
                              onClick={() =>
                                perform(() =>
                                  action(
                                    "sessions.renew",
                                    lease,
                                    "Reservation renewed.",
                                  ),
                                )
                              }
                            >
                              Renew
                            </button>
                            <button
                              onClick={() =>
                                perform(() =>
                                  action(
                                    "sessions.release",
                                    lease,
                                    "Reservation released.",
                                  ),
                                )
                              }
                            >
                              Release
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => openReserve(chosen, true)}>
                            Take over…
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <p>Reserve to control and capture.</p>
                        <button
                          className="primary"
                          disabled={!chosen.online || chosen.locked || busy}
                          onClick={() => openReserve(chosen)}
                        >
                          Reserve device
                        </button>
                      </>
                    )}
                  </div>
                  <div className="live-dpad">
                    {[
                      ["Up", <ChevronUp />],
                      ["Left", <ChevronLeft />],
                      ["OK", "OK"],
                      ["Right", <ChevronRight />],
                      ["Down", <ChevronDown />],
                    ].map(([key, icon]) => (
                      <button
                        key={String(key)}
                        className={`key-${String(key).toLowerCase()}`}
                        aria-label={String(key)}
                        disabled={
                          !lease || !chosen.capabilities.includes("key") || busy
                        }
                        onClick={() => perform(() => send(String(key)))}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                  <div className="live-actions live-remote-extra">
                    {[
                      ["Back", <CornerUpLeft size={16} />],
                      ["Home", <Home size={16} />],
                      ["Play", <Play size={16} />],
                    ].map(([key, icon]) => (
                      <button
                        key={String(key)}
                        disabled={
                          !lease || !chosen.capabilities.includes("key") || busy
                        }
                        onClick={() => perform(() => send(String(key)))}
                      >
                        {icon}
                        {key}
                      </button>
                    ))}
                  </div>
                  {!chosen.capabilities.includes("key") && (
                    <small>
                      Input unavailable. Check adapter dependencies in Settings.
                    </small>
                  )}
                  <form
                    className="live-text"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (lease)
                        perform(async () => {
                          await action("remote.input", { ...lease, text });
                          setText("");
                        });
                    }}
                  >
                    <input
                      aria-label="Remote text"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Send text to device"
                    />
                    <button
                      disabled={
                        !lease ||
                        !chosen.capabilities.includes("text") ||
                        !text ||
                        busy
                      }
                    >
                      Send
                    </button>
                  </form>
                  <div className="live-capture-controls">
                    <h2>Capture</h2>
                    <label>
                      Capture file
                      <select
                        value={captureMode}
                        onChange={(e) =>
                          setCaptureMode(e.target.value as typeof captureMode)
                        }
                      >
                        <option value="clean">Clean source</option>
                        <option value="annotated">
                          With keypress overlays
                        </option>
                      </select>
                    </label>
                    <label className="live-check">
                      <input
                        type="checkbox"
                        checked={overlay}
                        onChange={(e) => setOverlay(e.target.checked)}
                      />
                      Show live keypress overlay
                    </label>
                    <button
                      disabled={
                        !lease ||
                        !chosen.capabilities.includes("screenshot") ||
                        busy
                      }
                      onClick={() =>
                        perform(() =>
                          action(
                            "captures.screenshot",
                            { ...lease, mode: captureMode },
                            "Screenshot saved to the capture library.",
                          ),
                        )
                      }
                    >
                      <Camera size={16} />
                      Screenshot
                    </button>
                    <button
                      disabled={
                        !lease ||
                        !chosen.capabilities.includes("screenshot") ||
                        busy
                      }
                      onClick={() =>
                        perform(async () => {
                          const a = await action("captures.screenshot", {
                            ...lease,
                            mode: captureMode,
                            clipboard: true,
                          });
                          setNotice(
                            a.clipboardError
                              ? `Saved. Clipboard: ${a.clipboardError}`
                              : "Screenshot saved and copied to the Mac clipboard.",
                          );
                        })
                      }
                    >
                      <Copy size={16} />
                      Screenshot to clipboard
                    </button>
                    <button
                      className={recording ? "danger" : "primary"}
                      disabled={
                        !lease ||
                        !chosen.capabilities.includes("record") ||
                        busy
                      }
                      onClick={() =>
                        perform(async () => {
                          const a = await action(
                            recording ? "recordings.stop" : "recordings.start",
                            {
                              ...lease,
                              ...(!recording ? { mode: captureMode } : {}),
                            },
                          );
                          setNotice(
                            recording
                              ? `Recording ${a.status}. ${a.error || a.path}`
                              : `Recording started. Maximum ${Math.round(a.maxDurationSeconds)} seconds.`,
                          );
                        })
                      }
                    >
                      {recording ? (
                        <Square size={16} />
                      ) : (
                        <span className="record-dot" />
                      )}
                      {recording ? "Stop recording" : "Start recording"}
                    </button>
                    <small>
                      {recording
                        ? `Recording for ${duration(Date.now() - recording.startedAt)}. You can close this window.`
                        : `Saves to ${data.config.settings.folder}`}
                    </small>
                  </div>
                  <div className="live-timeline">
                    <h2>Input log</h2>
                    {!data.config.settings.logging ? (
                      <p>Input logging is off. Text and keys are not stored.</p>
                    ) : (
                      data.inputs
                        .filter((i) => i.deviceId === target)
                        .slice(-8)
                        .reverse()
                        .map((i) => (
                          <div key={i.id}>
                            <code>
                              {i.elapsedMs === null
                                ? new Date(i.at).toLocaleTimeString()
                                : `+${(i.elapsedMs / 1000).toFixed(2)}s`}
                            </code>
                            <span>{i.key}</span>
                          </div>
                        ))
                    )}
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
        {tab === "Captures" && (
          <>
            <div className="live-heading">
              <div>
                <h1>Captures</h1>
                <p>
                  Real files from every client. One configured folder on this
                  Mac.
                </p>
              </div>
              <button
                onClick={() => {
                  setTrash(!trash);
                  setCaptureSelection([]);
                }}
              >
                {trash ? "Back to library" : "Trash"}
              </button>
            </div>
            <div className="live-panel">
              <div className="live-filters">
                <input
                  aria-label="Search captures"
                  placeholder="Filter names, devices or tags…"
                  value={captureSearch}
                  onChange={(e) => setCaptureSearch(e.target.value)}
                />
                <span>{data.config.settings.folder}</span>
                {captureSelection.length > 0 && (
                  <>
                    <button
                      onClick={() =>
                        perform(() =>
                          action(
                            trash ? "captures.restore" : "captures.remove",
                            {
                              ids: captureSelection,
                              ...(!trash ? { confirmed: true } : {}),
                            },
                            trash
                              ? "Restored captures."
                              : "Moved to Device Deck trash. Files remain until permanently deleted.",
                          ),
                        )
                      }
                    >
                      {trash ? "Restore" : "Move to trash"}
                    </button>
                    {trash && (
                      <button
                        className="danger"
                        onClick={() => setPurging(true)}
                      >
                        Delete files permanently…
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="live-captures">
                {data.artifacts
                  .filter(
                    (a) =>
                      !a.purgedAt &&
                      !!a.deletedAt === trash &&
                      `${a.name} ${a.tags.join(" ")} ${data.devices.find((d) => d.id === a.deviceId)?.name}`
                        .toLowerCase()
                        .includes(captureSearch.toLowerCase()),
                  )
                  .map((a) => (
                    <article key={a.id}>
                      <div className="live-capture-image">
                        <input
                          type="checkbox"
                          aria-label={`Select ${a.name}`}
                          checked={captureSelection.includes(a.id)}
                          onChange={(e) =>
                            setCaptureSelection(
                              e.target.checked
                                ? [...captureSelection, a.id]
                                : captureSelection.filter((id) => id !== a.id),
                            )
                          }
                        />
                        <button onClick={() => setArtifact(a)}>
                          {a.kind === "screenshot" &&
                          !trash &&
                          a.status === "completed" ? (
                            <img src={fileUrl(a)} alt={a.name} />
                          ) : a.kind === "recording" ? (
                            <Play size={34} />
                          ) : (
                            <Camera size={34} />
                          )}
                        </button>
                        <span>
                          {a.kind} · {a.mode}
                        </span>
                      </div>
                      <div className="live-capture-info">
                        <button onClick={() => setArtifact(a)}>
                          <strong>{a.name}</strong>
                        </button>
                        <small>
                          {data.devices.find((d) => d.id === a.deviceId)
                            ?.name || a.deviceId}{" "}
                          · {time(a.createdAt)}
                        </small>
                        <span
                          className={`live-status ${a.status === "completed" ? "green" : "amber"}`}
                        >
                          {a.status}{" "}
                          {a.duration ? `· ${a.duration.toFixed(1)}s` : ""}
                        </span>
                        {a.error && <small>{a.error}</small>}
                        <p>{a.tags.map((t) => `#${t}`).join(" ")}</p>
                      </div>
                    </article>
                  ))}
              </div>
              {!data.artifacts.some(
                (a) => !!a.deletedAt === trash && !a.purgedAt,
              ) && (
                <div className="live-empty">
                  <Camera size={36} />
                  <h2>{trash ? "Trash is empty" : "No captures yet"}</h2>
                  <p>
                    Reserve a device and take a screenshot or start a recording.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
        {tab === "History" && (
          <>
            <div className="live-heading">
              <div>
                <h1>Usage history</h1>
                <p>
                  Reservations, maintenance and capture events recorded by this
                  daemon.
                </p>
              </div>
            </div>
            <div className="live-panel live-table-scroll">
              <table className="live-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Device</th>
                    <th>Owner</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id}>
                      <td>{time(e.at)}</td>
                      <td>
                        {data.devices.find((d) => d.id === e.deviceId)?.name ||
                          "Workspace"}
                      </td>
                      <td>{e.owner}</td>
                      <td>{e.action}</td>
                      <td>
                        {e.detail}
                        {e.durationMs ? (
                          <small>{duration(e.durationMs)}</small>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "Reports" && (
          <Reports
            load={(request) => api("reports.get", request)}
            devices={data.devices}
            storageKey="deck-local-report-range"
          />
        )}
        {tab === "Capture Cards" && (
          <CaptureCards
            cards={cards.sources.map((s) => ({
              ...s,
              uniqueId: s.uniqueId!,
              deviceId: data.devices.find((d) => d.captureSourceId === s.id)
                ?.id,
            }))}
            devices={data.devices.map((d) => ({
              ...d,
              owner: activeSession(d.id)?.owner,
              reason: activeSession(d.id)?.reason,
              recording: data.recordings.some((r) => r.deviceId === d.id),
            }))}
            busy={busy}
            loading={cardsLoading}
            diagnostics={cards.diagnostics}
            refresh={() => void refreshCards()}
            view={(id) => {
              setTab("Devices");
              openViewer([id]);
            }}
            assign={async (card, id) => {
              const source = cards.sources.find((s) => s.id === card.id)!;
              await saveConfig(
                assignCaptureCard(
                  data.config,
                  {
                    id: source.id,
                    name: source.name,
                    kind: "usb",
                    uniqueId: source.uniqueId,
                  },
                  id,
                ),
              );
              await refreshCards();
            }}
          />
        )}
        {tab === "Settings" && (
          <SettingsView data={data} save={saveConfig} busy={busy} />
        )}
      </main>
      {reserve && (
        <Modal
          title={reserve.takeover ? "Take over device" : "Reserve device"}
          onClose={() => setReserve(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(reserveDevice);
            }}
          >
            <p>
              {reserve.takeover
                ? "The current session will close and its recording will finalize before you take control."
                : "Reserve " +
                  reserve.device.name +
                  " for remote input and capture."}
            </p>
            <label>
              Owner label
              <input
                required
                maxLength={128}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </label>
            <label>
              Reason
              <textarea
                required
                maxLength={512}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What are you working on?"
              />
            </label>
            <footer>
              <button type="button" onClick={() => setReserve(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {reserve.takeover ? "Take over and reserve" : "Reserve device"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {maintenance && (
        <Modal
          title={`${maintenance} selected devices`}
          onClose={() => setMaintenance(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                const results = await action("devices.bulk", {
                  ids: selected,
                  action: maintenance,
                  reason,
                });
                setNotice(
                  results
                    .map(
                      (r: any) =>
                        `${data.devices.find((d) => d.id === r.id)?.name}: ${r.ok ? "done" : r.error}`,
                    )
                    .join(" · "),
                );
                setMaintenance(null);
              });
            }}
          >
            <p>
              Reserved devices are skipped. Maintenance locks are separate from
              reservations.
            </p>
            <label>
              Reason
              <input
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <footer>
              <button className="primary" disabled={busy}>
                Apply {maintenance}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {showDiscovery && discovery && (
        <Modal
          title="Discovered on this Mac"
          onClose={() => setShowDiscovery(false)}
        >
          <p>Discovery preserves your configured names and capture bindings.</p>
          <div className="live-discovery">
            {discovery.devices.map((d) => (
              <div key={d.id}>
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {d.platform} · {d.kind} · {d.model}
                  </small>
                </span>
                <button
                  disabled={data.devices.some((x) => x.id === d.id)}
                  onClick={() => {
                    setEditing(d);
                    setShowDiscovery(false);
                  }}
                >
                  {data.devices.some((x) => x.id === d.id)
                    ? "Configured"
                    : "Register"}
                </button>
              </div>
            ))}
          </div>
          <h3>Capture inputs</h3>
          {discovery.sources
            .filter((s) => s.kind === "usb")
            .map((s) => (
              <p key={s.id}>
                {s.name} <small>{s.uniqueId}</small>
              </p>
            ))}
          {discovery.diagnostics.length > 0 && (
            <details>
              <summary>Discovery diagnostics</summary>
              {discovery.diagnostics.map((d, i) => (
                <p key={i}>{d}</p>
              ))}
            </details>
          )}
        </Modal>
      )}
      {editing !== null && (
        <DeviceEditor
          device={editing || undefined}
          sources={sources}
          close={() => setEditing(null)}
          save={async (d, source) => {
            const config = structuredClone(data.config);
            config.devices = config.devices.some((x) => x.id === d.id)
              ? config.devices.map((x) => (x.id === d.id ? d : x))
              : [...config.devices, d];
            if (source && !config.sources.some((s) => s.id === source.id))
              config.sources.push(source);
            await saveConfig(config, deviceEditRevision);
            setEditing(null);
          }}
        />
      )}
      {artifact && (
        <ArtifactEditor
          artifact={
            data.artifacts.find((a) => a.id === artifact.id) || artifact
          }
          close={() => setArtifact(null)}
          save={(name, tags) =>
            action("captures.edit", { id: artifact.id, name, tags })
          }
        />
      )}
      {purging && (
        <Modal
          title="Permanently delete capture files?"
          onClose={() => setPurging(false)}
        >
          <p>
            This deletes {captureSelection.length} selected captures, clean
            originals and log files from disk. This cannot be undone.
          </p>
          <footer>
            <button onClick={() => setPurging(false)}>Cancel</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await action(
                    "captures.purge",
                    { ids: captureSelection, confirmed: true },
                    "Capture files permanently deleted.",
                  );
                  setCaptureSelection([]);
                  setPurging(false);
                })
              }
            >
              Delete files permanently
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function DeviceEditor({
  device,
  sources,
  close,
  save,
}: {
  device?: DeviceConfig;
  sources: SourceConfig[];
  close: () => void;
  save: (d: DeviceConfig, s?: SourceConfig) => Promise<unknown>;
}) {
  const [name, setName] = useState(device?.name || ""),
    [type, setType] = useState(device?.connection.type || "roku"),
    [address, setAddress] = useState(
      device?.connection.type === "roku" ||
        device?.connection.type === "apple-tv"
        ? device.connection.host
        : device?.connection.type === "adb"
          ? device.connection.serial
          : device?.connection.type === "simulator" ||
              device?.connection.type === "apple-device"
            ? device.connection.udid
            : "",
    ),
    [identity, setIdentity] = useState(
      device?.connection.type === "roku"
        ? device.connection.serial
        : device?.connection.type === "apple-tv"
          ? device.connection.identifier
          : device?.connection.type === "adb"
            ? device.connection.hardwareId || ""
            : "",
    ),
    [port, setPort] = useState(
      device?.connection.type === "adb" ? device.connection.port : 5037,
    ),
    [os, setOS] = useState(
      device?.connection.type === "simulator" ? device.connection.os : "ios",
    ),
    [source, setSource] = useState(device?.captureSourceId || ""),
    [visibility, setVisibility] = useState(device?.visibility || "local"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <Modal title={device ? "Configure device" : "Add device"} onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            const id = device?.id || crypto.randomUUID();
            const connection: DeviceConfig["connection"] =
              type === "roku"
                ? { type, host: address, serial: identity }
                : type === "adb"
                  ? {
                      type,
                      serial: address,
                      port,
                      ...(identity ? { hardwareId: identity } : {}),
                    }
                  : type === "simulator"
                    ? { type, udid: address, os }
                    : type === "apple-tv"
                      ? { type, host: address, identifier: identity }
                      : { type: "apple-device", udid: address };
            const native: SourceConfig = {
              id: `native-${id}`,
              name: `${name} native screen`,
              kind: "native",
              deviceId: id,
            };
            const selectedSource =
              source === "native"
                ? native
                : sources.find((s) => s.id === source);
            await save(
              {
                id,
                name,
                platform:
                  type === "roku"
                    ? "Roku"
                    : type === "adb"
                      ? "Android"
                      : "Apple",
                kind:
                  type === "simulator" ||
                  (type === "adb" && address.startsWith("emulator-"))
                    ? "virtual"
                    : "physical",
                model: device?.model || "",
                visibility,
                connection,
                captureSourceId: selectedSource?.id || null,
              },
              selectedSource,
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        {error && <p className="live-alert">{error}</p>}
        <label>
          Friendly name
          <input
            required
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Connection
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as typeof type);
              setSource("");
            }}
          >
            <option value="roku">Roku · network ECP</option>
            <option value="adb">Android / Android TV · ADB</option>
            <option value="simulator">Apple simulator · simctl + idb</option>
            <option value="apple-tv">Apple TV · Companion</option>
            <option value="apple-device">
              Physical Apple · discovery only
            </option>
          </select>
        </label>
        <label>
          {type === "roku" || type === "apple-tv"
            ? "Host address"
            : type === "adb"
              ? "ADB serial"
              : "Device UDID"}
          <input
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        {(type === "roku" || type === "apple-tv" || type === "adb") && (
          <label>
            Stable{" "}
            {type === "apple-tv" ? "Companion identifier" : "hardware serial"}
            <input
              required={type !== "adb" || address.includes(":")}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
            />
          </label>
        )}
        {type === "adb" && (
          <label>
            ADB server port
            <input
              type="number"
              min={1}
              max={65535}
              required
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
        )}
        {type === "simulator" && (
          <label>
            Simulator OS
            <select
              value={os}
              onChange={(e) => setOS(e.target.value as typeof os)}
            >
              <option value="ios">iOS</option>
              <option value="tvos">tvOS</option>
            </select>
          </label>
        )}
        <label>
          Capture input
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">None · remote only</option>
            {["adb", "simulator"].includes(type) && (
              <option value="native">Native screen</option>
            )}
            {sources
              .filter((s) => s.kind === "usb" || s.deviceId === device?.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Visibility label
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
          >
            <option value="local">Local only</option>
            <option value="shared">Shared</option>
          </select>
        </label>
        <small>
          All access is currently on this Mac. A shared label does not enable
          network access.
        </small>
        <footer>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            Save device
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function ArtifactEditor({
  artifact: a,
  close,
  save,
}: {
  artifact: Artifact;
  close: () => void;
  save: (name: string, tags: string[]) => Promise<unknown>;
}) {
  const [name, setName] = useState(a.name),
    [tags, setTags] = useState(a.tags.join(", ")),
    [error, setError] = useState("");
  return (
    <Modal title="Capture details" onClose={close}>
      {!a.deletedAt &&
        !["recording", "finalizing"].includes(a.status) &&
        (a.kind === "recording" ? (
          <video className="live-artifact-preview" src={fileUrl(a)} controls />
        ) : (
          <img
            className="live-artifact-preview"
            src={fileUrl(a)}
            alt={a.name}
          />
        ))}
      <p>
        {a.status} · {a.kind} · {time(a.createdAt)}
      </p>
      {a.error && <p className="live-alert">{a.error}</p>}
      <small>{a.path}</small>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save(
              name,
              tags
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            );
            close();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Tags, separated by commas
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        {error && <p>{error}</p>}
        <footer>
          {!a.deletedAt && (
            <>
              <a href={fileUrl(a)} download>
                <Download size={16} />
                File
              </a>
              {a.cleanPath && (
                <a href={fileUrl(a, "clean")} download>
                  Clean original
                </a>
              )}
              <a href={fileUrl(a, "log")} download>
                Key log / metadata
              </a>
            </>
          )}
          <button
            className="primary"
            disabled={["recording", "finalizing"].includes(a.status)}
          >
            Save details
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function SettingsView({
  data,
  save,
  busy,
}: {
  data: Snapshot;
  save: (c: Config, revision?: string) => Promise<{ revision: string }>;
  busy: boolean;
}) {
  const [config, setConfig] = useState(() => structuredClone(data.config)),
    [editRevision, setEditRevision] = useState(data.configRevision),
    [raw, setRaw] = useState(JSON.stringify(data.config, null, 2)),
    [error, setError] = useState(""),
    [json, setJson] = useState(false);
  const update = (name: string, value: unknown) =>
    setConfig((c) => ({ ...c, settings: { ...c.settings, [name]: value } }));
  return (
    <>
      <div className="live-heading">
        <div>
          <h1>Local settings</h1>
          <p>Shared by the web app, CLI, terminal UI and agents.</p>
        </div>
        <button
          onClick={() => {
            setJson(!json);
            setRaw(JSON.stringify(config, null, 2));
          }}
        >
          {json ? "Form editor" : "JSON editor"}
        </button>
      </div>
      <form
        className="live-panel live-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const result = await save(
              json ? JSON.parse(raw) : config,
              editRevision,
            );
            setEditRevision(result.revision);
            setError("");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {error && <p className="live-alert">{error}</p>}
        {json ? (
          <>
            <label>
              Configuration JSON
              <textarea
                className="live-json"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
            </label>
            <label>
              Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(setRaw);
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const blob = new Blob([raw], { type: "application/json" }),
                  url = URL.createObjectURL(blob),
                  a = document.createElement("a");
                a.href = url;
                a.download = "device-deck.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Export JSON
            </button>
          </>
        ) : (
          <>
            <h2>Capture defaults</h2>
            <label>
              Mac output folder
              <input
                required
                value={config.settings.folder}
                onChange={(e) => update("folder", e.target.value)}
              />
              <small>
                Relative paths resolve beside the configuration file. Existing
                captures keep their original location.
              </small>
            </label>
            <label>
              File naming pattern
              <input
                required
                value={config.settings.naming}
                onChange={(e) => update("naming", e.target.value)}
              />
              <small>
                Use {"{device}"}, {"{date}"} and {"{time}"}. A unique capture ID
                is appended.
              </small>
            </label>
            <label>
              Default capture mode
              <select
                value={config.settings.captureMode}
                onChange={(e) => update("captureMode", e.target.value)}
              >
                <option value="clean">Clean source</option>
                <option value="annotated">With keypress overlays</option>
              </select>
            </label>
            {(
              [
                ["clipboard", "Copy screenshots to Mac clipboard"],
                ["overlay", "Show key overlays in the viewer"],
                [
                  "logging",
                  "Store input keys and text with aligned timestamps",
                ],
              ] as const
            ).map(([key, label]) => (
              <label className="live-check" key={key}>
                <input
                  type="checkbox"
                  checked={config.settings[key]}
                  onChange={(e) => update(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
            <small>
              When logging is off, new input text and keys are not stored.
              Existing logs remain. Annotated recordings require stored input
              events.
            </small>
            <label>
              Maximum recording minutes
              <input
                type="number"
                min={1}
                max={120}
                value={config.settings.maxRecordingMinutes}
                onChange={(e) =>
                  update("maxRecordingMinutes", Number(e.target.value))
                }
              />
              <small>Native Android recordings stop after 175 seconds.</small>
            </label>
            <h2>Reservation defaults</h2>
            <label>
              Owner label
              <input
                required
                value={config.settings.owner}
                onChange={(e) => update("owner", e.target.value)}
              />
            </label>
            <label>
              Reservation minutes
              <input
                type="number"
                min={1}
                max={240}
                value={config.settings.ttl}
                onChange={(e) => update("ttl", Number(e.target.value))}
              />
            </label>
            <h2>Adapter executables</h2>
            {(["adb", "ffmpeg", "ffprobe", "idb", "python"] as const).map(
              (tool) => (
                <label key={tool}>
                  {tool}
                  <input
                    placeholder="Use PATH"
                    value={config.tools[tool] || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        tools: {
                          ...config.tools,
                          [tool]: e.target.value || undefined,
                        },
                      })
                    }
                  />
                </label>
              ),
            )}
          </>
        )}
        <div className="live-actions">
          <button className="primary" disabled={busy}>
            Save settings
          </button>
          <button
            type="button"
            onClick={() => {
              setEditRevision(data.configRevision);
              setConfig(structuredClone(data.config));
              setRaw(JSON.stringify(data.config, null, 2));
              setError("");
            }}
          >
            Reload current configuration
          </button>
        </div>
      </form>
      <div className="live-panel live-settings">
        <h2>Host diagnostics</h2>
        {data.diagnostics.map((d, i) => (
          <p key={i}>{d}</p>
        ))}
        {!data.diagnostics.length && (
          <p>Configured dependencies are available.</p>
        )}
        <pre>
          devdeck status
          <br />
          devdeck logs
          <br />
          devdeck install
        </pre>
        <p>
          No account is required. Access uses local credentials owned by your
          Mac user.
        </p>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
