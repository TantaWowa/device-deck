import { useEffect, useState } from "react";
import {
  Monitor,
  Smartphone,
  Layers,
  Camera,
  Video,
  Circle,
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  Play,
  Square,
  Cable,
  Terminal,
  RefreshCw,
  X,
  Check,
  LockKeyhole,
  ExternalLink,
  Command,
  Copy,
  Download,
  Search,
} from "lucide-react";
import { Brand } from "../../../packages/ui/src/index";
import { DemoModel } from "./demo/model";
const landscape = "/assets/fjord-preview.webp";
const labels = {
  roku: "Roku",
  "android-tv": "Android TV",
  "android-emulator": "Android",
  "apple-simulator": "Apple",
};
export function Dashboard() {
  const [model, setModel] = useState(() => new DemoModel());
  const [, render] = useState(0);
  const [selected, setSelected] = useState("roku-desk");
  const [page, setPage] = useState("devices");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [focus, setFocus] = useState(0);
  const [modal, setModal] = useState<"reserve" | "artifact" | null>(null);
  const [reason, setReason] = useState("Explore the browse screen");
  const [activeArtifact, setActiveArtifact] = useState<string | null>(null);
  const [codeTab, setCodeTab] = useState("CLI");
  const update = () => render((n) => n + 1);
  const notify = (s: string) => {
    setToast(s);
    update();
  };
  useEffect(() => {
    const id = setInterval(() => {
      model.expire();
      update();
    }, 1000);
    return () => clearInterval(id);
  }, [model]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  const device = model.inventory.devices.find((d) => d.id === selected)!;
  const lease = model.inventory.leases.find((l) => l.deviceId === selected);
  const owned = lease?.owner === "You";
  const recording = model.recordings.has(selected);
  const source = model.inventory.sources.find(
    (s) => s.id === device.captureSourceId,
  );
  const ttl = lease
    ? Math.max(0, Math.ceil((lease.expiresAt - Date.now()) / 60000))
    : 0;
  const act = (fn: () => void) => {
    try {
      fn();
      update();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const remote = (key: string) =>
    act(() => {
      model.requireOwner(selected);
      if (key === "Right" || key === "Down") setFocus((n) => (n + 1) % 3);
      if (key === "Left" || key === "Up") setFocus((n) => (n + 2) % 3);
      if (key === "Home" || key === "Back") setFocus(0);
      notify(`Simulated input · ${key}`);
    });
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        modal ||
        page !== "devices" ||
        !owned ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLButtonElement
      )
        return;
      const key = (
        {
          ArrowUp: "Up",
          ArrowDown: "Down",
          ArrowLeft: "Left",
          ArrowRight: "Right",
        } as Record<string, string>
      )[e.key];
      if (key) {
        e.preventDefault();
        remote(key);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [owned, selected, modal, page]);
  const devices = model.inventory.devices.filter(
    (d) =>
      (filter === "all" || d.kind === filter) &&
      (d.name + " " + d.model).toLowerCase().includes(search.toLowerCase()),
  );
  const snippets: Record<string, string> = {
    CLI: 'devdeck devices --json\n\n# Planned session command\ndevdeck reserve roku-desk \\\n  --reason "Check browse screen" \\\n  --ttl 900',
    MCP: '// Implemented scaffold tools\ndevices_list()\nservice_health()\n\n// Session tools are planned\nsession_reserve({\n  deviceId: "roku-desk",\n  reason: "Check browse screen"\n})',
    API: 'GET /v1/inventory\nGET /v1/health\n\n// Planned authenticated operation\nPOST /v1/sessions\n{ "deviceId": "roku-desk",\n  "reason": "Check browse screen" }',
    JSON: '{\n  "schemaVersion": 1,\n  "devices": [{\n    "id": "roku-desk",\n    "name": "Desk Roku",\n    "captureSourceId": "hdmi-a"\n  }]\n}',
  };
  return (
    <div className="dashboard">
      <div className="demo-banner">
        <span>
          <span className="demo-pill">PRODUCT PREVIEW</span> Sample devices. All
          device interactions are simulated.
        </span>
        <a href="/">
          About Device Deck <ArrowRight size={14} />
        </a>
      </div>
      <div className="app-layout">
        <aside className="sidebar">
          <a className="app-brand" href="/">
            <Brand />
          </a>
          <div className="host-label">
            <span className="online-dot" /> Local workspace{" "}
            <span className="small">DEMO</span>
          </div>
          <nav>
            {[
              ["devices", "Devices", Monitor],
              ["captures", "Captures", Camera],
              ["sources", "Capture sources", Cable],
              ["connect", "Connect an agent", Terminal],
            ].map(([key, label, Icon]) => (
              <button
                key={String(key)}
                className={page === key ? "nav-item active" : "nav-item"}
                onClick={() => setPage(String(key))}
              >
                <Icon size={18} />
                {String(label)}
                {key === "devices" && <span className="nav-count">4</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-note">
              <LockKeyhole size={18} />
              <div>
                Made for your Mac<small>One host. Your hardware.</small>
              </div>
            </div>
            <button
              className="reset"
              onClick={() => {
                setModel(new DemoModel());
                setSelected("roku-desk");
                setPage("devices");
                setFocus(0);
                notify("Demo reset to sample state");
              }}
            >
              <RefreshCw size={14} /> Reset demo
            </button>
            <a href="/#status">
              Development status <ExternalLink size={13} />
            </a>
          </div>
        </aside>
        <main className="app-main">
          <header className="app-header">
            <div>
              <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
              <h1>
                {page === "devices"
                  ? "Devices"
                  : page === "captures"
                    ? "Captures"
                    : page === "sources"
                      ? "Capture sources"
                      : "Connect an agent"}
              </h1>
            </div>
            <span className="host-chip">
              <Monitor size={15} /> Demo Mac <span className="online-dot" />
            </span>
          </header>
          {page === "devices" && (
            <>
              <div className="inventory-toolbar">
                <div className="segmented">
                  {["all", "physical", "virtual"].map((f) => (
                    <button
                      className={filter === f ? "selected" : ""}
                      key={f}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all"
                        ? "All devices"
                        : f === "physical"
                          ? "Physical"
                          : "Virtual"}{" "}
                      <span>{f === "all" ? 4 : 2}</span>
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label="Find a device"
                    placeholder="Find a device"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="device-grid">
                {devices.map((d) => {
                  const l = model.inventory.leases.find(
                    (l) => l.deviceId === d.id,
                  );
                  return (
                    <button
                      key={d.id}
                      className={`device-card ${selected === d.id ? "selected" : ""}`}
                      onClick={() => {
                        setSelected(d.id);
                        setFocus(0);
                      }}
                    >
                      <div className="device-card-top">
                        <span className={`device-symbol ${d.platform}`}>
                          {d.kind === "physical" ? (
                            <Monitor size={23} />
                          ) : d.platform === "android-emulator" ? (
                            <Smartphone size={23} />
                          ) : (
                            <Layers size={23} />
                          )}
                        </span>
                        <span className="device-kind">{d.kind}</span>
                      </div>
                      <strong>{d.name}</strong>
                      <span className="device-model">{d.model}</span>
                      <div className="device-state">
                        <span className={l ? "state-dot busy" : "state-dot"} />
                        {l ? l.owner : "Available"}
                        {selected === d.id && <Check size={14} />}
                      </div>
                    </button>
                  );
                })}
                {!devices.length && (
                  <p className="empty">No sample devices match your search.</p>
                )}
              </div>
              <section className="session">
                <div className="session-heading">
                  <div>
                    <span className="online-dot" />
                    <h2>{device.name}</h2>
                    <span className="platform-label">
                      {labels[device.platform]}
                    </span>
                  </div>
                  <span className="source-label">
                    <Cable size={14} />
                    {source?.name || "No source paired"}
                  </span>
                </div>
                <div className="session-body">
                  <div className="preview-column">
                    <div className="screen-top">
                      <span>
                        SCREEN PREVIEW <span className="small">SIMULATED</span>
                      </span>
                      <span>
                        {recording ? (
                          <>
                            <i className="record-dot" /> REC
                          </>
                        ) : (
                          "1920 × 1080"
                        )}{" "}
                        <span className="screen-scale">16:9</span>
                      </span>
                    </div>
                    <div
                      className={`tv-preview ${!source ? "unpaired" : ""}`}
                      style={{ backgroundImage: `url(${landscape})` }}
                    >
                      {!source && (
                        <div className="unpaired-message">
                          Pair a capture source to see this device.
                        </div>
                      )}
                      <div className="tv-nav">
                        <strong>
                          FIELD<span>NOTES</span>
                        </strong>
                        <span>Discover</span>
                        <span>My list</span>
                        <Search size={14} />
                      </div>
                      <div className="tv-copy">
                        <span>THE WORLD, A LITTLE CLOSER</span>
                        <h3>
                          {
                            [
                              "North of ordinary",
                              "The quiet coast",
                              "Into the blue",
                            ][focus]
                          }
                        </h3>
                        <p>
                          {
                            [
                              "Follow the water. Find a different pace.",
                              "A place to slow down and look around.",
                              "An escape beyond the familiar.",
                            ][focus]
                          }
                        </p>
                        <span className="tv-play">
                          <Play size={12} fill="currentColor" /> Watch film
                        </span>
                      </div>
                      <div className="tv-cards">
                        {[
                          "North of ordinary",
                          "The quiet coast",
                          "Into the blue",
                        ].map((title, i) => (
                          <div
                            className={focus === i ? "focused" : ""}
                            key={title}
                          >
                            <span>0{i + 1}</span>
                            {title}
                          </div>
                        ))}
                      </div>
                      <span className="fictional-label">
                        Fictional sample app · generated imagery
                      </span>
                    </div>
                    <div className="capture-toolbar">
                      <button
                        className="button light"
                        disabled={!owned || !source}
                        onClick={() =>
                          act(() => {
                            model.capture(selected);
                            notify("Simulated screenshot added to Captures");
                          })
                        }
                      >
                        <Camera size={16} /> Screenshot
                      </button>
                      <button
                        className={`button ${recording ? "recording" : ""}`}
                        disabled={!owned || !source}
                        onClick={() =>
                          act(() => {
                            model.toggleRecording(selected);
                            notify(
                              recording
                                ? "Simulated recording saved to Captures"
                                : "Simulated recording started",
                            );
                          })
                        }
                      >
                        {recording ? (
                          <Square size={13} fill="currentColor" />
                        ) : (
                          <Circle size={14} />
                        )}{" "}
                        {recording ? "Stop recording" : "Record video"}
                      </button>
                      <span className="keyboard-hint">
                        {owned
                          ? "Arrow keys to navigate"
                          : "Reserve to control"}
                      </span>
                    </div>
                  </div>
                  <aside className="remote-panel">
                    <div className="remote-title">
                      <h3>Remote</h3>
                      <span className="small">
                        {owned ? "CONNECTED · DEMO" : "READ ONLY"}
                      </span>
                    </div>
                    <div className="remote-tools">
                      <button
                        aria-label="Back"
                        disabled={!owned}
                        onClick={() => remote("Back")}
                      >
                        <ArrowLeft size={18} />
                      </button>
                      <button
                        aria-label="Home"
                        disabled={!owned}
                        onClick={() => remote("Home")}
                      >
                        <Home size={17} />
                      </button>
                    </div>
                    <div className="dpad">
                      <button
                        className="up"
                        aria-label="Up"
                        disabled={!owned}
                        onClick={() => remote("Up")}
                      >
                        <ChevronUp />
                      </button>
                      <button
                        className="left"
                        aria-label="Left"
                        disabled={!owned}
                        onClick={() => remote("Left")}
                      >
                        <ChevronLeft />
                      </button>
                      <button
                        className="ok"
                        disabled={!owned}
                        onClick={() => remote("Select")}
                      >
                        OK
                      </button>
                      <button
                        className="right"
                        aria-label="Right"
                        disabled={!owned}
                        onClick={() => remote("Right")}
                      >
                        <ChevronRight />
                      </button>
                      <button
                        className="down"
                        aria-label="Down"
                        disabled={!owned}
                        onClick={() => remote("Down")}
                      >
                        <ChevronDown />
                      </button>
                    </div>
                    <div className="lease-panel">
                      <div className="lease-label">
                        <LockKeyhole size={13} />{" "}
                        {lease ? "RESERVED" : "AVAILABLE"}
                      </div>
                      <strong>{lease?.owner || "Ready for a session"}</strong>
                      <p>
                        {lease?.reason ||
                          "Give your work an exclusive place to run."}
                      </p>
                      {lease && (
                        <span className="lease-expiry">
                          {ttl} min remaining
                        </span>
                      )}
                      {owned ? (
                        <div className="lease-actions">
                          <button
                            onClick={() =>
                              act(() => {
                                model.renew(selected);
                                notify("Demo session renewed for 15 minutes");
                              })
                            }
                          >
                            Renew
                          </button>
                          <button
                            onClick={() =>
                              act(() => {
                                model.release(selected);
                                notify(
                                  "Demo session released. Capture cleanup completed.",
                                );
                              })
                            }
                          >
                            Release
                          </button>
                        </div>
                      ) : (
                        <button
                          className="button lime"
                          disabled={!!lease}
                          onClick={() => setModal("reserve")}
                        >
                          {lease ? "In use by an agent" : "Reserve device"}
                        </button>
                      )}
                    </div>
                  </aside>
                </div>
                <div className="session-footer">
                  <span>
                    <span className="online-dot" /> {source?.name}{" "}
                    <span className="muted">· Pairing remembered</span>
                  </span>
                  <span>
                    Preview · Input · Screenshot · Recording{" "}
                    <span className="muted">/ planned adapter</span>
                  </span>
                </div>
              </section>
              <section className="recent">
                <div className="section-line">
                  <h3>
                    Session captures{" "}
                    <span>
                      {
                        model.artifacts.filter((a) => a.deviceId === selected)
                          .length
                      }
                    </span>
                  </h3>
                  <button onClick={() => setPage("captures")}>
                    View all captures <ArrowRight size={14} />
                  </button>
                </div>
                {model.artifacts.filter((a) => a.deviceId === selected)
                  .length ? (
                  <div className="artifact-list">
                    {model.artifacts
                      .filter((a) => a.deviceId === selected)
                      .slice(0, 3)
                      .map((a) => (
                        <button
                          key={a.id}
                          onClick={() => {
                            setActiveArtifact(a.id);
                            setModal("artifact");
                          }}
                        >
                          {a.kind === "screenshot" ? (
                            <Camera size={16} />
                          ) : (
                            <Video size={16} />
                          )}{" "}
                          {a.name}
                          <span>Simulated</span>
                          <ExternalLink size={14} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="capture-empty">
                    <Camera size={18} />
                    <span>
                      Take a screenshot or record a clip. Your session evidence
                      appears here.
                    </span>
                    <span className="small">DEMO ARTIFACTS ONLY</span>
                  </div>
                )}
              </section>
            </>
          )}
          {page === "captures" && (
            <>
              <p className="page-intro">
                Evidence from your demo sessions. These entries are simulated;
                no hardware screenshots or video files are produced.
              </p>
              {model.artifacts.length ? (
                <div className="capture-grid">
                  {model.artifacts.map((a) => (
                    <button
                      className="capture-card"
                      key={a.id}
                      onClick={() => {
                        setActiveArtifact(a.id);
                        setModal("artifact");
                      }}
                    >
                      <img src={landscape} alt="Fictional sample landscape" />
                      {a.kind === "recording" && (
                        <Play className="play-overlay" />
                      )}
                      <strong>{a.name}</strong>
                      <span>{a.kind} · Simulated sample</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="large-empty">
                  <Camera size={36} />
                  <h2>No captures yet</h2>
                  <p>
                    Open a device session and try Screenshot or Record video.
                  </p>
                  <button
                    className="button lime"
                    onClick={() => setPage("devices")}
                  >
                    Go to devices <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {page === "sources" && (
            <>
              <p className="page-intro">
                A capture card is a video source, not a device identity. Pair it
                once with the device connected to its HDMI input. These are
                sample mappings.
              </p>
              <div className="source-list">
                {model.inventory.sources.map((s) => (
                  <div className="source-row" key={s.id}>
                    <span className="source-icon">
                      <Cable size={24} />
                    </span>
                    <div>
                      <h3>{s.name}</h3>
                      <span>
                        {s.kind === "usb-video"
                          ? "USB video · explicit pairing"
                          : "Native screen · virtual device"}
                      </span>
                    </div>
                    <ArrowRight size={18} />
                    <label>
                      Paired device
                      <select
                        aria-label={`Device paired to ${s.name}`}
                        value={
                          model.inventory.devices.find(
                            (d) => d.captureSourceId === s.id,
                          )?.id || ""
                        }
                        onChange={(e) => {
                          const target = e.target.value;
                          const affected = model.inventory.devices.filter(
                            (d) =>
                              d.captureSourceId === s.id || d.id === target,
                          );
                          if (
                            affected.some((d) =>
                              model.inventory.leases.some(
                                (l) => l.deviceId === d.id,
                              ),
                            )
                          ) {
                            notify(
                              "Release affected device sessions before changing a pairing.",
                            );
                            return;
                          }
                          model.inventory.devices.forEach((d) => {
                            if (d.captureSourceId === s.id)
                              d.captureSourceId = null;
                            if (d.id === target) d.captureSourceId = s.id;
                          });
                          notify("Demo pairing updated for this tab.");
                        }}
                      >
                        <option value="">Unpaired</option>
                        {model.inventory.devices
                          .filter((d) =>
                            s.kind === "usb-video"
                              ? d.kind === "physical"
                              : d.kind === "virtual",
                          )
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <span className="source-connected">
                      <span className="online-dot" /> Connected
                    </span>
                  </div>
                ))}
              </div>
              <div className="info-note">
                In the intended local app, names and source pairings live in an
                editable JSON file. This preview keeps changes in memory until
                you reload or reset.
              </div>
            </>
          )}
          {page === "connect" && (
            <>
              <p className="page-intro">
                One background service is the intended authority for every
                client. The local scaffold exposes health and inventory through
                HTTP, CLI, and MCP. Session operations below are proposed
                contracts.
              </p>
              <div className="connect-layout">
                <div className="code-panel">
                  <div className="code-tabs">
                    {Object.keys(snippets).map((k) => (
                      <button
                        className={codeTab === k ? "active" : ""}
                        key={k}
                        onClick={() => setCodeTab(k)}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                  <pre>{snippets[codeTab]}</pre>
                  <button
                    className="copy-code"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(snippets[codeTab]);
                        notify("Example copied");
                      } catch {
                        notify(
                          "Clipboard unavailable. Select and copy the example.",
                        );
                      }
                    }}
                  >
                    <Copy size={14} /> Copy example
                  </button>
                </div>
                <div className="agent-note">
                  <Command size={28} />
                  <h2>
                    Same devices.
                    <br />
                    Same session rules.
                  </h2>
                  <p>
                    A person uses the dashboard. An agent uses MCP or the CLI.
                    Both must hold the current lease before sending input or
                    starting capture.
                  </p>
                  <span className="small">
                    PLANNED BEHAVIOUR · NOT HARDWARE VALIDATED
                  </span>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setModal(null);
              if (e.key === "Tab") {
                const els = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button,input,a[href]",
                  ),
                ).filter((el) => !(el as HTMLButtonElement).disabled);
                const first = els[0],
                  last = els.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <button
              className="modal-close"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            {modal === "reserve" ? (
              <>
                <LockKeyhole size={28} />
                <h2 id="modal-title">Reserve {device.name}</h2>
                <p>This simulated session belongs to you for 15 minutes.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => {
                      model.reserve(selected, reason);
                      setModal(null);
                      notify("Device reserved for your demo session");
                    });
                  }}
                >
                  <label>
                    What are you working on?
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      required
                      maxLength={120}
                    />
                  </label>
                  <button className="button lime" type="submit">
                    Reserve for 15 minutes <ArrowRight size={16} />
                  </button>
                </form>
              </>
            ) : (
              <>
                <h2 id="modal-title">Sample capture</h2>
                <p>
                  {model.artifacts.find((a) => a.id === activeArtifact)?.name}
                </p>
                <img
                  src={landscape}
                  alt="Generated landscape used in the fictional sample app"
                />
                <p>
                  This is a simulated artifact entry. Hardware capture is not
                  implemented.{" "}
                  {model.artifacts.find((a) => a.id === activeArtifact)
                    ?.kind === "recording"
                    ? "No playable recording was created."
                    : "The image below is the original sample artwork, not a device screenshot."}
                </p>
                <a
                  autoFocus
                  className="button light"
                  href={landscape}
                  download="device-deck-sample-artwork.webp"
                >
                  <Download size={16} /> Download sample artwork
                </a>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
