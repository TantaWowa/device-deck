import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, ChevronDown, Clipboard, ExternalLink, Film, Grid2X2, LoaderCircle, Monitor, Play, Radio, RefreshCw, Search, Square, Tv, X } from "lucide-react";
import { grantSchema, type MachineRecord } from "../../../packages/core/src/hub";
import type { Artifact, Device, Session, Snapshot } from "../../../packages/core/src/local/types";
import { createMachineTransport } from "../../../packages/machine-client/src";
import { canLaunchSimulator } from "../../../packages/core/src/local/types";
import { LivePreview } from "../../web/src/local/LivePreview";
import { RemoteControl } from "../../web/src/local/RemoteControl";
import { CaptureLibrary } from "../../web/src/local/CaptureLibrary";
import { CaptureToasts, copyImageToClipboard, useCaptureFeedback } from "../../web/src/local/capture-feedback";
import { connectionMessage, ControlGate, needsStandalone } from "./model";
import type { CloudClient } from "./cloud";
import "./capture-workspace.css";

type Transport = ReturnType<typeof createMachineTransport>;
export type Lease = { sessionId: string; leaseToken: string };
export type LeaseMemory = Map<string, Lease>;
const time = (value: string | number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function MachinePreview({ transport, route, label, lease, inputEnabled, active = true }: { transport: Transport; route: string; label: string; lease?: Lease | null; inputEnabled?: boolean; active?: boolean }) {
  const getSnapshot = useCallback((signal: AbortSignal) => transport.getBlob(route, signal), [transport, route]);
  const sourceId = route.startsWith("/v1/source-preview/") ? decodeURIComponent(route.slice("/v1/source-preview/".length)) : undefined;
  const deviceId = route.startsWith("/v1/preview/") ? decodeURIComponent(route.slice("/v1/preview/".length)) : undefined;
  return <LivePreview key={deviceId || sourceId} name={label} sourceId={sourceId} deviceId={deviceId} operation={transport.operation} getSnapshot={getSnapshot} controlLease={lease} inputEnabled={inputEnabled} active={active} />;
}

export function MachineWorkspace({ machine, cloud, owner, leases, onBack }: {
  machine: MachineRecord; cloud: CloudClient; owner: string; leases: LeaseMemory; onBack: () => void;
}) {
  const transport = useMemo(() => createMachineTransport({
    endpoint: machine.endpoint, expectedMachineId: machine.id, expectedPublicKey: machine.publicKey,
    getGrant: async () => grantSchema.parse(await cloud(`/machines/${encodeURIComponent(machine.id)}/grant`, { method: "POST", body: {} })),
  }), [machine.id, machine.endpoint, machine.publicKey.x, cloud]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [updatedAt, setUpdatedAt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"feeds" | "devices" | "captures">("feeds");
  const [remoteId, setRemoteId] = useState<string>();
  const [touchSessions, setTouchSessions] = useState<Record<string, string>>({});
  const [selectedFeeds, setSelectedFeeds] = useState<string[] | null>(null);
  const [feedPickerOpen, setFeedPickerOpen] = useState(false);
  const [feedPickerMode, setFeedPickerMode] = useState<"all" | "simulators">("all");
  const [feedSearch, setFeedSearch] = useState("");
  const [revealingDevice, setRevealingDevice] = useState<string>();
  const [launchingDevice, setLaunchingDevice] = useState<string>();
  const [sessionOwner, setSessionOwner] = useState(owner);
  const [capturePreviewId, setCapturePreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 640px)").matches);
  const lifecycle = useRef(new AbortController());
  const gate = useRef(new ControlGate());
  const alive = useRef(true);
  const refreshingRef = useRef(false);
  const remotePanel = useRef<HTMLElement>(null);
  const feedPicker = useRef<HTMLDivElement>(null);
  const standalone = needsStandalone(machine.endpoint, location.protocol);
  const captureFeedback = useCaptureFeedback(snapshot?.artifacts);
  const getCaptureBlob = useCallback((item: Artifact, variant: "file" | "clean" | "log" = "file", signal?: AbortSignal) =>
    transport.getBlob(`/v1/artifacts/${encodeURIComponent(item.id)}/${variant}`, signal), [transport]);
  const getCaptureThumbnail = useCallback((item: Artifact, signal?: AbortSignal) =>
    transport.getBlob(`/v1/artifacts/${encodeURIComponent(item.id)}/thumbnail`, signal), [transport]);
  useEffect(() => {
    const query = matchMedia("(max-width: 640px)");
    const changed = () => setMobile(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const refresh = async () => {
    if (standalone || refreshingRef.current || lifecycle.current.signal.aborted) return;
    refreshingRef.current = true; setRefreshing(true);
    try {
      const result = await transport.operation<Snapshot>("inventory", {}, AbortSignal.any([lifecycle.current.signal, AbortSignal.timeout(12_000)]));
      if (alive.current) {
        setSnapshot(result); setUpdatedAt(new Date().toISOString()); setError("");
        for (const device of result.devices) {
          const key = `${machine.id}:${device.id}`;
          const lease = leases.get(key);
          if (lease && !result.sessions.some((session) => session.id === lease.sessionId && session.state !== "closed" && session.expiresAt > Date.now())) leases.delete(key);
        }
      }
    } catch (failure) {
      gate.current.cancel();
      if (alive.current) { setBusy(false); setError(connectionMessage(failure)); }
    }
    finally { refreshingRef.current = false; if (alive.current) setRefreshing(false); }
  };
  useEffect(() => {
    alive.current = true;
    lifecycle.current = new AbortController();
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    const cancelControls = () => {
      gate.current.cancel();
      setBusy(false);
      setNotice("Controls paused. Tap again when you are ready to send a new command.");
    };
    const visibility = () => { if (document.hidden) cancelControls(); };
    window.addEventListener("offline", cancelControls);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false; lifecycle.current.abort(); gate.current.cancel(); transport.dispose(); clearInterval(timer);
      window.removeEventListener("offline", cancelControls); document.removeEventListener("visibilitychange", visibility);
    };
  }, [transport]);
  const selectRemote = (id?: string) => { gate.current.cancel(); setBusy(false); setNotice(""); setRemoteId(id); };
  useEffect(() => {
    if (!feedPickerOpen) return;
    const close = (event: PointerEvent) => { if (!feedPicker.current?.contains(event.target as Node)) setFeedPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFeedPickerOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    feedPicker.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [feedPickerOpen]);
  useEffect(() => {
    if (!remoteId) return;
    const previous = document.activeElement;
    remotePanel.current?.querySelector<HTMLButtonElement>('button[aria-label="Close remote"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); selectRemote(); }
      if (event.key !== "Tab") return;
      const buttons = [...(remotePanel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])].filter((item) => item.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [remoteId]);
  const device = snapshot?.devices.find((item) => item.id === remoteId);
  const activeSession = snapshot?.sessions.find((session) => session.deviceId === remoteId && session.state !== "closed" && session.expiresAt > Date.now());
  const leaseKey = device ? `${machine.id}:${device.id}` : "";
  const ownLease = leases.get(leaseKey);
  const occupied = activeSession && activeSession.id !== ownLease?.sessionId;
  const hasConnection = Boolean(device?.online && !device.locked && !error);
  const canControl = hasConnection && !occupied;
  const command = async (action: (signal: AbortSignal, current: () => boolean) => Promise<unknown>, timeoutMs = 10_000, successNotice: string | null = "Command sent.", rethrow = false) => {
    if (!navigator.onLine || document.hidden) { setNotice("Controls are paused. Reconnect and return to this page before sending a new command."); return false; }
    const result = await gate.current.run(async (signal, current) => {
      setBusy(true); setNotice("");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const result = await action(bounded, () => current() && !bounded.aborted);
        if (result !== false && current() && alive.current) { if (successNotice) setNotice(successNotice); void refresh(); }
        return result;
      } catch (failure) {
        if (current() && alive.current) setNotice(connectionMessage(failure));
        if (rethrow) throw failure;
        return false;
      } finally { if (current() && alive.current) setBusy(false); }
    });
    return result === undefined ? false : result;
  };
  const withDeviceLease = async (target: Device, signal: AbortSignal, current: () => boolean) => {
    const key = `${machine.id}:${target.id}`;
    let lease = leases.get(key);
    if (!lease) {
      const reserved = await transport.operation<{ session: Session; leaseToken: string }>("sessions.reserve", {
        selector: { device: target.id }, owner: sessionOwner, reason: "Device Deck web controls", ttlMinutes: 15,
      }, signal);
      if (!current()) throw new DOMException("Cancelled", "AbortError");
      lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
      leases.set(key, lease);
    }
    return lease;
  };
  const withLease = (signal: AbortSignal, current: () => boolean) => {
    if (!device) throw new Error("Select a device first.");
    return withDeviceLease(device, signal, current);
  };
  const remoteInput = (input: { key?: string; text?: string }) => command(async (signal, current) => {
    const lease = await withLease(signal, current);
    if (!current()) return false;
    return transport.operation("remote.input", { ...lease, ...input }, signal);
  });
  const capture = (operation: "captures.screenshot" | "recordings.start" | "recordings.stop") => command(async (signal, current) => {
    const lease = await withLease(signal, current);
    if (!current()) return false;
    const item = await transport.operation<Artifact | null>(operation, operation === "captures.screenshot" ? { ...lease, clipboard: false } : lease, signal);
    if (current()) {
      if (item && operation !== "recordings.start") captureFeedback.completed(item);
      setNotice(operation === "recordings.start" ? "Recording started. You can close this remote." : operation === "recordings.stop" ? item ? "Recording finished. See Captures for the saved file." : "No recording is active." : "Screenshot saved to Captures.");
    }
    return item;
  }, operation === "recordings.stop" ? 180_000 : 60_000, null);
  const screenshotToClipboard = () => {
    let currentRequest = () => alive.current;
    void copyImageToClipboard(async () => {
      const result = await command(async (signal, current) => {
        currentRequest = current;
        const lease = await withLease(signal, current);
        if (!current()) throw new DOMException("Cancelled", "AbortError");
        const item = await transport.operation<Artifact>("captures.screenshot", { ...lease, clipboard: false }, signal);
        if (current()) captureFeedback.completed(item);
        return getCaptureBlob(item, "file", signal);
      }, 60_000, null, true);
      if (!(result instanceof Blob)) throw new Error("Screenshot could not be copied. Check the capture result and try again.");
      return result;
    }).then(() => { if (alive.current && currentRequest()) setNotice("Screenshot copied to your clipboard and saved to Captures."); })
      .catch((failure) => { if (alive.current && currentRequest()) setNotice(connectionMessage(failure)); });
  };
  const takeover = () => command(async (signal, current) => {
    if (!device || !window.confirm(`Take over ${device.name} from ${activeSession?.owner}? Any active recording will be finalized.`)) return false;
    const result = await transport.operation<{ session: Session; leaseToken: string }>("sessions.takeover", { deviceId: device.id, reason: "Take over from Device Deck web remote", owner: sessionOwner, confirmed: true }, signal);
    if (current()) leases.set(leaseKey, { sessionId: result.session.id, leaseToken: result.leaseToken });
    return result;
  }, 180_000);
  const endSession = () => command(async (signal, current) => {
    if (!ownLease) return false;
    const result = await transport.operation("sessions.release", ownLease, signal);
    if (current()) { leases.delete(leaseKey); setTouchSessions((sessions) => { const next = { ...sessions }; delete next[device!.id]; return next; }); }
    return result;
  }, 180_000);
  const startFeedControl = (target: Device, takeOver = false) => command(async (signal, current) => {
    const session = snapshot?.sessions.find((s) => s.deviceId === target.id && s.state !== "closed" && s.expiresAt > Date.now());
    const own = leases.get(`${machine.id}:${target.id}`);
    if (!sessionOwner.trim()) throw new Error("Enter a session owner first.");
    let lease: Lease;
    if (session && session.id !== own?.sessionId) {
      if (!takeOver || !window.confirm(`Take over ${target.name} from ${session.owner}? Any active recording will be finalized.`)) return false;
      const reserved = await transport.operation<{ session: Session; leaseToken: string }>("sessions.takeover", { deviceId: target.id, owner: sessionOwner, reason: "Take over from Device Deck feed", confirmed: true }, signal);
      lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
      if (current()) leases.set(`${machine.id}:${target.id}`, lease);
    } else lease = await withDeviceLease(target, signal, current);
    if (!current()) return false;
    setTouchSessions((sessions) => ({ ...sessions, [target.id]: lease.sessionId }));
    return lease;
  }, takeOver ? 180_000 : 10_000);
  const endFeedControl = (target: Device) => command(async (signal, current) => {
    const key = `${machine.id}:${target.id}`, lease = leases.get(key);
    if (!lease) return false;
    const result = await transport.operation("sessions.release", lease, signal);
    if (current()) {
      leases.delete(key);
      setTouchSessions((sessions) => { const next = { ...sessions }; delete next[target.id]; return next; });
    }
    return result;
  }, 180_000);
  const launchFeed = (target: Device) => command(async (signal, current) => {
    setLaunchingDevice(target.id); setNotice(`Starting ${target.name}. Waiting for its screen…`);
    try {
      await transport.operation("devices.simulator", { deviceId: target.id, action: "launch" }, signal);
      if (!current()) return false;
      setRevealingDevice(target.id); setTab("feeds"); setFeedPickerOpen(false);
      setNotice(`${target.name} started. Connecting its feed…`);
      await refresh();
      return false;
    } finally { if (alive.current) setLaunchingDevice(undefined); }
  }, 300_000);
  const wake = () => command(async (signal) => {
    if (!device) return false;
    if (activeSession && !window.confirm(`Wake ${device.name}? It is currently reserved by ${activeSession.owner}.`)) return false;
    return transport.operation("devices.wake", { deviceId: device.id, ...(activeSession ? { sessionId: activeSession.id, confirmed: true } : {}) }, signal);
  });
  const recording = snapshot?.recordings.find((item) => item.deviceId === remoteId);
  const feeds = snapshot?.sources.map((source) => {
    const device = snapshot.devices.find((item) => item.captureSourceId === source.id || item.id === source.deviceId);
    const id = device?.id || source.deviceId;
    return { source, device, route: source.kind === "usb" ? `/v1/source-preview/${encodeURIComponent(source.id)}` : id ? `/v1/preview/${encodeURIComponent(id)}` : "" };
  }).filter((feed) => feed.route) || [];
  const chosenFeeds = selectedFeeds ?? feeds.filter((feed) => feed.source.status === "connected").map((feed) => feed.source.id);
  const visibleFeeds = feeds.filter((feed) => chosenFeeds.includes(feed.source.id));
  const simulators = snapshot?.devices.filter(canLaunchSimulator) || [];
  const query = feedSearch.trim().toLocaleLowerCase();
  const listedFeeds = feeds.filter((feed) => (feedPickerMode !== "simulators" || Boolean(feed.device && canLaunchSimulator(feed.device))) && `${feed.source.name} ${feed.device?.name || ""}`.toLocaleLowerCase().includes(query));
  const unboundSimulators = simulators.filter((simulator) => !feeds.some((feed) => feed.device?.id === simulator.id) && simulator.name.toLocaleLowerCase().includes(query));
  const showFeed = (id: string) => { setSelectedFeeds((ids) => [...new Set([...(ids ?? chosenFeeds), id])]); setTab("feeds"); setFeedPickerOpen(false); };
  const chooseFeeds = (mode: "all" | "simulators") => { setFeedSearch(""); setFeedPickerMode(mode); setFeedPickerOpen(true); };
  useEffect(() => {
    if (!revealingDevice || !snapshot) return;
    const target = snapshot.devices.find((d) => d.id === revealingDevice);
    const source = snapshot.sources.find((s) => s.id === target?.captureSourceId || s.deviceId === revealingDevice);
    if (!target?.online || !source) return;
    setSelectedFeeds((ids) => [...new Set([...(ids ?? snapshot.sources.filter((s) => s.status === "connected").map((s) => s.id)), source.id])]);
    setRevealingDevice(undefined); setNotice(`${target.name} is ready in Feeds.`);
  }, [revealingDevice, snapshot]);
  return <div className="machine-workspace">
    <div className="workspace-heading"><button className="secondary back-button" onClick={onBack}><ArrowLeft size={17} />Machines</button><div><h1>{machine.name}</h1><a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">{machine.endpoint}<ExternalLink size={13} /></a></div><button className="secondary" aria-label="Refresh machine" onClick={() => void refresh()} disabled={refreshing || standalone}><RefreshCw size={17} className={refreshing ? "spin" : ""} /><span>Refresh</span></button></div>
    {standalone ? <div className="empty-panel"><ExternalLink size={38} /><h2>Open this machine directly</h2><p>This address uses HTTP. Phone browsers and secure pages need trusted HTTPS for embedded feeds and controls.</p><a className="primary" href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open standalone <ExternalLink size={16} /></a><p className="field-note">Update its address to trusted HTTPS in Machine settings to use it inside Device Deck.</p></div> : <>
      <div className="workspace-status"><span className={`status-dot ${error ? "warn" : snapshot ? "good" : ""}`} />{error ? "Connection interrupted" : snapshot ? "Connected directly from this browser" : "Connecting to machine…"}{updatedAt && <span>Last checked {time(updatedAt)}</span>}</div>
      {error && <div className="notice error" role="alert">{error}<a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open machine address <ExternalLink size={14} /></a></div>}
      <nav className="workspace-tabs" aria-label="Machine views">{([['feeds', Grid2X2, 'Feeds', feeds.length], ['devices', Tv, 'Devices', snapshot?.devices.length], ['captures', Camera, 'Captures', snapshot?.artifacts.filter((item) => !item.deletedAt && !item.purgedAt).length]] as const).map(([key, Icon, label, count]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}><Icon size={18} />{label}<span>{count ?? "—"}</span></button>)}</nav>
      {!snapshot && !error && <div className="empty-panel" role="status"><LoaderCircle className="spin" size={32} /><p>Loading devices and feeds…</p></div>}
      {tab === "feeds" && snapshot && <>
        <div className="portal-feed-toolbar" ref={feedPicker}>
          <div><strong>{visibleFeeds.length} {visibleFeeds.length === 1 ? "feed" : "feeds"}</strong><span>Choose a screen, then start a session to control it.</span></div>
          <button className="secondary" aria-expanded={feedPickerOpen && feedPickerMode === "all"} onClick={() => feedPickerOpen && feedPickerMode === "all" ? setFeedPickerOpen(false) : chooseFeeds("all")}>Choose feeds<ChevronDown size={15} /></button>
          {simulators.length > 0 && <button className="secondary" onClick={() => chooseFeeds("simulators")}><Play size={15} />Start simulator</button>}
          {feedPickerOpen && <div className="portal-feed-picker" role="dialog" aria-label="Choose feeds">
            <header><strong>{feedPickerMode === "simulators" ? "Simulators" : "Choose feeds"}</strong><button className="icon-button" aria-label="Close feed picker" onClick={() => setFeedPickerOpen(false)}><X size={17} /></button></header>
            <label className="portal-feed-search"><Search size={16} /><input type="search" aria-label="Find a feed" placeholder="Find a feed…" value={feedSearch} onChange={(event) => setFeedSearch(event.target.value)} /></label>
            <div className="portal-feed-options">{listedFeeds.map(({ source, device: target }) => <div className="portal-feed-option" key={source.id}>
              <label><input type="checkbox" checked={chosenFeeds.includes(source.id)} disabled={Boolean(target && !target.online && canLaunchSimulator(target))} onChange={() => setSelectedFeeds((ids) => (ids ?? chosenFeeds).includes(source.id) ? (ids ?? chosenFeeds).filter((id) => id !== source.id) : [...(ids ?? chosenFeeds), source.id])} /><span><strong>{source.name}</strong><small>{target ? `${target.name} · ${target.online ? "Running" : "Offline"}` : "USB capture"}</small></span></label>
              {target && canLaunchSimulator(target) && !target.online ? <button className="secondary" aria-label={`Launch ${target.name} and show feed`} disabled={busy || target.locked || target.simulatorState === "unavailable" || Boolean(error)} onClick={() => void launchFeed(target)}>Launch &amp; show feed</button> : <button className="text-button" onClick={() => showFeed(source.id)}>Show feed</button>}
            </div>)}{unboundSimulators.map((target) => <div className="portal-feed-option" key={target.id}><div className="portal-feed-option-name"><Monitor size={18} /><span><strong>{target.name}</strong><small>{target.platform} simulator</small></span></div><button className="secondary" aria-label={`Launch ${target.name} and show feed`} disabled={busy || target.locked || target.simulatorState === "unavailable" || Boolean(error)} onClick={() => void launchFeed(target)}>Launch &amp; show feed</button></div>)}
              {!listedFeeds.length && !unboundSimulators.length && <p className="portal-feed-none">No matching feeds.</p>}
            </div>
            {launchingDevice && <p className="portal-feed-launch-status" role="status"><LoaderCircle className="spin" size={15} />{notice}</p>}
          </div>}
        </div>
        {notice && !remoteId && <p className="notice" role="status">{notice}</p>}
        {visibleFeeds.length ? <div className="feed-grid">{visibleFeeds.map(({ source, device: feedDevice, route }) => {
          const session = snapshot.sessions.find((s) => s.deviceId === feedDevice?.id && s.state !== "closed" && s.expiresAt > Date.now());
          const lease = feedDevice ? leases.get(`${machine.id}:${feedDevice.id}`) : undefined;
          const ours = Boolean(lease && session?.id === lease.sessionId);
          const enabled = Boolean(feedDevice?.online && !feedDevice.locked && !error && ours && touchSessions[feedDevice.id] === lease?.sessionId);
          const reserved = Boolean(session && !ours);
          return <article className="feed-card" data-feed-source={source.id} key={source.id}>
            <MachinePreview transport={transport} route={enabled && feedDevice ? `/v1/preview/${encodeURIComponent(feedDevice.id)}` : route} label={source.name} active={source.kind === "usb" || Boolean(feedDevice?.online)} lease={enabled ? lease : null} inputEnabled={!busy && !remoteId} />
            <footer><div><strong>{source.name}</strong><span>{feedDevice?.name || "Unassigned input"}</span></div>{feedDevice && <button className="secondary" onClick={() => selectRemote(feedDevice.id)}><Radio size={16} />Remote</button>}</footer>
            {feedDevice?.capabilities.includes("touch") && <div className="portal-feed-control"><span>{reserved ? `Reserved by ${session!.owner}` : enabled ? "Touch control enabled" : "View only"}</span>
              {!enabled && <button className="secondary" disabled={busy || !feedDevice.online || feedDevice.locked || Boolean(error)} onClick={() => void startFeedControl(feedDevice, reserved)}>{reserved ? "Take over control…" : "Start control session"}</button>}
              {ours && <button className="text-button" disabled={busy} onClick={() => void endFeedControl(feedDevice)}>{snapshot.recordings.some((r) => r.deviceId === feedDevice.id) ? "End session & save recording" : "End session"}</button>}
            </div>}
          </article>;
        })}</div> : <div className="empty-panel"><Monitor size={38} /><h2>{feeds.length || simulators.length ? "Choose a feed to get started" : "No feeds configured yet"}</h2><p>{feeds.length || simulators.length ? "Show a connected screen or launch a simulator from the feed picker." : "Add devices or capture cards on this machine to see their live screens here."}</p>{feeds.length || simulators.length ? <button className="secondary" onClick={() => chooseFeeds("all")}>Choose feeds</button> : <a className="secondary" href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open machine setup <ExternalLink size={15} /></a>}</div>}
      </>}
      {tab === "devices" && snapshot && <div className="device-grid">{snapshot.devices.length ? snapshot.devices.map((item) => { const session = snapshot.sessions.find((entry) => entry.deviceId === item.id && entry.state !== "closed"); return <article className="device-card" key={item.id}><div className="device-card-top"><span className="machine-icon"><Tv size={25} /></span><span className={`pill ${item.online ? "good" : "muted"}`}>{item.locked ? "Locked" : item.online ? "Online" : "Offline"}</span></div><h2>{item.name}</h2><p>{item.platform} · {item.kind}</p><small>{session ? `Reserved by ${session.owner}` : item.healthDetail || "Available"}</small><button className="primary" onClick={() => selectRemote(item.id)}><Radio size={17} />Open remote</button></article>; }) : <div className="empty-panel"><Tv size={38} /><h2>No devices configured</h2><p>Discover or add devices from the machine's standalone dashboard.</p></div>}</div>}
      {tab === "captures" && notice && !remoteId && <p className="notice" role="status">{notice}</p>}
      {tab === "captures" && snapshot && <CaptureLibrary
        artifacts={snapshot.artifacts}
        devices={snapshot.devices}
        sessions={snapshot.sessions}
        folder={snapshot.config.settings.folder}
        operation={transport.operation}
        getBlob={getCaptureBlob}
        getThumbnail={getCaptureThumbnail}
        openArtifactId={capturePreviewId}
        onOpenArtifact={setCapturePreviewId}
        onChange={refresh}
        onOpenFolder={() => transport.operation("captures.openFolder", {}, AbortSignal.timeout(15_000))}
      />}
    </>}
    {device && <><button className="remote-backdrop" aria-label="Close remote" onClick={() => selectRemote()} /><aside ref={remotePanel} className="portal-remote-sheet" role="dialog" aria-modal="true" aria-label={`Remote for ${device.name}`}><header><div><span className="eyebrow">REMOTE CONTROL</span><h2>{device.name}</h2></div><button className="icon-button" aria-label="Close remote" onClick={() => selectRemote()}><X /></button></header><div className="portal-remote-content">
      <div className="deck-control-session-actions">
        {!activeSession && <input aria-label="Control session owner" value={sessionOwner} maxLength={128} onChange={(event) => setSessionOwner(event.target.value)} />}
        {!device.online && canLaunchSimulator(device) && <button className="primary" disabled={busy || device.locked || Boolean(error) || Boolean(activeSession)} onClick={() => { selectRemote(); void launchFeed(device); }}>Launch &amp; show feed</button>}
      </div><p className="remote-session-label">{occupied ? `Reserved by ${activeSession.owner}` : ownLease ? `Your reservation · ${recording ? "recording" : "active"}` : "First command reserves this device for 15 minutes."}</p>{occupied && <button className="secondary full-width" disabled={busy} onClick={() => void takeover()}>Take over control</button>}<RemoteControl key={device.id} preferenceScope={machine.id} compact={mobile} device={device} enabled={Boolean(canControl)} busy={busy} sendKey={(key) => remoteInput({ key })} sendText={(text) => remoteInput({ text })} wakeEnabled={!device.locked && !error} wake={wake} /><div className="portal-capture-actions"><button className="secondary" disabled={!canControl || busy || !device.capabilities.includes("screenshot")} onClick={() => void capture("captures.screenshot")}><Camera size={17} />Screenshot</button><button className="secondary" disabled={!canControl || busy || !device.capabilities.includes("screenshot")} onClick={screenshotToClipboard}><Clipboard size={17} />Screenshot to clipboard</button><button className={recording ? "danger" : "secondary"} disabled={!canControl || busy || !device.capabilities.includes("record")} onClick={() => void capture(recording ? "recordings.stop" : "recordings.start")}>{recording ? <Square size={17} /> : <Film size={17} />}{recording ? "Stop recording" : "Record"}</button></div>{ownLease && <button className="text-button full-width" disabled={busy} onClick={() => void endSession()}>{recording ? "End session & save recording" : "End session"}</button>}{notice && <p className="remote-notice" role="status">{notice === "Command sent." && <Check size={16} />}{notice}</p>}</div></aside></>}
    <CaptureToasts toasts={captureFeedback.toasts} dismiss={captureFeedback.dismiss} onOpen={(id) => { selectRemote(); setTab("captures"); setCapturePreviewId(id); }} />
  </div>;
}
