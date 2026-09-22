import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, ListFilter, LoaderCircle, Maximize, Monitor, Play, Search, X } from "lucide-react";
import { canLaunchSimulator, supportsSimulatorLifecycle, type Source, type Device, type Snapshot } from "../../../../packages/core/src/local/types";
import { CapturePreview } from "./CapturePreview";
import { deviceIsBooting } from "../../../../packages/core/src/device-table";
import { deviceFormFactor } from "../../../../packages/core/src/device-form-factor";
import { DeviceTypeFilter } from "./DeviceTypeFilter";
import "./feed-workspace.css";

export function FeedViewer({ sources, devices, renderActions, renderPreview, launchSimulator, request }: {
  sources: Source[];
  devices: Device[];
  renderActions: (source: Source) => React.ReactNode;
  renderPreview?: (source: Source) => React.ReactNode;
  launchSimulator: (device: Device) => Promise<Snapshot>;
  request?: { deviceIds: string[] } | null;
}) {
  const query = new URLSearchParams(location.search);
  const cards = sources.filter((source) => source.kind === "usb" || Boolean(source.deviceId));
  const [selected, setSelected] = useState<string[]>(() => {
    const ids = query.get("sources");
    return ids !== null ? ids.split(",").filter(Boolean) : cards.filter((source) => source.status === "connected").map((source) => source.id);
  });
  const selectInitialFeeds = useRef(!query.has("sources"));
  useEffect(() => {
    if (!selectInitialFeeds.current) return;
    if (selected.length) { selectInitialFeeds.current = false; return; }
    const connected = cards.filter((source) => source.status === "connected").map((source) => source.id);
    if (connected.length) { selectInitialFeeds.current = false; setSelected(connected); }
  }, [cards, selected.length]);
  const [layout, setLayout] = useState(query.get("layout") === "single" ? "single" : "grid");
  const [active, setActive] = useState(query.get("active") || selected[0] || "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerHeight, setPickerHeight] = useState<number>();
  const [search, setSearch] = useState("");
  const [inputKind, setInputKind] = useState<"all" | "simulators" | "capture-cards">("all");
  const [formFactor, setFormFactor] = useState(() => ["tv", "phone", "other"].includes(query.get("deviceType") || "") ? query.get("deviceType")! : "");
  const [launching, setLaunching] = useState<string | null>(null);
  const [awaitingFeed, setAwaitingFeed] = useState<{ id: string; name: string } | null>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const handledRequest = useRef<typeof request>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const deviceFor = (source: Source) => devices.find((device) => device.id === source.deviceId || device.captureSourceId === source.id);
  const matchesType = (device?: Device) => !formFactor || deviceFormFactor(device) === formFactor;
  const feeds = selected.map((id) => cards.find((source) => source.id === id)).filter((source): source is Source => Boolean(source && matchesType(deviceFor(source))));
  const index = Math.max(0, feeds.findIndex((source) => source.id === active));
  const current = feeds[index];
  const move = (delta: number) => { if (feeds.length) setActive(feeds[(index + delta + feeds.length) % feeds.length].id); };
  const reveal = (id: string) => {
    setSelected((ids) => ids.includes(id) ? ids : [...ids, id]);
    setActive(id); setLayout("single"); setPickerOpen(false);
  };
  useEffect(() => {
    if (!request || handledRequest.current === request) return;
    handledRequest.current = request;
    setFormFactor("");
    const requestedSources = request.deviceIds.map((id) => cards.find((source) => source.kind === "native" && source.deviceId === id) || cards.find((source) => deviceFor(source)?.id === id)).filter((source): source is Source => Boolean(source));
    if (requestedSources.length) {
      setSelected((ids) => [...new Set([...ids, ...requestedSources.map((source) => source.id)])]);
      setActive(requestedSources[0].id); setLayout(requestedSources.length > 1 ? "grid" : "single"); setPickerOpen(false);
    } else {
      const target = devices.find((device) => device.id === request.deviceIds[0]);
      setSearch(target?.name || ""); setInputKind(target && supportsSimulatorLifecycle(target) ? "simulators" : "all"); setPickerOpen(true);
      setNotice(target ? `Choose or launch the screen feed for ${target.name}. Touch starts disabled.` : "Choose a screen feed to continue.");
    }
  }, [request, cards, devices]);
  const launch = async (device: Device) => {
    if (launching) return;
    setLaunching(device.id); setError(""); setNotice(`Booting ${device.name}. Waiting for its screen…`);
    try {
      await launchSimulator(device);
      if (!mounted.current) return;
      // Ordinary inventory returns immediately while readiness is refreshed.
      // A checking/stale snapshot after a successful launch is not a failure.
      setAwaitingFeed({ id: device.id, name: device.name });
      setNotice(`${device.name} started. Waiting for its updated screen status…`);
    } catch (failure) { if (mounted.current) { setError((failure as Error).message); setNotice(""); setLaunching(null); } }
  };
  useEffect(() => {
    if (!awaitingFeed) return;
    const started = devices.find((entry) => entry.id === awaitingFeed.id);
    const source = sources.find((entry) => entry.kind === "native" && entry.deviceId === awaitingFeed.id) || sources.find((entry) => entry.id === started?.captureSourceId);
    if (!started?.online || deviceIsBooting(started) || started.observation?.stale || source?.status !== "connected" || source.observation?.stale) return;
    setFormFactor((current) => !current || deviceFormFactor(started) === current ? current : "");
    reveal(source.id);
    setNotice(`${awaitingFeed.name} started. Connecting its feed; use the feed's controls once video arrives.`);
    setAwaitingFeed(null); setLaunching(null);
  }, [awaitingFeed, devices, sources]);
  useEffect(() => {
    if (!awaitingFeed) return;
    const timer = setTimeout(() => {
      setError(`${awaitingFeed.name} started, but its screen status has not become ready. Check the device status and choose its feed when it is available.`);
      setAwaitingFeed(null); setLaunching(null); setNotice("");
    }, 60_000);
    return () => clearTimeout(timer);
  }, [awaitingFeed]);
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await viewer.current?.requestFullscreen(); }
    catch (failure) { setError((failure as Error).message); }
  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.set("view", "feeds"); params.set("layout", layout); params.set("sources", selected.join(","));
    if (current) params.set("active", current.id); else params.delete("active");
    if (formFactor) params.set("deviceType", formFactor); else params.delete("deviceType");
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }, [layout, selected.join(","), current?.id, formFactor]);
  useEffect(() => {
    if (!pickerOpen) return;
    searchInput.current?.focus();
    const fit = () => setPickerHeight(Math.max(220, window.innerHeight - (picker.current?.getBoundingClientRect().bottom || 0) - 24));
    fit();
    window.addEventListener("resize", fit);
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPickerOpen(false); pickerButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", fit); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [pickerOpen]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || pickerOpen || document.querySelector("dialog[open]") || (event.target as HTMLElement).closest("input,textarea,select,[contenteditable],.floating-remote,[role=dialog]")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
      else if (event.key.toLowerCase() === "g") { event.preventDefault(); setLayout((value) => value === "grid" ? "single" : "grid"); }
      else if (event.key.toLowerCase() === "f") { event.preventDefault(); void fullscreen(); }
      else if (/^[1-9]$/.test(event.key) && feeds[Number(event.key) - 1]) { event.preventDefault(); setActive(feeds[Number(event.key) - 1].id); setLayout("single"); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  });
  const rows: { key: string; source?: Source; device?: Device; name: string }[] = [
    ...cards.map((source) => ({ key: source.id, source, device: deviceFor(source), name: source.name })),
    ...devices.filter((device) => supportsSimulatorLifecycle(device) && !cards.some((source) => deviceFor(source)?.id === device.id))
      .map((device) => ({ key: `device:${device.id}`, source: undefined, device, name: device.name })),
  ].filter((row) => matchesType(row.device) && (inputKind === "all" || (inputKind === "capture-cards" ? row.source?.kind === "usb" : Boolean(row.device && supportsSimulatorLifecycle(row.device)))) && `${row.name} ${row.device?.name || ""} ${row.device?.platform || ""}`.toLowerCase().includes(search.toLowerCase().trim()));
  const visible = layout === "grid" ? feeds : current ? [current] : [];
  return <div ref={viewer} className="feed-viewer">
    <div className="live-heading"><div><span className="eyebrow">CAPTURE WORKSPACE</span><h1>Live feeds</h1><p>Choose a feed or start a simulator, then control its screen.</p></div><div className="live-actions">
      <button aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><Columns2 size={16} />Split screen</button>
      <button aria-pressed={layout === "single"} onClick={() => setLayout("single")}><Monitor size={16} />Single feed</button>
      <button onClick={() => void fullscreen()}><Maximize size={16} />Fullscreen</button>
    </div></div>
    <div className="feed-toolbar">
      <DeviceTypeFilter value={formFactor} onChange={setFormFactor} />
      <div ref={picker} className="feed-selector">
        <button ref={pickerButton} className="feed-selector-trigger" aria-expanded={pickerOpen} aria-controls="local-feed-selector" onClick={() => { setInputKind("all"); setPickerOpen((open) => !open); }}><ListFilter size={17} />Choose feeds<span>{feeds.length} selected</span><ChevronDown size={15} /></button>
        <button className="feed-launch-trigger" onClick={() => { setSearch(""); setInputKind("simulators"); setPickerOpen(true); }}><Play size={15} />Start simulator</button>
        {pickerOpen && <div id="local-feed-selector" className="feed-selector-panel" style={{ maxHeight: pickerHeight }} role="dialog" aria-label="Choose feeds" aria-busy={Boolean(launching)}>
          <header><strong>{inputKind === "simulators" ? "Simulators & emulators" : "Available feeds"}</strong><button aria-label="Close feed selector" onClick={() => setPickerOpen(false)}><X size={17} /></button></header>
          <div className="feed-selector-search"><Search size={16} /><input ref={searchInput} aria-label="Search feeds" placeholder="Search devices and inputs" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="feed-selector-filters" role="group" aria-label="Input type"><button aria-pressed={inputKind === "all"} onClick={() => setInputKind("all")}>All inputs</button><button aria-pressed={inputKind === "simulators"} onClick={() => setInputKind("simulators")}>Simulators</button><button aria-pressed={inputKind === "capture-cards"} onClick={() => setInputKind("capture-cards")}>Capture cards</button></div>
          {error && <p className="feed-selector-error" role="alert">{error}</p>}
          <div className="feed-selector-list">{rows.map(({ key, source, device, name }) => {
            const simulator = device && supportsSimulatorLifecycle(device);
            const booting = launching === device?.id || Boolean(device && deviceIsBooting(device));
            const pending = booting || device?.simulatorState === "stopping";
            const checking = source?.status === "unknown" || device?.observation?.observedAt === null;
            const stopped = simulator && !device.online && !checking;
            return <div className="feed-selector-row" key={key} data-feed-option={key}>
              {source ? <input type="checkbox" aria-label={`Show ${name}`} checked={selected.includes(source.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, source.id] : ids.filter((id) => id !== source.id))} /> : <Monitor size={17} />}
              <div><strong>{name}</strong><small>{device?.name !== name && device?.name ? `${device.name} · ` : ""}{checking ? "Checking availability…" : pending ? device?.simulatorState === "stopping" ? "Stopping…" : "Booting…" : stopped ? `${device.platform} · Stopped` : source?.status === "connected" ? "Available" : "Input unavailable"}</small>{device?.simulatorState === "unavailable" && <small>{device.healthDetail}</small>}</div>
              {stopped || (simulator && !source) ? <button type="button" aria-label={`Launch ${device.name} and show feed`} disabled={Boolean(launching) || pending || device.locked || device.simulatorState === "unavailable" || !canLaunchSimulator(device)} onClick={() => void launch(device)}>{pending ? <LoaderCircle className="simulator-spinner" size={14} /> : <Play size={14} />}{pending ? device.simulatorState === "stopping" ? "Stopping…" : "Booting…" : "Launch & show feed"}</button> : source && <button type="button" aria-label={`Open ${name} feed`} onClick={() => reveal(source.id)}>{selected.includes(source.id) && <Check size={14} />}Show feed</button>}
            </div>;
          })}{!rows.length && <p className="feed-selector-empty">{search || formFactor ? "No feeds match your filters." : inputKind === "simulators" ? "No simulators configured. Add one from Devices." : inputKind === "capture-cards" ? "No capture cards available. Discover cards from Capture Cards." : "No capture inputs configured yet."}</p>}</div>
          <footer><span>{feeds.length} shown · {selected.length} selected</span><button onClick={() => setSelected((ids) => [...new Set([...ids, ...rows.flatMap((row) => row.source?.status === "connected" ? [row.source.id] : [])])])}>Show available</button><button onClick={() => setSelected((ids) => ids.filter((id) => !rows.some((row) => row.source?.id === id)))}>Clear</button></footer>
        </div>}
      </div>
      <span className="feed-toolbar-summary">{cards.filter((source) => source.status === "connected" && launching !== deviceFor(source)?.id && !deviceIsBooting(deviceFor(source) || {})).length} available · {devices.filter((device) => supportsSimulatorLifecycle(device) && !device.online && launching !== device.id && !deviceIsBooting(device) && device.simulatorState !== "stopping").length} simulators stopped{devices.some((device) => deviceIsBooting(device) || launching === device.id) ? ` · ${devices.filter((device) => deviceIsBooting(device) || launching === device.id).length} booting` : ""}</span>
    </div>
    {launching && <p className="feed-launch-status" role="status"><LoaderCircle className="simulator-spinner" size={16} />{notice}</p>}
    {!launching && notice && <p className="feed-launch-status" role="status">{notice}<button aria-label="Dismiss feed notice" onClick={() => setNotice("")}><X size={14} /></button></p>}
    {error && !pickerOpen && <p className="feed-launch-error" role="alert">{error}</p>}
    {selected.some((id) => !cards.some((source) => source.id === id)) && <p role="status">Some selected feeds are no longer configured. Choose another input.</p>}
    <div className="feed-navigation"><button aria-label="Previous feed" disabled={feeds.length < 2} onClick={() => move(-1)}><ChevronLeft size={20} /></button><strong aria-live="polite">{current ? `${index + 1} / ${feeds.length} · ${current.name}` : "No feeds selected"}</strong><button aria-label="Next feed" disabled={feeds.length < 2} onClick={() => move(1)}><ChevronRight size={20} /></button><span>← → switch · 1–9 open feed · G grid · F fullscreen</span></div>
    <div className={`feed-grid ${layout}`} style={{ "--feed-rows": layout === "grid" ? Math.ceil(visible.length / 2) || 1 : 1, "--feed-count": visible.length || 1 } as React.CSSProperties}>
      {visible.map((source) => {
        const device = deviceFor(source);
        const booting = launching === device?.id || Boolean(device && deviceIsBooting(device));
        const stopping = device?.simulatorState === "stopping";
        return <section key={source.id} data-feed-source={source.id} className={`feed-tile ${current?.id === source.id ? "active" : ""}`}>
          <button className="feed-title" onClick={() => { setActive(source.id); setLayout("single"); }} title="Open this feed"><strong>{source.name}</strong><span className={booting ? "feed-booting-label" : ""}>{booting ? `${device?.name || source.name} · Booting…` : device?.name || (source.kind === "usb" ? "USB capture" : "Device screen")}</span></button>
          {source.status === "unknown" ? <div className="feed-offline" role="status"><LoaderCircle className="simulator-spinner" size={24} /><span>Checking capture input…</span></div> : booting || stopping || source.status === "missing" ? <div className={`feed-offline${booting ? " feed-booting" : ""}`} role="status">{booting && <LoaderCircle className="simulator-spinner" size={24} />}<span>{booting ? `${device?.name || source.name} is booting. Waiting for its screen…` : stopping ? `${device?.name} is stopping…` : device && supportsSimulatorLifecycle(device) && !device.online ? `${device.name} is stopped.` : "Input unavailable. Connect the device to resume."}</span>{device && canLaunchSimulator(device) && !device.online && !booting && !stopping && <button type="button" className="primary" disabled={Boolean(launching) || device.locked || device.simulatorState === "unavailable"} onClick={() => void launch(device)}><Play size={15} />Launch & show feed</button>}</div> : renderPreview ? renderPreview(source) : <CapturePreview name={source.name} endpoint={source.kind === "usb" ? `/v1/source-preview/${encodeURIComponent(source.id)}` : `/v1/preview/${encodeURIComponent(source.deviceId!)}`} />}
          {renderActions(source)}
        </section>;
      })}
    </div>
    {!visible.length && <div className="live-empty"><Monitor size={36} /><h2>{formFactor ? "No selected feeds match this device type" : "Choose a feed or start a simulator"}</h2><p>Use the selector above to show capture inputs and device screens.</p>{formFactor && <button onClick={() => setFormFactor("")}>Show all device types</button>}</div>}
  </div>;
}
