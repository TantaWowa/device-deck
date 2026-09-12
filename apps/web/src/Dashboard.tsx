import { Reports } from "./components/Reports";
import { CaptureCards } from "./components/CaptureCards";
import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Monitor,
  LayoutGrid,
  Images,
  History,
  ChartNoAxesCombined,
  Settings as SettingsIcon,
  Terminal,
  Search,
  Plus,
  ArrowLeft,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  ChevronRight,
  LockKeyhole,
  UnlockKeyhole,
  RotateCcw,
  X,
  Check,
  Copy,
  Camera,
  Circle,
  Square,
  Download,
  Usb,
  SlidersHorizontal,
  Eye,
  Home,
  CornerUpLeft,
  Play,
  Folder,
  Info,
  ExternalLink,
} from "lucide-react";
import { Brand } from "../../../packages/ui/src";
import {
  DemoModel,
  emptyFilters,
  filterDevices,
  cliCommand,
  type Device,
  type Filters,
  type Settings,
  type Artifact,
  type InputEntry,
} from "./demo/model";
import { SampleScreen, sampleBlob, download } from "./SampleScreen";
const STORAGE = "device-deck-demo-v2";
const formatTime = (n: number) =>
  new Date(n).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const duration = (n: number) =>
  `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(n % 60)
    .toString()
    .padStart(2, "0")}`;
