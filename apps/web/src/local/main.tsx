import { FloatingRemote } from "./FloatingRemote";
import { AccountConnection } from "./AccountConnection";
import { ConnectionScreen } from "./ConnectionScreen";
import { useInventoryPolling } from "./useInventoryPolling";
import { browserUUID } from "../../../../packages/ui/src/uuid";
import { AnchoredPopover } from "./AnchoredPopover";
import type { PopupAnchor } from "./anchored-popup";
import { DeviceControls } from "./DeviceControls";
import { CaptureLibrary } from "./CaptureLibrary";
import { CaptureToasts, useCaptureFeedback } from "./capture-feedback";
import { SimulatorControls } from "./SimulatorControls";
import { FeedActions, type FeedAction } from "./FeedActions";
import { DiscoveryDevices } from "./DiscoveryDevices";
import { deviceEditorMetadata } from "../../../../packages/core/src/device-editor";
import { registerDiscoveredDevices } from "../../../../packages/core/src/discovery";
import { supportsWake, deviceInputMode } from "../../../../packages/core/src/remote";
import { deviceFormFactor } from "../../../../packages/core/src/device-form-factor";
import { DeviceTypeFilter } from "./DeviceTypeFilter";
import {
  deviceConnectionLabel,
  deviceAvailabilityLabel,
  deviceIsBooting,
  sortTableDevices,
  type DeviceSort,
  type DeviceSortColumn,
} from "../../../../packages/core/src/device-table";
import { CapturePreview } from "./CapturePreview";
import { FeedViewer } from "./FeedViewer";
import { FeedPreview } from "./FeedPreview";
import { Reports } from "../components/Reports";
import { License, LicenseReminder } from "../components/License";
import { CaptureCards, type CardView } from "../components/CaptureCards";
import {
  assignCaptureCard,
  assignCustomCaptureCard,
  assignCaptureCards,
  deleteCaptureCards,
} from "../../../../packages/core/src/capture-cards";
import React, {
  useState,
  useEffect,
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
  Terminal,
  Columns2,
  Lock,
  Unlock,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
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
import "./remote-control.css";
import "./floating-remote.css";
type Lease = { session: Session; leaseToken: string };
type Tab =
  | "Feeds"
  | "Capture Cards"
  | "Devices"
  | "Captures"
  | "History"
  | "Reports"
  | "Settings"
  | "License";
const time = (value: number) => new Date(value).toLocaleString();
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const fileUrl = (a: Artifact, kind = "file") => `/v1/artifacts/${encodeURIComponent(a.id)}/${kind}`;
const getCaptureBlob = async (a: Artifact, kind: "file" | "clean" | "log", signal?: AbortSignal) => {
  const response = await fetch(fileUrl(a, kind), { signal });
  if (!response.ok) throw new Error("Could not load the capture file.");
  return response.blob();
};
const captureThumbnailUrl = (a: Artifact) => `/v1/artifacts/${encodeURIComponent(a.id)}/thumbnail`;
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
  return (
    <CapturePreview
      key={device.id}
      name={device.name}
      endpoint={`/v1/preview/${encodeURIComponent(device.id)}`}
      active={active}
    />
  );
}
function DeviceFilterGroup({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  options: readonly (readonly [string, string, number?])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="device-filter-group" role="group" aria-label={ariaLabel}>
      <span className="device-filter-label">{label}</span>
      <div className="device-filter-buttons">
        {options.map(([option, text, count]) => (
          <button
            key={option}
            type="button"
            className={`filter-${option.toLowerCase() || "all"}`}
            aria-pressed={value === option}
            onClick={() => onChange(value === option ? "" : option)}
          >
            {text}
            {count !== undefined && <span>{count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
function App() {
  const [feedRequest, setFeedRequest] = useState<{ deviceIds: string[] } | null>(null);
  const [control, setControl] = useState<{
    deviceId: string;
    action: FeedAction;
    anchor: PopupAnchor;
  } | null>(null);
  const [identify, setIdentify] = useState<{
    name: string;
    sourceId?: string;
    deviceId?: string;
    anchor: PopupAnchor;
  } | null>(null);
  const [cards, setCards] = useState<{
    sources: (SourceConfig & {
      status: "connected" | "missing" | "unknown";
      detail?: string;
    })[];
    diagnostics: string[];
  }>({ sources: [], diagnostics: [] });
  const [cardsLoading, setCardsLoading] = useState(false);
  const currentSnapshot = useRef<Snapshot | null>(null);
  const [data, setData] = useState<Snapshot | null>(null),
    [connectionError, setConnectionError] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<Tab>(() =>
      new URLSearchParams(location.search).get("view") === "feeds"
        ? "Feeds"
        : "Devices",
    );
  const refreshCards = useInventoryPolling(async (signal, manual) => {
    setCardsLoading(true);
    try {
      const result = await api<typeof cards>("capture-cards.list", manual ? { refresh: true } : {}, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      if (!signal.aborted) setCards(result);
    } catch (e) {
      if (!signal.aborted) setCards((prev) => ({ ...prev, diagnostics: [(e as Error).message] }));
    } finally {
      if (!signal.aborted) setCardsLoading(false);
    }
  }, { enabled: tab === "Capture Cards" && Boolean(data), intervalMs: 10_000, identity: data?.configRevision });
  const [filter, setFilter] = useState({
      search: "",
      platform: "",
      health: "",
      reservation: "",
      kind: "",
      formFactor: "",
      visibility: "",
    }),
    [selected, setSelected] = useState<string[]>([]),
    [viewing, setViewing] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [hover, setHover] = useState("");
  const [deviceSort, setDeviceSort] = useState<DeviceSort>({
    column: "device",
    direction: "ascending",
  });
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
    [owner, setOwner] = useState("You");
  const [overlay, setOverlay] = useState(true);
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const captureFeedback = useCaptureFeedback(data?.artifacts);
  const bootstrapped = useRef(false);
  const bootstrapFailed = useRef(false);
  const refresh = useInventoryPolling(async (signal) => {
    if (bootstrapFailed.current) return;
    try {
      if (!bootstrapped.current) {
        await bootstrap(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
        if (signal.aborted) return;
        bootstrapped.current = true;
      }
      const d = await api("inventory", {}, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      if (signal.aborted) return;
      currentSnapshot.current = d;
      setData(d);
      setConnectionError("");
    } catch (e) {
      if (signal.aborted) return;
      if (!bootstrapped.current) bootstrapFailed.current = true;
      setConnectionError((e as Error).name === "TimeoutError" ? "The connection timed out. Check that Device Deck is running and this machine is reachable." : (e as Error).message);
    }
  }, { intervalMs: 2500 });
  useEffect(
    () => localStorage.setItem("deck-local-leases", JSON.stringify(leases)),
    [leases],
  );
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== "deck-local-leases" || !event.newValue) return;
      try {
        setLeases(JSON.parse(event.newValue));
      } catch {}
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const initialized = useRef(false);
  useEffect(() => {
    if (data && !initialized.current) {
      setOwner(data.config.settings.owner);
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
  const openDeviceFeeds = (ids: string[]) => {
    setControl(null); setIdentify(null); setViewing([]); setHover(""); setTab("Feeds");
    setFeedRequest({ deviceIds: ids });
  };
  const openViewer = (ids: string[]) => {
    if (data?.devices.some((device) => ids.includes(device.id) && deviceInputMode(device) === "touch")) {
      openDeviceFeeds(ids); return;
    }
    setViewing(ids);
    setTarget(ids[0] || "");
    setHover("");
  };
  if (!data)
    return <ConnectionScreen error={connectionError || error} />;
  const filteredDevices = data.devices.filter(
    (d) =>
      (!filter.search ||
        d.name.toLowerCase().includes(filter.search.trim().toLowerCase())) &&
      (!filter.platform || d.platform === filter.platform) &&
      (!filter.health || (filter.health === "online" ? d.online : !d.online)) &&
      (!filter.kind || d.kind === filter.kind) &&
      (!filter.formFactor || deviceFormFactor(d) === filter.formFactor) &&
      (!filter.visibility || d.visibility === filter.visibility) &&
      (!filter.reservation ||
        (filter.reservation === "locked"
          ? d.locked
          : filter.reservation === "reserved"
            ? !!activeSession(d.id)
            : !activeSession(d.id) && !d.locked && d.online)),
  );
  const chosen = data.devices.find((d) => d.id === target);
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
  const devices = sortTableDevices(
    filteredDevices,
    deviceSort,
    sources,
    data.sessions,
  );
  const sortHeader = (column: DeviceSortColumn, label: string) => {
    const active = deviceSort.column === column;
    const direction = active ? deviceSort.direction : "none";
    const next = direction === "ascending" ? "descending" : "ascending";
    const Icon =
      direction === "ascending"
        ? ArrowUp
        : direction === "descending"
          ? ArrowDown
          : ArrowUpDown;
    return (
      <th scope="col" aria-sort={direction}>
        <button
          type="button"
          className="device-sort-button"
          aria-label={`Sort by ${label}`}
          title={`Sort ${label.toLowerCase()} ${next}`}
          onClick={() => setDeviceSort({ column, direction: next })}
        >
          {label}
          <Icon size={13} aria-hidden="true" />
        </button>
      </th>
    );
  };
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
  const openControls = (d: Device, action: FeedAction, anchor: PopupAnchor) => {
    if (action === "remote" && deviceInputMode(d) !== "remote") {
      openDeviceFeeds([d.id]); return;
    }
    if (action === "wake" && !activeSession(d.id)) {
      perform(async () => {
        setBusy(true);
        setError("");
        try {
          await api("devices.wake", { deviceId: d.id });
          setNotice(`Wake request sent to ${d.name}.`);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          await refresh();
          setBusy(false);
        }
      });
      return;
    }
    if (action === "identify") setControl(null);
    else setIdentify(null);
    if (action === "identify")
      setIdentify({
        name: d.name,
        deviceId: d.id,
        sourceId: d.captureSourceId || undefined,
        anchor,
      });
    else setControl({ deviceId: d.id, action, anchor });
  };
  const feedAction = (
    source: SourceConfig,
    intent: FeedAction,
    anchor: PopupAnchor,
  ) => {
    const device = data.devices.find((d) => d.captureSourceId === source.id || d.id === source.deviceId);
    if (intent === "identify") {
      setControl(null);
      setIdentify({
        name: source.name,
        sourceId: source.id,
        deviceId: device?.id,
        anchor,
      });
      return;
    }
    if (device) {
      openControls(device, intent, anchor);
      return;
    }
    perform(async () => {
      setIdentify(null);
      const config = structuredClone(data.config);
      let name = source.name.slice(0, 64),
        suffix = 2;
      while (
        config.devices.some((d) => d.name.toLowerCase() === name.toLowerCase())
      )
        name = `${source.name.slice(0, 54)} (${suffix++})`;
      const id = browserUUID();
      config.devices.push({
        id,
        name,
        platform: "Other",
        kind: "physical",
        model: "USB capture",
        visibility: "local",
        connection: { type: "capture" },
        captureSourceId: source.id,
      });
      await saveConfig(config);
      setControl({ deviceId: id, action: intent, anchor });
    });
  };
  const deviceActions = (d: Device) => (
    <FeedActions
      name={d.name}
      reserved={Boolean(activeSession(d.id))}
      recording={data.recordings.some((r) => r.deviceId === d.id)}
      wakeAvailable={supportsWake(d) && !d.locked && !busy}
      remoteAvailable={deviceInputMode(d) === "remote"}
      onAction={(intent, anchor) => openControls(d, intent, anchor)}
    />
  );
  const controls = (
    d: Device,
    intent: FeedAction,
    optionsOpen: boolean,
    setOptionsOpen: (open: boolean) => void,
  ) => (
    <DeviceControls
      onCapture={captureFeedback.completed}
      remoteAvailable={deviceInputMode(d) === "remote"}
      key={d.id}
      device={d}
      data={data}
      lease={credentials(d.id)}
      onLease={(value) => setLeases((prev) => ({ ...prev, [d.id]: value }))}
      refresh={refresh}
      edit={() => {
        setControl(null);
        setEditing(d);
      }}
      initialAction={intent}
      optionsOpen={optionsOpen}
      setOptionsOpen={setOptionsOpen}
    />
  );
  const tailscaleConnection = data.config.tailscale?.origin === location.origin;
  const menu: { name: Tab; icon: ReactNode }[] = [
    { name: "Devices", icon: <Monitor size={18} /> },
    { name: "Feeds", icon: <Columns2 size={18} /> },
    { name: "Capture Cards", icon: <Usb size={18} /> },
    { name: "Captures", icon: <Camera size={18} /> },
    { name: "History", icon: <History size={18} /> },
    { name: "Reports", icon: <BarChart3 size={18} /> },
    { name: "Settings", icon: <Settings size={18} /> },
    { name: "License", icon: <Lock size={18} /> },
  ];
  return (
    <div className="live-app">
      <aside className="live-sidebar">
        <Brand />
        <span className="live-workspace">{tailscaleConnection ? "TAILSCALE WORKSPACE" : "LOCAL WORKSPACE"}</span>
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
          <span className="live-dot" /> {tailscaleConnection ? "Connected through Tailscale" : "Running on this Mac"}
          <p>{tailscaleConnection ? "Devices and captures run on the host Mac." : "One daemon. Every client."}</p>
          <code>devdeck tui</code>
          <small>
            Visibility labels apply within this workspace.
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
              : tailscaleConnection ? "Tailscale connected" : "Local service connected"}
          </span>
        </div>
        <AccountConnection />
        {data.license && tab !== "License" && (
          <LicenseReminder
            status={data.license}
            open={() => {
              setTab("License");
              setViewing([]);
            }}
          />
        )}
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
        {data.inventoryObservation?.stale && <div className="live-notice" role="status">
          {data.inventoryObservation.observedAt === null ? "Checking device availability…" : `Showing device status last checked ${new Date(data.inventoryObservation.observedAt).toLocaleTimeString()}.`}
          {data.inventoryObservation.error ? ` ${data.inventoryObservation.error}` : data.inventoryObservation.refreshing ? " Refreshing…" : " Status refreshes while this page is visible."}
        </div>}
        {notice && (
          <div className="live-notice" role="status">
            {notice}
            <button onClick={() => setNotice("")}>Dismiss</button>
          </div>
        )}
        {tab === "Feeds" && (
          <FeedViewer
            request={feedRequest}
            sources={data.sources}
            devices={data.devices}
            launchSimulator={async (device) => {
              await api("devices.simulator", { deviceId: device.id, action: "launch" }, AbortSignal.timeout(300_000));
              await refresh();
              return currentSnapshot.current || data;
            }}
            renderPreview={(source) => {
              const device = data.devices.find((entry) => entry.id === source.deviceId || entry.captureSourceId === source.id);
              return <FeedPreview
                source={source}
                device={device}
                session={device ? activeSession(device.id) : undefined}
                lease={device ? credentials(device.id) : null}
                owner={data.config.settings.owner}
                recording={Boolean(device && data.recordings.some((recording) => recording.deviceId === device.id))}
                onLease={(value) => { if (device) setLeases((previous) => ({ ...previous, [device.id]: value })); }}
                refresh={refresh}
              />;
            }}
            renderActions={(source) => (
              <FeedActions
                name={source.name}
                remoteAvailable={data.devices.some((d) => (d.captureSourceId === source.id || d.id === source.deviceId) && deviceInputMode(d) === "remote")}
                wakeAvailable={data.devices.some(
                  (d) =>
                    (d.captureSourceId === source.id || d.id === source.deviceId) &&
                    supportsWake(d) &&
                    !d.locked &&
                    !busy,
                )}
                reserved={data.sessions.some(
                  (session) =>
                    (session.sourceId === source.id || session.deviceId === source.deviceId) &&
                    session.state !== "closed",
                )}
                recording={data.recordings.some(
                  (r) =>
                    r.deviceId === source.deviceId || data.devices.find((d) => d.id === r.deviceId)
                      ?.captureSourceId === source.id,
                )}
                onAction={(intent, anchor) =>
                  feedAction(source, intent, anchor)
                }
              />
            )}
          />
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
                  className="primary"
                  onClick={() =>
                    perform(async () => {
                      setDiscovery(await action("discover", { refresh: true }));
                      setShowDiscovery(true);
                    })
                  }
                  disabled={busy}
                >
                  <RefreshCw size={16} />
                  Discover / add devices
                </button>
                <button onClick={() => setEditing(false)}>
                  <Plus size={16} />
                  Add manually
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
              <div className="live-filters device-table-filters">
                <div className="device-filter-primary">
                  <DeviceFilterGroup
                    label="Platform"
                    ariaLabel="Filter platform"
                    value={filter.platform}
                    options={[
                      ["", "All platforms"],
                      ["Apple", "Apple"],
                      ["Roku", "Roku"],
                      ["Android", "Android"],
                      ["Other", "Other"],
                    ].map(([value, label]) => [
                      value,
                      label,
                      data.devices.filter((d) => !value || d.platform === value)
                        .length,
                    ])}
                    onChange={(platform) =>
                      setFilter((prev) => ({ ...prev, platform }))
                    }
                  />
                  <DeviceFilterGroup
                    label="Environment"
                    ariaLabel="Filter device environment"
                    value={filter.kind}
                    options={[
                      ["", "All environments"],
                      ["virtual", "Sim"],
                      ["physical", "Real"],
                    ]}
                    onChange={(kind) =>
                      setFilter((prev) => ({ ...prev, kind }))
                    }
                  />
                  <DeviceTypeFilter value={filter.formFactor} onChange={(formFactor) => setFilter((prev) => ({ ...prev, formFactor }))} />
                  <label className="live-search device-name-search">
                    <Search size={16} aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="Search devices"
                      placeholder="Search by name…"
                      value={filter.search}
                      onChange={(e) =>
                        setFilter({ ...filter, search: e.target.value })
                      }
                    />
                  </label>
                </div>
                <div className="device-filter-secondary">
                  <DeviceFilterGroup
                    label="Connection"
                    ariaLabel="Filter connection"
                    value={filter.health}
                    options={[
                      ["", "All"],
                      ["online", "Online"],
                      ["offline", "Offline"],
                    ]}
                    onChange={(health) =>
                      setFilter((prev) => ({ ...prev, health }))
                    }
                  />
                  <DeviceFilterGroup
                    label="Availability"
                    ariaLabel="Filter availability"
                    value={filter.reservation}
                    options={[
                      ["", "All"],
                      ["free", "Available"],
                      ["reserved", "Reserved"],
                      ["locked", "Locked"],
                    ]}
                    onChange={(reservation) =>
                      setFilter((prev) => ({ ...prev, reservation }))
                    }
                  />
                  <DeviceFilterGroup
                    label="Visibility"
                    ariaLabel="Filter visibility"
                    value={filter.visibility}
                    options={[
                      ["", "All"],
                      ["local", "Local"],
                      ["shared", "Shared"],
                    ]}
                    onChange={(visibility) =>
                      setFilter((prev) => ({ ...prev, visibility }))
                    }
                  />
                  <button
                    className="device-filter-reset"
                    onClick={() =>
                      setFilter({
                        search: "",
                        platform: "",
                        health: "",
                        reservation: "",
                        kind: "",
                        formFactor: "",
                        visibility: "",
                      })
                    }
                  >
                    Reset
                  </button>
                </div>
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
                      if (view) setFilter({ ...filter, formFactor: "", ...view.filters });
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
                      {sortHeader("device", "Device")}
                      {sortHeader("connection", "Connection")}
                      {sortHeader("reservation", "Reservation / reason")}
                      {sortHeader("capture", "Capture input")}
                      {sortHeader("visibility", "Visibility")}
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
                                {deviceActions(d)}
                              </div>
                            )}
                          </td>
                          <td>
                            <span
                              className={`live-status ${deviceIsBooting(d) ? "amber" : d.online ? "green" : ""}`}
                            >
                              {deviceConnectionLabel(d)}
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
                                {deviceAvailabilityLabel(d)}
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
                              )?.status || (deviceInputMode(d) === "touch" ? "No screen feed" : "Remote only")}
                            </small>
                          </td>
                          <td>
                            {d.visibility === "local"
                              ? "Local only"
                              : "Shared label"}
                          </td>
                          <td>
                            <div className="live-row-actions">
                              <SimulatorControls
                                device={d}
                                session={s}
                                lease={credentials(d.id)}
                                recording={data.recordings.some(
                                  (r) => r.deviceId === d.id,
                                )}
                                refresh={refresh}
                                manageSession={(anchor) => openControls(d, "reserve", anchor)}
                              />
                              <button onClick={() => openViewer([d.id])}>
                                View
                              </button>
                              <button onClick={() => setEditing(d)}>
                                Edit
                              </button>
                              {deviceActions(d)}
                              {deviceInputMode(d) === "remote" && <button
                                aria-label={`Copy CLI command for ${d.name}`}
                                onClick={() =>
                                  perform(async () => {
                                    const command = `devdeck remote --device '${d.name.replaceAll("'", "'\\''")}'`;
                                    if (!navigator.clipboard?.writeText) {
                                      setNotice(`Copy this command: ${command}`);
                                      return;
                                    }
                                    try { await navigator.clipboard.writeText(command); }
                                    catch { throw new Error(`Clipboard unavailable. Copy this command: ${command}`); }
                                    setNotice("CLI command copied.");
                                  })
                                }
                              >
                                <Terminal size={15} />
                              </button>}
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
                      {deviceActions(d)}
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
            </div>
          </>
        )}
        {tab === "Captures" && (
          <CaptureLibrary
            artifacts={data.artifacts}
            devices={data.devices}
            sessions={data.sessions}
            folder={data.config.settings.folder}
            operation={api}
            getBlob={getCaptureBlob}
            fileUrl={fileUrl}
            thumbnailUrl={captureThumbnailUrl}
            openArtifactId={openArtifactId}
            onOpenArtifact={setOpenArtifactId}
            onChange={refresh}
          />
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
              thumbnailUrl: `/v1/capture-card-thumbnail/${encodeURIComponent(s.id)}`,
              deviceId: data.devices.find((d) => d.captureSourceId === s.id)
                ?.id,
            }))}
            devices={data.devices.map((d) => ({
              ...d,
              captureOnly: d.connection.type === "capture",
              owner: activeSession(d.id)?.owner,
              reason: activeSession(d.id)?.reason,
              recording: data.recordings.some((r) => r.deviceId === d.id),
            }))}
            busy={busy}
            loading={cardsLoading}
            diagnostics={cards.diagnostics}
            revision={data.configRevision}
            deletedCount={data.config.ignoredCaptureCardIds?.length || 0}
            restoreDeleted={async () => {
              await saveConfig({ ...data.config, ignoredCaptureCardIds: [] });
              await refreshCards();
            }}
            remove={async (selectedCards) => {
              await saveConfig(deleteCaptureCards(data.config, selectedCards.map((card) => ({
                id: card.id, name: card.name, kind: "usb", uniqueId: card.uniqueId,
              }))));
              await refreshCards();
            }}
            assignMany={async (assignments) => {
              await saveConfig(assignCaptureCards(data.config, assignments.map(({ card, deviceId }) => ({
                card: { id: card.id, name: card.name, kind: "usb", uniqueId: card.uniqueId }, deviceId,
              }))));
              await refreshCards();
            }}
            viewMany={openDeviceFeeds}
            refresh={() => void refreshCards(true)}
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
            assignCustom={async (card, name) => {
              await saveConfig(
                assignCustomCaptureCard(
                  data.config,
                  {
                    id: card.id,
                    name: card.name,
                    kind: "usb",
                    uniqueId: card.uniqueId,
                  },
                  { id: browserUUID(), name },
                ),
              );
              await refreshCards();
            }}
          />
        )}
        {tab === "License" && (
          <License
            status={data.license}
            act={async (action, key) => {
              await api(
                `license.${action}`,
                action === "activate" ? { key } : {},
              );
              await refresh();
            }}
          />
        )}
        {tab === "Settings" && (
          <SettingsView data={data} save={saveConfig} busy={busy} />
        )}
      </main>
      {control && data.devices.find((d) => d.id === control.deviceId) && (deviceInputMode(data.devices.find((d) => d.id === control.deviceId)!) !== "remote" ? (
        <AnchoredPopover title={`Capture & session · ${data.devices.find((d) => d.id === control.deviceId)!.name}`} anchor={control.anchor} onClose={() => setControl(null)}>
          {controls(data.devices.find((d) => d.id === control.deviceId)!, control.action, true, () => {})}
        </AnchoredPopover>
      ) : (
        <FloatingRemote
          key={control.deviceId}
          storageKey={control.deviceId}
          requestKey={control}
          anchor={control.anchor}
          title={data.devices.find((d) => d.id === control.deviceId)!.name}
          initialMenu={
            control.action !== "remote" ||
            Boolean(activeSession(control.deviceId))
          }
          onClose={() => setControl(null)}
        >
          {(menu, setMenu) =>
            controls(
              data.devices.find((d) => d.id === control.deviceId)!,
              control.action,
              menu,
              setMenu,
            )
          }
        </FloatingRemote>
      ))}
      {identify && (
        <AnchoredPopover
          title={`Identify · ${identify.name}`}
          anchor={identify.anchor}
          onClose={() => setIdentify(null)}
        >
          <div className="identify-preview">
            {identify.sourceId && (
              <CapturePreview
                name={identify.name}
                endpoint={
                  data.sources.find((s) => s.id === identify.sourceId)?.kind ===
                  "native"
                    ? `/v1/preview/${encodeURIComponent(identify.deviceId || "")}`
                    : `/v1/source-preview/${encodeURIComponent(identify.sourceId)}`
                }
                intervalMs={100}
              />
            )}
            <div className="identify-label">
              <strong>{identify.name}</strong>
              <span>
                {identify.deviceId || "USB feed · no control connection"}
              </span>
            </div>
          </div>
          <p>
            This is the local preview for <strong>{identify.name}</strong>.
          </p>
          <dl className="identify-details">
            <dt>Capture input</dt>
            <dd>
              {data.sources.find((s) => s.id === identify.sourceId)?.name ||
                "No capture input"}
            </dd>
            <dt>USB identity</dt>
            <dd>
              {data.sources.find((s) => s.id === identify.sourceId)?.uniqueId ||
                "Native screen"}
            </dd>
            <dt>Control connection</dt>
            <dd>
              {identify.deviceId
                ? data.devices.find((d) => d.id === identify.deviceId)
                    ?.connection.type
                : "Not configured"}
            </dd>
          </dl>
        </AnchoredPopover>
      )}
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
          <DiscoveryDevices
            config={data.config}
            discovery={discovery}
            add={async (ids) => {
              const { config, added } = registerDiscoveredDevices(
                data.config,
                discovery,
                ids,
              );
              if (added.length) await saveConfig(config);
              setNotice(
                added.length
                  ? `Added ${added.length} ${added.length === 1 ? "device" : "devices"}.`
                  : "These devices are already configured.",
              );
              setShowDiscovery(false);
            }}
            configure={(device) => {
              setEditing(device);
              setShowDiscovery(false);
            }}
          />
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
      <CaptureToasts
        {...captureFeedback}
        onOpen={(id) => { setControl(null); setViewing([]); setTab("Captures"); setOpenArtifactId(id); }}
      />
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
    [avdName, setAvdName] = useState(
      device?.connection.type === "adb" ? device.connection.avdName || "" : "",
    ),
    [port, setPort] = useState(
      device?.connection.type === "adb" ? device.connection.port : 5037,
    ),
    [os, setOS] = useState(
      device?.connection.type === "simulator" ? device.connection.os : "ios",
    ),
    [source, setSource] = useState(device?.captureSourceId || ""),
    [visibility, setVisibility] = useState(device?.visibility || "local"),
    [tags, setTags] = useState((device?.tags || []).join(", ")),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  return (
    <Modal title={device ? "Configure device" : "Add device"} onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            const id = device?.id || browserUUID();
            const connection: DeviceConfig["connection"] =
              type === "roku"
                ? { type, host: address, serial: identity }
                : type === "adb"
                  ? {
                      type,
                      serial: address || `avd-${id}`,
                      port,
                      ...(avdName.trim() ? { avdName: avdName.trim() } : {}),
                      ...(identity ? { hardwareId: identity } : {}),
                    }
                  : type === "simulator"
                    ? { type, udid: address, os }
                    : type === "apple-tv"
                      ? { type, host: address, identifier: identity }
                      : type === "capture"
                        ? { type: "capture" }
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
                      : type === "capture"
                        ? "Other"
                        : "Apple",
                kind:
                  type === "simulator" ||
                  (type === "adb" &&
                    (Boolean(avdName.trim()) ||
                      address.startsWith("emulator-")))
                    ? "virtual"
                    : "physical",
                ...deviceEditorMetadata(device, tags),
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
            <option value="capture">Custom / HDMI device · capture only</option>
            <option value="roku">Roku · network ECP</option>
            <option value="adb">Android / Android TV · ADB</option>
            <option value="simulator">Apple simulator · simctl + idb</option>
            <option value="apple-tv">Apple TV · Companion</option>
            <option value="apple-device">
              Physical Apple · discovery only
            </option>
          </select>
        </label>
        {type === "capture" && (
          <small>
            Enter any device name, such as Mac mini, and choose its USB capture
            input. You can view, screenshot and record its feed.
          </small>
        )}
        {type !== "capture" && (
          <label>
            {type === "roku" || type === "apple-tv"
              ? "Host address"
              : type === "adb"
                ? "ADB serial"
                : "Device UDID"}
            <input
              required={type !== "adb" || !avdName.trim()}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
        )}
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
        {type === "adb" && (
          <label>
            Android virtual device (AVD) name
            <input
              value={avdName}
              onChange={(e) => setAvdName(e.target.value)}
              placeholder="Optional · exact name from Android Studio"
            />
            <small>
              For emulators only. Device Deck resolves its current ADB serial
              after launch.
            </small>
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
          <select
            required={type === "capture"}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
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
          Tags
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="ci, nightly, shared-lab"
          />
          <small>
            Comma-separated labels used by criteria-based reservations.
          </small>
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
          <h1>Settings</h1>
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
      <div className="live-panel live-settings live-remote-access">
        <h2>Remote access</h2>
        {data.config.tailscale ? (
          <>
            <p>
              <span className="live-status green">Tailscale configured</span>{" "}
              Open this address from another device connected to your tailnet:
            </p>
            <p>
              <a href={data.config.tailscale.origin}>
                {data.config.tailscale.origin}
              </a>
            </p>
            <p>
              Allowed users: {data.config.tailscale.allowedUsers.join(", ")}.
              These users have full access to devices, captures and settings.
            </p>
            <p>
              Check the connection with <code>devdeck tailscale status</code> on
              this Mac. To turn off remote access, run{" "}
              <code>devdeck tailscale disable</code>.
            </p>
          </>
        ) : (
          <p>
            Remote access is off. Run <code>devdeck tailscale enable</code> on
            this Mac, then open the HTTPS address from another device connected
            to your tailnet. Your Tailscale account signs you in automatically.
          </p>
        )}
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
            {(
              ["adb", "emulator", "ffmpeg", "ffprobe", "idb", "python"] as const
            ).map((tool) => (
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
            ))}
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
          Local browser access uses credentials owned by your Mac user.
          Tailscale access uses the allowed user's Tailscale identity.
        </p>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