function Button({
  children,
  primary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      className={`button ${primary ? "primary" : ""} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
    </div>
  );
}
export function Dashboard() {
  const [model] = useState(() => {
    const m = new DemoModel();
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) m.restore(raw);
    } catch {}
    return m;
  });
  const [, render] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [route, setRoute] = useState(location.hash.slice(1) || "devices");
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters });
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("roku-desk");
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [modal, setModal] = useState<{
    type: string;
    id?: string;
    action?: "lock" | "unlock" | "restart";
    mode?: Settings["captureMode"];
    last?: InputEntry;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<
    { id: string; ok: boolean; detail: string }[]
  >([]);
  const [lastInputs, setLastInputs] = useState<Record<string, InputEntry>>({});
  const [keyboard, setKeyboard] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [captureSearch, setCaptureSearch] = useState("");
  const [captureType, setCaptureType] = useState("");
  const [captureDevice, setCaptureDevice] = useState("");
  const [captureOrigin, setCaptureOrigin] = useState("");
  const [captureSelected, setCaptureSelected] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Artifact[]>([]);
  const [historyDevice, setHistoryDevice] = useState("");
  const persist = () => {
    try {
      localStorage.setItem(STORAGE, model.serialize());
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    render((n) => n + 1);
  };
  const notify = (s: string) => setToast(s);
  const act = (fn: () => unknown, message?: string) => {
    try {
      fn();
      persist();
      setError("");
      if (message) notify(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const nav = (value: string) => {
    location.hash = value;
    setRoute(value);
    setError("");
    setKeyboard(false);
    window.scrollTo(0, 0);
  };
  const open = (m: NonNullable<typeof modal>) => {
    setError("");
    setBulkResults([]);
    setModal(m);
  };
  const close = () => {
    if (!busy) {
      setModal(null);
      setError("");
    }
  };
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "devices");
      setKeyboard(false);
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const count = model.inventory.leases.length;
      model.expire();
      if (count !== model.inventory.leases.length) persist();
      setClock(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [model]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const section = route.split("/")[0];
  const multiIds =
    section === "multi"
      ? route
          .slice(6)
          .split(",")
          .filter((id) => model.inventory.devices.some((d) => d.id === id))
      : [];
  const focusId =
    section === "viewer"
      ? route.split("/")[1]
      : multiIds.includes(target)
        ? target
        : multiIds[0];
  const device = model.inventory.devices.find((d) => d.id === focusId);
  const send = (key: string) => {
    if (!device) return;
    act(() => {
      const entry = model.input(device.id, key);
      setLastInputs((s) => ({ ...s, [device.id]: entry }));
    });
  };
  useEffect(() => {
    if (!keyboard || !device || modal || !["viewer", "multi"].includes(section))
      return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,button,[contenteditable="true"]',
        ) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const keys: Record<string, string> = {
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Enter: "OK",
        Escape: "Back",
        " ": "Play / pause",
      };
      if (keys[e.key]) {
        e.preventDefault();
        send(keys[e.key]);
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [keyboard, device?.id, modal, section, clock]);
  const filtered = filterDevices(
    model.inventory.devices,
    model.inventory.leases,
    filters,
  );
  const filterCount = Object.values(filters).filter(Boolean).length;
  const sourceName = (id: string) =>
    model.inventory.sources.find((s) => s.id === id)?.name || "None";
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("Command copied. This remote command is illustrative.");
    } catch {
      open({ type: "copy", id: text });
    }
  };
  const copyImage = async (
    id: string,
    mode = model.settings.captureMode,
    last = lastInputs[id],
  ) => {
    try {
      const promise = sampleBlob(model.device(id), mode, last);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("Unavailable");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": promise }),
      ]);
      notify("Labelled sample PNG copied to the browser clipboard.");
    } catch {
      open({ type: "clipboard", id, mode, last });
    }
  };
  const screenshot = (id: string) => {
    if (
      act(
        () => model.capture(id),
        "Simulated screenshot added to the local library.",
      )
    ) {
      if (model.settings.clipboard) void copyImage(id);
    }
  };
  const reset = () => {
    const fresh = new DemoModel();
    model.inventory = fresh.inventory;
    model.settings = fresh.settings;
    model.artifacts = fresh.artifacts;
    model.history = fresh.history;
    model.inputs = [];
    model.screenFocus = {};
    model.savedViews = [];
    model.recordings.clear();
    model.reportSessions = fresh.reportSessions;
    model.reportCaptures = fresh.reportCaptures;
    model.reportContentions = fresh.reportContentions;
    setFilters({ ...emptyFilters });
    setSelected([]);
    setCaptureSelected([]);
    setCaptureSearch("");
    setCaptureType("");
    setCaptureDevice("");
    setCaptureOrigin("");
    setRemoved([]);
    setLastInputs({});
    persist();
    close();
    nav("devices");
    notify("Demo reset to the original sample workspace.");
  };
  const renderSource = (d: Device) => (
    <select
      aria-label={`Capture input for ${d.name}`}
      value={d.captureSourceId}
      disabled={model.recordings.has(d.id) || Boolean(model.lease(d.id))}
      onChange={(e) =>
        act(
          () => model.bindSource(d.id, e.target.value),
          "Simulated capture binding updated.",
        )
      }
    >
      <option value="">None</option>
      {model.inventory.sources
        .filter((s) => s.kind !== "native" || d.kind === "virtual")
        .map((s) => (
          <option value={s.id} key={s.id}>
            {s.name}
            {s.status === "missing" ? " · disconnected" : ""}
          </option>
        ))}
    </select>
  );
  const titles: Record<string, string> = {
    devices: "Devices",
    captures: "Capture library",
    cards: "Capture Cards",
    history: "Usage history",
    reports: "Reports",
    settings: "Local settings",
    connect: "CLI & agents",
    viewer: device?.name || "Device viewer",
    multi: "Multi-device view",
  };
  function viewerControls(d: Device) {
    const lease = model.lease(d.id);
    const recording = model.recordings.get(d.id);
    const allowed = Boolean(lease?.mine && d.online && !d.locked);
    const issue = model.sourceIssue(d.id);
    const logs = model.inputs.filter(
      (x) => x.deviceId === d.id && x.sessionId === lease?.id,
    );
    return (
      <div className="viewer-aside">
        <section className="panel remote-panel">
          <div className="section-heading">
            <h2>Remote control</h2>
            <Badge tone="blue">Single target</Badge>
          </div>
          <p className="target-label">
            Sending to <strong>{d.name}</strong>
          </p>
          <div className="remote-tools">
            <Button
              disabled={!allowed || !d.input}
              onClick={() => send("Home")}
              aria-label="Home"
            >
              <Home size={17} />
            </Button>
            <Button
              disabled={!allowed || !d.input}
              onClick={() => send("Back")}
              aria-label="Back"
            >
              <CornerUpLeft size={17} />
            </Button>
            <Button
              disabled={!allowed || !d.input}
              onClick={() => send("Play / pause")}
              aria-label="Play or pause"
            >
              <Play size={17} />
            </Button>
          </div>
          <div className="dpad">
            {[
              ["Up", ArrowUp],
              ["Left", ArrowLeft],
              ["OK", null],
              ["Right", ArrowRight],
              ["Down", ArrowDown],
            ].map(([key, Icon]) => (
              <button
                key={key as string}
                className={String(key).toLowerCase()}
                aria-label={key as string}
                disabled={!allowed || !d.input}
                onClick={() => send(key as string)}
              >
                {Icon ? <Icon size={21} /> : "OK"}
              </button>
            ))}
          </div>
          <form
            className="send-text"
            onSubmit={(e) => {
              e.preventDefault();
              if (textInput.trim()) {
                send(`Text: ${textInput}`);
                setTextInput("");
              }
            }}
          >
            <input
              aria-label="Text to device"
              placeholder="Send text to this device"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={!allowed || !d.input}
            />
            <Button
              disabled={!allowed || !d.input || !textInput.trim()}
              type="submit"
              aria-label="Send text"
            >
              <ArrowRight size={17} />
            </Button>
          </form>
          <label className="check-label">
            <input
              type="checkbox"
              checked={keyboard}
              onChange={(e) => setKeyboard(e.target.checked)}
              disabled={!allowed || !d.input}
            />{" "}
            Enable keyboard remote
          </label>
          <p className="help">
            Arrow keys, Enter, Esc and Space. Pauses while typing in fields.
          </p>
          {!d.input && (
            <p className="warning">
              Discovery only. Remote input is unavailable.
            </p>
          )}
          {!allowed && (
            <p className="warning">
              {lease && !lease.mine
                ? `Reserved by ${lease.owner}.`
                : d.locked
                  ? "Maintenance locked."
                  : !d.online
                    ? "Device is offline."
                    : "Reserve this device to control and capture."}
            </p>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Session</h2>
            <Badge>{lease ? "Reserved" : "Free"}</Badge>
          </div>
          {lease ? (
            <>
              <strong>{lease.owner}</strong>
              <p>{lease.reason}</p>
              <p className="help">
                {lease.id.slice(0, 20)} ·{" "}
                {Math.max(0, Math.ceil((lease.expiresAt - clock) / 60000))} min
                left
              </p>
              <div className="actions">
                <Button
                  disabled={!lease.mine}
                  onClick={() =>
                    act(() => model.renew(d.id), "Demo session renewed.")
                  }
                >
                  Renew
                </Button>
                <Button
                  disabled={!lease.mine}
                  onClick={() =>
                    act(
                      () => model.release(d.id),
                      "Session released. Maintenance locks are separate.",
                    )
                  }
                >
                  Release session
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="help">
                Owner names are labels. No account or login.
              </p>
              <Button
                primary
                disabled={!d.online || d.locked}
                onClick={() => open({ type: "reserve", id: d.id })}
              >
                Reserve device
              </Button>
            </>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Evidence mode</h2>
            <Badge>Simulated</Badge>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={model.settings.overlay}
              onChange={(e) =>
                act(() => (model.settings.overlay = e.target.checked))
              }
            />{" "}
            Show keypress overlay
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={model.settings.logging}
              onChange={(e) =>
                act(() => (model.settings.logging = e.target.checked))
              }
            />{" "}
            Log input with timestamps
          </label>
          <Field label="Capture output">
            <select
              value={model.settings.captureMode}
              onChange={(e) =>
                act(
                  () =>
                    (model.settings.captureMode = e.target
                      .value as Settings["captureMode"]),
                )
              }
            >
              <option value="clean">Clean · no key overlay</option>
              <option value="annotated">Annotated · include key overlay</option>
            </select>
          </Field>
          <p className="help">
            {recording
              ? `Current recording: ${recording.mode}. Changes apply to the next capture.`
              : "Sample-image labels remain visible in both modes."}
          </p>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Input timeline</h2>
            <button
              className="link-button"
              onClick={() =>
                download(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          simulated: true,
                          deviceId: d.id,
                          sessionId: lease?.id,
                          inputs: logs.slice().reverse(),
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                  `${d.id}-sample-input-log.json`,
                )
              }
            >
              <Download size={14} /> Export log
            </button>
          </div>
          <p className="help">
            {recording
              ? `Recording ${duration((clock - recording.startedAt) / 1000)}`
              : "Offsets are relative to each recording. Outside-recording input has no offset."}
          </p>
          <ol className="input-log">
            {logs.slice(0, 8).map((x) => (
              <li key={x.id}>
                <code>
                  {x.elapsedMs === null
                    ? "No rec."
                    : `+${(x.elapsedMs / 1000).toFixed(1)}s`}
                </code>
                <strong>{x.key}</strong>
                <span>{formatTime(x.at)}</span>
              </li>
            ))}
          </ol>
          {!logs.length && (
            <p className="help">Press a remote key to add a simulated entry.</p>
          )}
        </section>
      </div>
    );
  }
  function captureToolbar(d: Device) {
    const allowed = Boolean(model.lease(d.id)?.mine && d.online && !d.locked);
    const rec = model.recordings.get(d.id);
    return (
      <div className="capture-toolbar">
        <Button
          primary
          disabled={!allowed || Boolean(model.sourceIssue(d.id))}
          onClick={() => screenshot(d.id)}
        >
          <Camera size={16} /> Screenshot
        </Button>
        <Button
          disabled={!allowed || Boolean(model.sourceIssue(d.id))}
          onClick={() =>
            act(
              () => model.toggleRecording(d.id),
              rec
                ? "Simulated video metadata saved. No playable video was created."
                : "Simulated recording started.",
            )
          }
          className={rec ? "recording" : ""}
        >
          {rec ? <Square size={14} /> : <Circle size={14} />}{" "}
          {rec
            ? `Stop recording · ${duration((clock - rec.startedAt) / 1000)}`
            : "Record video"}
        </Button>
        <Button
          disabled={!allowed || Boolean(model.sourceIssue(d.id))}
          onClick={() => void copyImage(d.id)}
        >
          <Copy size={15} /> Copy sample PNG
        </Button>
      </div>
    );
  }
  const sessionFilter =
    section === "captures" && route.split("/")[1] === "session"
      ? route.split("/")[2]
      : "";
  const shownCaptures = model.artifacts.filter(
    (a) =>
      (!captureSearch ||
        `${a.name} ${a.tags.join(" ")}`
          .toLowerCase()
          .includes(captureSearch.toLowerCase())) &&
      (!captureType || a.kind === captureType) &&
      (!captureDevice || a.deviceId === captureDevice) &&
      (!captureOrigin || a.origin === captureOrigin) &&
      (!sessionFilter || a.sessionId === sessionFilter),
  );
  return (
    <>
      <div className="demo-banner">
        <span>
          <b>Interactive preview</b>
          <span className="banner-detail">
            {" "}
            Simulated devices, sources and captures. Nothing connects to your
            hardware.
          </span>
        </span>
        <a href="/">
          About Device Deck <ExternalLink size={13} />
        </a>
      </div>
      <div className="app-shell">
        <aside className="sidebar">
          <a href="#devices" className="app-brand">
            <Brand />
          </a>
          <div className="host">
            <span className="host-icon">
              <Monitor size={18} />
            </span>
            <div>
              <strong>My Mac workspace</strong>
              <small>Local app · no login</small>
            </div>
          </div>
          <div className="nav-label">WORKSPACE</div>
          <nav>
            {[
              ["devices", "Devices", Monitor],
              ["cards", "Capture Cards", Usb],
              ["captures", "Capture library", Images],
              ["history", "Usage history", History],
              ["reports", "Reports", ChartNoAxesCombined],
              ["connect", "CLI & agents", Terminal],
              ["settings", "Settings", SettingsIcon],
            ].map(([id, label, Icon]) => (
              <button
                key={id as string}
                aria-label={label as string}
                aria-current={
                  section === id ||
                  (id === "devices" && ["viewer", "multi"].includes(section))
                    ? "page"
                    : undefined
                }
                onClick={() => nav(id as string)}
                className={`nav-item ${section === id || (id === "devices" && ["viewer", "multi"].includes(section)) ? "active" : ""}`}
              >
                <Icon size={18} />
                <span>{label as string}</span>
                {id === "devices" && (
                  <small>{model.inventory.devices.length}</small>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-note">
              <Folder size={16} />
              <div>
                <strong>Your Mac. Your files.</strong>
                <p>One capture folder for web, CLI and agents.</p>
              </div>
            </div>
            <button
              className="link-button reset"
              onClick={() => open({ type: "reset" })}
            >
              <RotateCcw size={15} /> Reset demo
            </button>
          </div>
        </aside>
        <main>
          <header className="page-header">
            <div>
              <div className="eyebrow">
                MY MAC /{" "}
                {["viewer", "multi"].includes(section)
                  ? "DEVICES"
                  : "WORKSPACE"}
              </div>
              <h1>{titles[section] || "Devices"}</h1>
              <p>
                {section === "devices"
                  ? "Find a device, check ownership, and start a session."
                  : section === "captures"
                    ? "Every screenshot and recording, in one local library."
                    : section === "multi"
                      ? "Choose a tile to control. Commands only go to the selected device."
                      : section === "viewer"
                        ? `${device?.platform} · ${device?.model}`
                        : section === "history"
                          ? "Sessions, ownership changes and evidence from this workspace."
                          : section === "reports"
                            ? "A small view of device use and capture reliability."
                            : section === "settings"
                              ? "Defaults for this Mac. Owner labels do not require accounts."
                              : "Use a friendly name from the terminal, a browser, or an agent."}
              </p>
            </div>
            <div className="header-actions">
              {section === "devices" ? (
                <Button primary onClick={() => open({ type: "device" })}>
                  <Plus size={17} /> Add device
                </Button>
              ) : ["viewer", "multi"].includes(section) ? (
                <Button onClick={() => nav("devices")}>
                  <ArrowLeft size={16} /> Devices
                </Button>
              ) : (
                <Badge>Local demo</Badge>
              )}
            </div>
          </header>
          {storageError && (
            <div role="alert" className="warning">
              Browser storage is unavailable or full. Changes last only until
              this page closes.
            </div>
          )}
          {error && !modal && (
            <div role="alert" className="error-banner">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {section === "devices" && (
            <>
              <div className="summary-strip">
                <div>
                  <span className="metric-number">
                    {model.inventory.devices.length}
                  </span>
                  <span>Configured devices</span>
                </div>
                <div>
                  <span className="metric-number">
                    {
                      model.inventory.devices.filter(
                        (d) => d.online && !d.locked && !model.lease(d.id),
                      ).length
                    }
                  </span>
                  <span>Ready to reserve</span>
                </div>
                <div>
                  <span className="metric-number">
                    {model.inventory.leases.length}
                  </span>
                  <span>Reserved</span>
                </div>
                <div>
                  <span className="metric-number">
                    {
                      model.inventory.devices.filter(
                        (d) => d.locked || !d.online,
                      ).length
                    }
                  </span>
                  <span>Need attention</span>
                </div>
              </div>
              <div className="inventory panel">
                <div className="saved-views">
                  <button
                    className={!filterCount ? "selected" : ""}
                    onClick={() => setFilters({ ...emptyFilters })}
                  >
                    All devices <span>{model.inventory.devices.length}</span>
                  </button>
                  <button
                    onClick={() =>
                      setFilters({
                        ...emptyFilters,
                        health: "online",
                        reserved: "free",
                        locked: "unlocked",
                      })
                    }
                  >
                    Ready to use
                  </button>
                  <button
                    onClick={() =>
                      setFilters({ ...emptyFilters, reserved: "reserved" })
                    }
                  >
                    Reserved
                  </button>
                  <button
                    onClick={() =>
                      setFilters({ ...emptyFilters, kind: "virtual" })
                    }
                  >
                    Emulators & simulators
                  </button>
                  {model.savedViews.map((v) => (
                    <button
                      key={v.name}
                      onClick={() => setFilters({ ...v.filters })}
                    >
                      {v.name}
                    </button>
                  ))}
                  <button
                    className="save-view"
                    onClick={() => open({ type: "save-view" })}
                  >
                    <Plus size={14} /> Save view
                  </button>
                </div>
                <div className="filters">
                  <label className="search-box">
                    <Search size={17} />
                    <input
                      aria-label="Search devices"
                      placeholder="Search friendly name or model…"
                      value={filters.search}
                      onChange={(e) =>
                        setFilters({ ...filters, search: e.target.value })
                      }
                    />
                  </label>
                  {(
                    [
                      [
                        "platform",
                        "Platform",
                        [
                          ["Roku", "Roku"],
                          ["Android", "Android"],
                          ["Apple", "Apple"],
                        ],
                      ],
                      [
                        "health",
                        "Health",
                        [
                          ["online", "Online"],
                          ["offline", "Offline"],
                        ],
                      ],
                      [
                        "reserved",
                        "Reservation",
                        [
                          ["free", "Free"],
                          ["reserved", "Reserved"],
                        ],
                      ],
                      [
                        "locked",
                        "Maintenance",
                        [
                          ["locked", "Locked"],
                          ["unlocked", "Unlocked"],
                        ],
                      ],
                      [
                        "kind",
                        "Device type",
                        [
                          ["physical", "Physical"],
                          ["virtual", "Emulator / simulator"],
                        ],
                      ],
                      [
                        "visibility",
                        "Visibility",
                        [
                          ["local", "Local only"],
                          ["shared", "Shared"],
                        ],
                      ],
                    ] as [keyof Filters, string, string[][]][]
                  ).map(([key, label, options]) => (
                    <select
                      key={key}
                      aria-label={label}
                      value={filters[key]}
                      onChange={(e) =>
                        setFilters({ ...filters, [key]: e.target.value })
                      }
                    >
                      <option value="">{label}</option>
                      {options.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
                <div className="table-meta">
                  <span>
                    {filtered.length} of {model.inventory.devices.length}{" "}
                    devices
                    {filterCount ? ` · ${filterCount} active filters` : ""}
                  </span>
                  <button
                    className="link-button"
                    onClick={() => setFilters({ ...emptyFilters })}
                  >
                    <RotateCcw size={13} /> Reset filters
                  </button>
                  <span className="preview-hint">
                    <Eye size={14} /> Hover, focus or tap Preview
                  </span>
                </div>
                {selected.length > 0 && (
                  <div className="selection-bar">
                    <strong>
                      {selected.length} selected
                      {selected.some((id) => !filtered.some((d) => d.id === id))
                        ? " · includes hidden rows"
                        : ""}
                    </strong>
                    <Button
                      primary
                      onClick={() => {
                        setTarget(selected[0]);
                        nav(`multi/${selected.join(",")}`);
                      }}
                    >
                      <LayoutGrid size={15} /> Open multi-view
                    </Button>
                    {(["lock", "unlock", "restart"] as const).map((action) => (
                      <Button
                        key={action}
                        onClick={() => open({ type: "bulk", action })}
                      >
                        {action === "lock" ? (
                          <LockKeyhole size={14} />
                        ) : action === "unlock" ? (
                          <UnlockKeyhole size={14} />
                        ) : (
                          <RotateCcw size={14} />
                        )}{" "}
                        {action === "lock"
                          ? "Lock"
                          : action === "unlock"
                            ? "Unlock"
                            : "Restart"}
                      </Button>
                    ))}
                    <button
                      className="link-button"
                      onClick={() => setSelected([])}
                    >
                      Clear selection
                    </button>
                  </div>
                )}
                <div className="mobile-table-hint">
                  Swipe the table to see ownership, inputs and row actions.
                </div>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Devices table"
                >
                  <table className="device-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Select all filtered devices"
                            checked={
                              filtered.length > 0 &&
                              filtered.every((d) => selected.includes(d.id))
                            }
                            ref={(el) => {
                              if (el)
                                el.indeterminate =
                                  filtered.some((d) =>
                                    selected.includes(d.id),
                                  ) &&
                                  !filtered.every((d) =>
                                    selected.includes(d.id),
                                  );
                            }}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [
                                      ...new Set([
                                        ...selected,
                                        ...filtered.map((d) => d.id),
                                      ]),
                                    ]
                                  : selected.filter(
                                      (id) =>
                                        !filtered.some((d) => d.id === id),
                                    ),
                              )
                            }
                          />
                        </th>
                        <th>Device</th>
                        <th>Platform / type</th>
                        <th>Connection / health</th>
                        <th>Reservation</th>
                        <th>Owner / reason</th>
                        <th>Capture input</th>
                        <th>Visibility</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((d) => {
                        const l = model.lease(d.id);
                        return (
                          <tr
                            key={d.id}
                            className={
                              selected.includes(d.id) ? "row-selected" : ""
                            }
                            data-testid={`device-${d.id}`}
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${d.name}`}
                                checked={selected.includes(d.id)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, d.id]
                                      : selected.filter((id) => id !== d.id),
                                  )
                                }
                              />
                            </td>
                            <td>
                              <button
                                className="device-name"
                                onClick={() => nav(`viewer/${d.id}`)}
                              >
                                {d.name}
                              </button>
                              <small>{d.model}</small>
                            </td>
                            <td>
                              <span>{d.platform}</span>
                              <small>
                                {d.kind === "physical"
                                  ? "Physical"
                                  : d.platform === "Apple"
                                    ? "Simulator"
                                    : "Emulator"}
                              </small>
                            </td>
                            <td>
                              <Badge tone={d.online ? "green" : "gray"}>
                                {d.online ? "Online" : "Offline"}
                              </Badge>
                              {d.locked && (
                                <div className="maintenance-label">
                                  <LockKeyhole size={11} /> Maintenance locked
                                </div>
                              )}
                            </td>
                            <td>
                              <Badge tone={l ? "blue" : ""}>
                                {l ? "Reserved" : "Free"}
                              </Badge>
                              {l && (
                                <small>
                                  {Math.max(
                                    0,
                                    Math.ceil((l.expiresAt - clock) / 60000),
                                  )}{" "}
                                  min remaining
                                </small>
                              )}
                            </td>
                            <td>
                              <span>{l?.owner || "Unassigned"}</span>
                              <small>
                                {l?.reason ||
                                  (d.locked
                                    ? "Firmware & cable checks"
                                    : "No active session")}
                              </small>
                            </td>
                            <td className="source-cell">
                              {renderSource(d)}
                              {model.sourceIssue(d.id) && d.captureSourceId && (
                                <small className="source-warning">
                                  {model.sourceIssue(d.id)}
                                </small>
                              )}
                              <div className="preview-wrap">
                                <button
                                  className="link-button"
                                  onClick={() =>
                                    open({ type: "preview", id: d.id })
                                  }
                                >
                                  <Eye size={13} /> Preview
                                </button>
                                <div className="hover-preview" role="tooltip">
                                  <strong>{d.name}</strong>
                                  <SampleScreen
                                    device={d}
                                    issue={model.sourceIssue(d.id)}
                                    compact
                                  />
                                  <small>
                                    Simulated input ·{" "}
                                    {sourceName(d.captureSourceId)}
                                  </small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <Badge>
                                {d.visibility === "local"
                                  ? "Local only"
                                  : "Shared"}
                              </Badge>
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`Edit ${d.name}`}
                                onClick={() =>
                                  open({ type: "device", id: d.id })
                                }
                              >
                                <SlidersHorizontal size={16} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!filtered.length && (
                    <div className="empty-state">
                      <Search />
                      <h2>No matching devices</h2>
                      <p>Try another combination or reset the filters.</p>
                      <Button onClick={() => setFilters({ ...emptyFilters })}>
                        Reset filters
                      </Button>
                    </div>
                  )}
                </div>
                <div className="table-footer">
                  <Info size={14} />
                  <span>
                    USB inputs are a simulated host discovery list. Devices and
                    capture inputs are separate.
                  </span>
                  <span>
                    Shared visibility is a future local-network concept.
                  </span>
                </div>
              </div>
              <div className="below-table">
                <div>
                  <Terminal size={20} />
                  <div>
                    <h2>Pick a device from your terminal</h2>
                    <p>
                      Use a friendly name, or open an interactive picker with
                      platform and state filters.
                    </p>
                  </div>
                </div>
                <button className="link-button" onClick={() => nav("connect")}>
                  See CLI workflow <ArrowRight size={16} />
                </button>
              </div>
              <div className="status-legend">
                <span>
                  <Badge>Offline</Badge> Connection health
                </span>
                <span>
                  <Badge>Maintenance locked</Badge> Explicitly held out of use
                </span>
                <span>
                  <Badge tone="blue">Reserved</Badge> Owned by a session
                </span>
              </div>
            </>
          )}
          {["viewer", "multi"].includes(section) && device && (
            <div className="viewer-layout">
              <div className="viewer-main">
                {section === "viewer" ? (
                  <section className="panel viewer-stage">
                    <div className="stage-heading">
                      <div>
                        <Monitor size={18} />
                        <strong>{device.name}</strong>
                        <Badge tone="green">
                          {device.online ? "Online" : "Offline"}
                        </Badge>
                      </div>
                      <Badge>Simulated preview</Badge>
                    </div>
                    <SampleScreen
                      device={device}
                      issue={model.sourceIssue(device.id)}
                      last={lastInputs[device.id]}
                      overlay={model.settings.overlay}
                    />
                    {captureToolbar(device)}
                    <div className="source-controls">
                      <Field label="Device input source">
                        {renderSource(device)}
                      </Field>
                      <span>
                        {device.visibility === "local"
                          ? "Local only"
                          : "Shared on this Mac"}{" "}
                        ·{" "}
                        {device.input
                          ? "Remote input capability"
                          : "No remote input capability"}
                      </span>
                    </div>
                  </section>
                ) : (
                  <section className="multi-panel">
                    <div className="multi-grid">
                      {multiIds.map((id) => {
                        const d = model.device(id);
                        return (
                          <button
                            key={id}
                            className={`device-tile ${device.id === id ? "active" : ""}`}
                            onClick={() => {
                              setTarget(id);
                              setError("");
                              setTextInput("");
                            }}
                            aria-pressed={device.id === id}
                            aria-label={`Control ${d.name}`}
                          >
                            <div className="tile-head">
                              <strong>{d.name}</strong>
                              <Badge tone={device.id === id ? "blue" : ""}>
                                {device.id === id
                                  ? "Control target"
                                  : model.lease(id)?.owner || "Free"}
                              </Badge>
                            </div>
                            <SampleScreen
                              device={d}
                              issue={model.sourceIssue(id)}
                              last={lastInputs[id]}
                              overlay={model.settings.overlay}
                              compact
                            />
                            <div className="tile-footer">
                              {d.platform} · {sourceName(d.captureSourceId)}
                              {model.recordings.has(id) && (
                                <span>Recording</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="panel">
                      <strong>Capture target: {device.name}</strong>
                      {captureToolbar(device)}
                      <p className="help">
                        Each tile has its own session and input log. No command
                        broadcasts to the grid.
                      </p>
                      <button
                        className="link-button"
                        onClick={() => nav(`viewer/${device.id}`)}
                      >
                        Open focused viewer <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                )}
                <section className="panel viewer-details">
                  <div className="section-heading">
                    <h2>Device & evidence</h2>
                    <button
                      className="link-button"
                      onClick={() => open({ type: "device", id: device.id })}
                    >
                      Edit device
                    </button>
                  </div>
                  <div className="detail-grid">
                    <div>
                      <small>Device identity</small>
                      <code>{device.id}</code>
                    </div>
                    <div>
                      <small>Capture source</small>
                      <span>{sourceName(device.captureSourceId)}</span>
                    </div>
                    <div>
                      <small>Output folder</small>
                      <code>{model.settings.folder}</code>
                    </div>
                    <div>
                      <small>Current session</small>
                      <span>
                        {model.lease(device.id)?.owner || "Unreserved"} ·{" "}
                        {model.lease(device.id)?.reason || "No active reason"}
                      </span>
                    </div>
                  </div>
                  <div className="actions">
                    <Button
                      onClick={() => void copyText(cliCommand(device))}
                      disabled={!device.input}
                    >
                      <Terminal size={15} /> Copy CLI command
                    </Button>
                    <Button
                      onClick={() => {
                        setHistoryDevice(device.id);
                        nav("history");
                      }}
                    >
                      <History size={15} /> Usage history
                    </Button>
                    <Button
                      onClick={() => {
                        setCaptureDevice(device.id);
                        nav("captures");
                      }}
                    >
                      <Images size={15} /> Device captures
                    </Button>
                    {model.lease(device.id) && (
                      <Button
                        onClick={() => {
                          setCaptureDevice("");
                          setCaptureSearch("");
                          setCaptureType("");
                          setCaptureOrigin("");
                          nav(`captures/session/${model.lease(device.id)!.id}`);
                        }}
                      >
                        Session captures
                      </Button>
                    )}
                  </div>
                  <p className="help">
                    Remote CLI examples are illustrative. Browser captures
                    create demo metadata, not files in your Mac folder.
                  </p>
                </section>
                <section className="panel">
                  <div className="section-heading">
                    <h2>Recent captures</h2>
                    <button
                      className="link-button"
                      onClick={() => {
                        setCaptureDevice(device.id);
                        nav("captures");
                      }}
                    >
                      View library <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="recent-captures">
                    {model.artifacts
                      .filter((a) => a.deviceId === device.id)
                      .slice(0, 3)
                      .map((a) => (
                        <button
                          key={a.id}
                          onClick={() => open({ type: "capture", id: a.id })}
                        >
                          {a.kind === "screenshot" ? (
                            <Camera size={19} />
                          ) : (
                            <Circle size={19} />
                          )}
                          <span>
                            <strong>{a.name}</strong>
                            <small>
                              {formatTime(a.createdAt)} · {a.mode} · simulated
                            </small>
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                  </div>
                </section>
              </div>
              {viewerControls(device)}
            </div>
          )}
          {["viewer", "multi"].includes(section) && !device && (
            <div className="empty-state">
              <h2>No device selected</h2>
              <Button onClick={() => nav("devices")}>Choose devices</Button>
            </div>
          )}
          {section === "captures" && (
            <>
              <div className="folder-banner">
                <Folder size={21} />
                <div>
                  <strong>{model.settings.folder}</strong>
                  <span>
                    Common Mac folder for web, CLI and agents · no cloud storage
                  </span>
                </div>
                <button className="link-button" onClick={() => nav("settings")}>
                  Change folder
                </button>
              </div>
              <div className="notice">
                This preview stores capture metadata in your browser. Sample
                PNGs can be copied or downloaded. Videos are simulated entries
                with no playable file.
              </div>
              <section className="panel library">
                <div className="filters">
                  <label className="search-box">
                    <Search size={17} />
                    <input
                      aria-label="Search capture names or tags"
                      placeholder="Search names or tags…"
                      value={captureSearch}
                      onChange={(e) => setCaptureSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Capture type"
                    value={captureType}
                    onChange={(e) => setCaptureType(e.target.value)}
                  >
                    <option value="">All types</option>
                    <option value="screenshot">Screenshots</option>
                    <option value="recording">Recordings</option>
                  </select>
                  <select
                    aria-label="Capture device"
                    value={captureDevice}
                    onChange={(e) => setCaptureDevice(e.target.value)}
                  >
                    <option value="">All devices</option>
                    {model.inventory.devices.map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Capture origin"
                    value={captureOrigin}
                    onChange={(e) => setCaptureOrigin(e.target.value)}
                  >
                    <option value="">All origins</option>
                    {["Web", "CLI", "Agent"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    className="link-button"
                    onClick={() => {
                      setCaptureSearch("");
                      setCaptureType("");
                      setCaptureDevice("");
                      setCaptureOrigin("");
                      nav("captures");
                    }}
                  >
                    Reset filters
                  </button>
                </div>
                <div className="table-meta">
                  <span>
                    {shownCaptures.length} captures
                    {sessionFilter
                      ? ` · session ${sessionFilter.slice(0, 18)}`
                      : ""}
                  </span>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      aria-label="Select filtered captures"
                      checked={
                        shownCaptures.length > 0 &&
                        shownCaptures.every((a) =>
                          captureSelected.includes(a.id),
                        )
                      }
                      onChange={(e) =>
                        setCaptureSelected(
                          e.target.checked
                            ? [
                                ...new Set([
                                  ...captureSelected,
                                  ...shownCaptures.map((a) => a.id),
                                ]),
                              ]
                            : captureSelected.filter(
                                (id) => !shownCaptures.some((a) => a.id === id),
                              ),
                        )
                      }
                    />{" "}
                    Select visible
                  </label>
                  {captureSelected.length > 0 && (
                    <>
                      <strong>{captureSelected.length} selected</strong>
                      <Button onClick={() => open({ type: "remove" })}>
                        Remove selected
                      </Button>
                      <button
                        className="link-button"
                        onClick={() => setCaptureSelected([])}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
                {removed.length > 0 && (
                  <div className="undo-bar">
                    {removed.length} capture entries removed.
                    <Button
                      onClick={() => {
                        model.undoRemove(removed);
                        setRemoved([]);
                        persist();
                      }}
                    >
                      Undo removal
                    </Button>
                  </div>
                )}
                <div className="capture-grid">
                  {shownCaptures.map((a) => (
                    <article className="capture-card" key={a.id}>
                      <div className="capture-thumb">
                        <img
                          src={`${import.meta.env?.BASE_URL || "/"}assets/fjord-preview.webp`}
                          alt="Sample landscape artwork"
                        />
                        <label className="capture-select">
                          <input
                            type="checkbox"
                            aria-label={`Select capture ${a.name}`}
                            checked={captureSelected.includes(a.id)}
                            onChange={(e) =>
                              setCaptureSelected(
                                e.target.checked
                                  ? [...captureSelected, a.id]
                                  : captureSelected.filter((id) => id !== a.id),
                              )
                            }
                          />
                        </label>
                        <Badge>
                          {a.kind === "recording"
                            ? `Video · ${duration(a.duration)}`
                            : "Screenshot"}
                        </Badge>
                        <span className="sample-marker">SAMPLE</span>
                      </div>
                      <button
                        className="capture-name"
                        onClick={() => open({ type: "capture", id: a.id })}
                      >
                        {a.name}
                      </button>
                      <div className="capture-info">
                        <span>{model.device(a.deviceId).name}</span>
                        <span>
                          {formatTime(a.createdAt)} ·{" "}
                          {new Date(a.createdAt).toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </div>
                      <div className="capture-tags">
                        {a.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                        <span>
                          {a.origin} · {a.mode}
                        </span>
                      </div>
                      <div className="capture-actions">
                        <button
                          className="link-button"
                          onClick={() => open({ type: "capture", id: a.id })}
                        >
                          Details / edit
                        </button>
                        <button
                          className="link-button"
                          onClick={() => {
                            setHistoryDevice(a.deviceId);
                            nav("history");
                          }}
                        >
                          Session history
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {!shownCaptures.length && (
                  <div className="empty-state">
                    <Images />
                    <h2>No captures in this view</h2>
                    <p>
                      Try other filters or take a simulated screenshot from a
                      device viewer.
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
          {section === "history" && (
            <section className="panel history-panel">
              <div className="section-heading">
                <h2>Workspace activity</h2>
                <Badge>Seeded + demo activity</Badge>
              </div>
              <div className="filters">
                <select
                  aria-label="History device"
                  value={historyDevice}
                  onChange={(e) => setHistoryDevice(e.target.value)}
                >
                  <option value="">All devices</option>
                  {model.inventory.devices.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <span className="help">
                  Sessions, owners, reasons, locks, restarts and captures
                </span>
              </div>
              <ol className="history-list">
                {model.history
                  .filter((h) => !historyDevice || h.deviceId === historyDevice)
                  .sort((a, b) => b.at - a.at)
                  .map((h) => (
                    <li key={h.id}>
                      <span className="history-symbol">
                        {h.captureId ? (
                          <Camera size={17} />
                        ) : h.action.includes("lock") ? (
                          <LockKeyhole size={17} />
                        ) : (
                          <History size={17} />
                        )}
                      </span>
                      <div>
                        <strong>{h.action}</strong>
                        <p>
                          <button
                            className="link-button"
                            onClick={() => nav(`viewer/${h.deviceId}`)}
                          >
                            {model.device(h.deviceId).name}
                          </button>{" "}
                          · {h.owner}
                        </p>
                        <span>{h.detail}</span>
                        {h.sessionId && <small>Session {h.sessionId}</small>}
                      </div>
                      <div className="history-end">
                        <time>{formatTime(h.at)}</time>
                        {h.sessionId && (
                          <button
                            className="link-button"
                            onClick={() => {
                              setCaptureSearch("");
                              setCaptureDevice("");
                              setCaptureType("");
                              setCaptureOrigin("");
                              nav(`captures/session/${h.sessionId}`);
                            }}
                          >
                            Session captures <ArrowRight size={13} />
                          </button>
                        )}
                        {h.captureId &&
                          !model.artifacts.some(
                            (a) => a.id === h.captureId,
                          ) && <small>Capture removed</small>}
                      </div>
                    </li>
                  ))}
              </ol>
            </section>
          )}
          {section === "reports" && (
            <Reports
              demo
              load={(request) => model.report(request)}
              devices={model.inventory.devices}
              storageKey="deck-demo-report-range"
            />
          )}
          {section === "cards" && (
            <CaptureCards
              demo
              cards={model.inventory.sources
                .filter((s) => s.kind === "usb")
                .map((s) => ({
                  ...s,
                  uniqueId: s.uniqueId || `demo-${s.id}`,
                  deviceId: model.inventory.devices.find(
                    (d) => d.captureSourceId === s.id,
                  )?.id,
                }))}
              devices={model.inventory.devices.map((d) => ({
                ...d,
                owner: model.lease(d.id)?.owner,
                reason: model.lease(d.id)?.reason,
                recording: model.recordings.has(d.id),
              }))}
              busy={busy}
              refresh={() => {
                render((n) => n + 1);
                notify(
                  "Simulated capture card discovery refreshed. Bindings retained.",
                );
              }}
              view={(id) => nav(`viewer/${id}`)}
              assign={async (card, id) => {
                model.assignCard(card.id, id);
                persist();
                notify("Simulated capture card assignment saved.");
              }}
            />
          )}
          {section === "settings" && (
            <SettingsForm
              settings={model.settings}
              save={(s) =>
                act(
                  () => model.saveSettings(s),
                  "Local demo settings saved in this browser.",
                )
              }
              reset={() => open({ type: "reset" })}
            />
          )}
          {section === "connect" && (
            <Connect devices={model.inventory.devices} copy={copyText} />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.type === "device"
              ? modal.id
                ? "Edit device"
                : "Add device"
              : modal.type === "reserve"
                ? "Reserve device"
                : modal.type === "bulk"
                  ? `${modal.action === "lock" ? "Lock" : modal.action === "unlock" ? "Unlock" : "Restart"} selected devices`
                  : modal.type === "preview"
                    ? `${model.device(modal.id!).name} preview`
                    : modal.type === "capture"
                      ? "Capture details"
                      : modal.type === "save-view"
                        ? "Save filtered view"
                        : modal.type === "remove"
                          ? "Remove capture entries?"
                          : modal.type === "reset"
                            ? "Reset demo workspace?"
                            : modal.type === "clipboard"
                              ? "Sample-image clipboard fallback"
                              : "Copy illustrative command"
          }
          close={close}
        >
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          {modal.type === "device" && (
            <DeviceForm
              device={modal.id ? model.device(modal.id) : undefined}
              sources={model.inventory.sources}
              onSave={(d) => {
                if (
                  act(
                    () => model.saveDevice(d),
                    "Device saved in the simulated workspace.",
                  )
                )
                  close();
              }}
            />
          )}
          {modal.type === "reserve" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                if (
                  act(
                    () =>
                      model.reserve(
                        modal.id!,
                        String(data.get("reason")),
                        String(data.get("owner")),
                      ),
                    "Demo session reserved.",
                  )
                )
                  close();
              }}
            >
              <p>
                {model.device(modal.id!).name} · {model.settings.ttl} minutes
              </p>
              <Field label="Owner label">
                <input
                  name="owner"
                  defaultValue={model.settings.owner}
                  required
                />
              </Field>
              <p className="help">
                A human, agent or job label. No login or account is created.
              </p>
              <Field label="Reservation reason">
                <input
                  name="reason"
                  required
                  placeholder="What are you checking?"
                />
              </Field>
              <Button primary type="submit">
                Reserve for {model.settings.ttl} minutes
              </Button>
            </form>
          )}
          {modal.type === "bulk" && (
            <>
              <p>
                {modal.action === "unlock"
                  ? "Remove maintenance locks. This does not release reservations."
                  : modal.action === "lock"
                    ? "Hold free devices out of use for maintenance. Reserved devices are skipped."
                    : "Restart online, unlocked, unreserved devices with restart capability."}
              </p>
              <ul className="bulk-list">
                {selected.map((id) => {
                  const result = bulkResults.find((x) => x.id === id);
                  const reason = model.eligibility(id, modal.action!);
                  return (
                    <li key={id}>
                      <strong>{model.device(id).name}</strong>
                      <span>
                        {result
                          ? `${result.ok ? "Completed" : "Skipped"} · ${result.detail}`
                          : busy
                            ? "Simulated operation in progress…"
                            : reason
                              ? `Will skip · ${reason}`
                              : "Eligible"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="help">
                All operations are simulated. No hardware is restarted.
              </p>
              {!bulkResults.length ? (
                <Button
                  primary
                  disabled={
                    busy ||
                    !selected.some(
                      (id) => !model.eligibility(id, modal.action!),
                    )
                  }
                  onClick={async () => {
                    setBusy(true);
                    await new Promise((r) => setTimeout(r, 650));
                    setBulkResults(model.bulk(selected, modal.action!));
                    persist();
                    setBusy(false);
                  }}
                >
                  {busy ? "Running simulation…" : "Run simulated operation"}
                </Button>
              ) : (
                <Button primary onClick={close}>
                  Done
                </Button>
              )}
            </>
          )}
          {modal.type === "preview" && (
            <>
              <SampleScreen
                device={model.device(modal.id!)}
                issue={model.sourceIssue(modal.id!)}
                last={lastInputs[modal.id!]}
                overlay={model.settings.overlay}
              />
              <p>
                {sourceName(model.device(modal.id!).captureSourceId)} ·
                simulated preview
              </p>
              <Button
                primary
                onClick={() => {
                  nav(`viewer/${modal.id}`);
                  close();
                }}
              >
                Open device viewer <ArrowRight size={15} />
              </Button>
            </>
          )}
          {modal.type === "save-view" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(
                  new FormData(e.currentTarget).get("name"),
                ).trim();
                if (!name) return;
                const existing = model.savedViews.find((v) => v.name === name);
                if (existing) existing.filters = { ...filters };
                else model.savedViews.push({ name, filters: { ...filters } });
                persist();
                close();
              }}
            >
              <p>
                Saves all {filterCount} active filters on this browser. Reusing
                a name updates that view.
              </p>
              <Field label="View name">
                <input name="name" required maxLength={24} />
              </Field>
              <Button primary type="submit">
                Save view
              </Button>
            </form>
          )}
          {modal.type === "capture" &&
            (() => {
              const a = model.artifacts.find((x) => x.id === modal.id);
              if (!a) return <p>This capture was removed.</p>;
              return (
                <>
                  <div className="notice">
                    Simulated {a.kind} ·{" "}
                    {a.kind === "recording"
                      ? "No playable video was created."
                      : "Download or copy the labelled sample image."}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      if (
                        act(
                          () =>
                            model.editCapture(
                              a.id,
                              String(data.get("name")),
                              String(data.get("tags")),
                            ),
                          "Capture metadata updated.",
                        )
                      )
                        close();
                    }}
                  >
                    <Field label="Capture name">
                      <input name="name" defaultValue={a.name} required />
                    </Field>
                    <Field label="Tags, separated by commas">
                      <input name="tags" defaultValue={a.tags.join(", ")} />
                    </Field>
                    <div className="capture-detail">
                      <span>
                        {model.device(a.deviceId).name} · {a.origin} · {a.mode}
                      </span>
                      <span>
                        {new Date(a.createdAt).toLocaleString()}{" "}
                        {a.kind === "recording"
                          ? ` · ${duration(a.duration)}`
                          : ""}
                      </span>
                      <code>
                        {a.folder}/{a.name}
                      </code>
                      <small>
                        Session {a.sessionId} · source {a.sourceId || "None"}
                      </small>
                    </div>
                    <Button primary type="submit">
                      Save name & tags
                    </Button>
                  </form>
                  <div className="actions">
                    {a.kind === "screenshot" && (
                      <>
                        <Button
                          onClick={async () =>
                            download(
                              await sampleBlob(
                                model.device(a.deviceId),
                                a.mode,
                                a.log.at(-1),
                              ),
                              `sample-${a.name.replace(/\.[^.]+$/, "")}.png`,
                            )
                          }
                        >
                          <Download size={15} /> Download sample PNG
                        </Button>
                        <Button
                          onClick={() =>
                            void copyImage(a.deviceId, a.mode, a.log.at(-1))
                          }
                        >
                          <Copy size={15} /> Copy sample PNG
                        </Button>
                      </>
                    )}
                    <Button
                      onClick={() =>
                        download(
                          new Blob([JSON.stringify(a, null, 2)], {
                            type: "application/json",
                          }),
                          `${a.name}.metadata.json`,
                        )
                      }
                    >
                      Export metadata & log
                    </Button>
                  </div>
                  <p className="help">
                    {a.log.length} recorded input events. Folder is proposed
                    local output metadata, not a file written by this site.
                  </p>
                </>
              );
            })()}
          {modal.type === "remove" && (
            <>
              <p>
                Remove {captureSelected.length} selected entries from the demo
                library. Undo is available in the library until another removal
                or a reload. No Mac files are deleted.
              </p>
              <Button
                primary
                onClick={() => {
                  setRemoved(model.removeCaptures(captureSelected));
                  setCaptureSelected([]);
                  persist();
                  close();
                }}
              >
                Remove entries
              </Button>
            </>
          )}
          {modal.type === "reset" && (
            <>
              <p>
                Restore sample devices, sessions, captures and settings. This
                clears your browser's demo changes and saved views.
              </p>
              <Button primary onClick={reset}>
                Reset demo
              </Button>
            </>
          )}
          {modal.type === "clipboard" && (
            <>
              <p>
                This browser could not write an image to the clipboard. Download
                the labelled sample PNG and copy it from your image viewer.
              </p>
              <p className="help">
                The website has not executed a macOS CLI or written to your
                configured Mac folder.
              </p>
              <Button
                primary
                onClick={async () =>
                  download(
                    await sampleBlob(
                      model.device(modal.id!),
                      modal.mode || model.settings.captureMode,
                      modal.last,
                    ),
                    "device-deck-sample.png",
                  )
                }
              >
                <Download size={16} /> Download sample PNG
              </Button>
            </>
          )}
          {modal.type === "copy" && (
            <>
              <p>
                Clipboard access is unavailable. Select and copy this
                illustrative command.
              </p>
              <textarea
                readOnly
                aria-label="Command to copy"
                value={modal.id}
                onFocus={(e) => e.target.select()}
              />
            </>
          )}
        </Modal>
      )}
    </>
  );
}
function DeviceForm({
  device,
  sources,
  onSave,
}: {
  device?: Device;
  sources: DemoModel["inventory"]["sources"];
  onSave: (d: Device) => void;
}) {
  const [draft, setDraft] = useState<Device>(
    device
      ? { ...device }
      : {
          id: crypto.randomUUID(),
          name: "",
          model: "",
          platform: "Roku",
          kind: "physical",
          online: true,
          locked: false,
          visibility: "local",
          captureSourceId: "",
          input: true,
        },
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <p className="help">
        Configuration changes apply only to this simulated workspace.
      </p>
      <Field label="Friendly name">
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          required
          maxLength={64}
        />
      </Field>
      <div className="form-grid">
        <Field label="Platform">
          <select
            value={draft.platform}
            onChange={(e) =>
              setDraft({
                ...draft,
                platform: e.target.value as Device["platform"],
                input:
                  e.target.value === "Apple" && draft.kind === "physical"
                    ? false
                    : draft.input,
              })
            }
          >
            {["Roku", "Android", "Apple"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Device type">
          <select
            value={draft.kind}
            onChange={(e) =>
              setDraft({
                ...draft,
                kind: e.target.value as Device["kind"],
                input:
                  e.target.value === "physical" && draft.platform === "Apple"
                    ? false
                    : draft.input,
                captureSourceId:
                  draft.captureSourceId === "native"
                    ? ""
                    : draft.captureSourceId,
              })
            }
          >
            <option value="physical">Physical</option>
            <option value="virtual">Emulator / simulator</option>
          </select>
        </Field>
      </div>
      <Field label="Model / connection label">
        <input
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          placeholder="Roku Ultra · ECP"
        />
      </Field>
      <Field label="Capture input">
        <select
          value={draft.captureSourceId}
          onChange={(e) =>
            setDraft({ ...draft, captureSourceId: e.target.value })
          }
        >
          <option value="">None</option>
          {sources
            .filter((s) => s.kind !== "native" || draft.kind === "virtual")
            .map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
                {s.status === "missing" ? " · disconnected" : ""}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Visibility">
        <select
          value={draft.visibility}
          onChange={(e) =>
            setDraft({
              ...draft,
              visibility: e.target.value as Device["visibility"],
            })
          }
        >
          <option value="local">Local only</option>
          <option value="shared">Shared</option>
        </select>
      </Field>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.input}
          onChange={(e) => setDraft({ ...draft, input: e.target.checked })}
        />{" "}
        Simulated remote input capability
      </label>
      <p className="help">
        Physical Apple devices begin with discovery only. Enable a capability
        here only to explore the mockup.
      </p>
      <Button primary type="submit">
        Save device
      </Button>
    </form>
  );
}
function SettingsForm({
  settings,
  save,
  reset,
}: {
  settings: Settings;
  save: (s: Settings) => boolean;
  reset: () => void;
}) {
  const [draft, setDraft] = useState({ ...settings });
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(draft);
      }}
    >
      <section className="panel">
        <div className="section-heading">
          <h2>Capture files</h2>
          <Folder size={19} />
        </div>
        <p>
          Web, CLI and agent captures share one configurable Mac folder in the
          intended local app. The preview remembers this preference without
          accessing your filesystem.
        </p>
        <Field label="Screenshot & video folder">
          <input
            value={draft.folder}
            onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
            required
          />
        </Field>
        <Field label="File naming pattern">
          <input
            value={draft.naming}
            onChange={(e) => setDraft({ ...draft, naming: e.target.value })}
            required
          />
        </Field>
        <p className="help">
          Available tokens: {"{device}"}, {"{date}"}, {"{time}"}. Example:
          desk-roku-2026-09-11-142503.png
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.clipboard}
            onChange={(e) =>
              setDraft({ ...draft, clipboard: e.target.checked })
            }
          />{" "}
          Also copy a sample PNG when taking a screenshot
        </label>
        <Field label="Default capture output">
          <select
            value={draft.captureMode}
            onChange={(e) =>
              setDraft({
                ...draft,
                captureMode: e.target.value as Settings["captureMode"],
              })
            }
          >
            <option value="clean">Clean · no key overlay</option>
            <option value="annotated">Annotated · include key overlay</option>
          </select>
        </Field>
      </section>
      <section className="panel">
        <h2>Sessions & evidence</h2>
        <Field label="Default owner label">
          <input
            value={draft.owner}
            onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
            required
          />
        </Field>
        <p className="help">
          Human, agent or job labels help identify a reservation. They do not
          create accounts or authenticate clients.
        </p>
        <Field label="Default reservation length, minutes">
          <input
            type="number"
            min={1}
            max={240}
            value={draft.ttl}
            onChange={(e) =>
              setDraft({ ...draft, ttl: Number(e.target.value) })
            }
          />
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.overlay}
            onChange={(e) => setDraft({ ...draft, overlay: e.target.checked })}
          />{" "}
          Show keypress overlay in viewers
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.logging}
            onChange={(e) => setDraft({ ...draft, logging: e.target.checked })}
          />{" "}
          Log simulated input and recording offsets
        </label>
        <p className="help">
          Settings, inventory, saved filters and capture metadata persist in
          this browser. Reloading interrupts simulated recordings. No cloud
          sync.
        </p>
        <div className="actions">
          <Button primary type="submit">
            Save settings
          </Button>
          <Button type="button" onClick={reset}>
            Reset demo
          </Button>
        </div>
      </section>
    </form>
  );
}
function Connect({
  devices,
  copy,
}: {
  devices: Device[];
  copy: (s: string) => Promise<void>;
}) {
  const [tab, setTab] = useState("CLI");
  const [name, setName] = useState("roku-desk");
  const d = devices.find((d) => d.id === name) || devices[0];
  const examples: Record<string, string> = {
    CLI: `# Illustrative: connect by friendly name\n${cliCommand(d)}\n\n# Interactive terminal: picker, search and filters\ndevdeck remote\ndevdeck remote --platform Roku --state free\n\n# Scriptable: unique match required, never a prompt\ndevdeck remote --device '${d.name.replaceAll("'", "'\\''")}' --key Home --json\ndevdeck remote --platform Android --name 'Pixel*' --state free --key Right --json\n\n# Proposed macOS sample capture / clipboard flow\ndevdeck screenshot --device '${d.name.replaceAll("'", "'\\''")}' --clipboard --json`,
    MCP: `// Illustrative future tools\ndevices.list({ platform: "Roku", state: "free" })\nsessions.reserve({ deviceId: "${d.id}", owner: "Agent", reason: "Navigation check" })\nremote.key({ sessionId: "…", key: "Home" })\ncaptures.screenshot({ sessionId: "…" })\nsessions.release({ sessionId: "…" })`,
    API: `# Illustrative future operations\nPOST /v1/sessions\n{ "deviceId": "${d.id}", "owner": "You", "reason": "Review" }\n\nPOST /v1/sessions/:id/input\n{ "key": "Home" }\n\nPOST /v1/sessions/:id/captures\n{ "type": "screenshot", "mode": "clean" }`,
    JSON: JSON.stringify(
      {
        schemaVersion: 1,
        devices: [
          {
            id: d.id,
            name: d.name,
            platform: d.platform,
            captureSourceId: d.captureSourceId || null,
            visibility: d.visibility,
          },
        ],
        capture: {
          outputDirectory: "~/Movies/Device Deck",
          naming: "{device}-{date}-{time}",
        },
      },
      null,
      2,
    ),
  };
  return (
    <>
      <div className="notice">
        <Info size={17} /> Remote, reservation and capture commands below are
        illustrative. The current CLI only implements service status and empty
        inventory.
      </div>
      <div className="connect-grid">
        <section className="panel code-panel">
          <div className="code-tabs" role="tablist" aria-label="Client example">
            {["CLI", "MCP", "API", "JSON"].map((t) => (
              <button
                role="tab"
                aria-selected={tab === t}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <Field label="Example target">
            <select value={d.id} onChange={(e) => setName(e.target.value)}>
              {devices
                .filter((x) => x.input)
                .map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </Field>
          <pre>{examples[tab]}</pre>
          <Button onClick={() => void copy(examples[tab])}>
            <Copy size={15} /> Copy illustrative example
          </Button>
        </section>
        <div className="connect-notes">
          <section className="panel">
            <h2>Find → reserve → control → capture → release</h2>
            <p>
              Connect to any configured device with supported input capabilities
              by friendly name. Roku uses ECP, Android uses ADB, and simulators
              use their platform input adapter in the intended product.
            </p>
            <p>
              A physical Apple device being discoverable does not mean it
              supports remote input.
            </p>
            <h3>When no target is given</h3>
            <p>
              An interactive terminal opens a device list with name, Roku /
              Android / Apple and state filters. Scripts use selectors and JSON
              output.
            </p>
            <h3>Selection must be explicit</h3>
            <p>
              Zero matches returns <code>no-match</code>. Multiple matches
              return <code>ambiguous-match</code> with candidate IDs.
              Noninteractive calls never open a picker or silently choose a
              device.
            </p>
            <h3>Clipboard on the Mac</h3>
            <p>
              The proposed <code>--clipboard</code> flag copies the captured
              image using a native helper. This website only copies a labelled
              sample PNG through your browser.
            </p>
          </section>
          <section className="panel">
            <h2>Implemented today</h2>
            <pre>
              npm run service{"\n"}npm run cli -- status{"\n"}npm run cli --
              devices --json
            </pre>
            <p className="help">
              The local app has its own daemon, device inventory, reservations
              and capture files. CLI, TUI and MCP share that service. This
              public demo stays separate and uses sample data.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
