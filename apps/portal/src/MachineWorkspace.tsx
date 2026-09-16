import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, ChevronDown, Clipboard, ExternalLink, Film, Grid2X2, LoaderCircle, Monitor, Play, Radio, RefreshCw, Search, Smartphone, Square, Tv, X } from "lucide-react";
import { grantSchema, type MachineRecord } from "../../../packages/core/src/hub";
import type { Artifact, Device, Session, Snapshot } from "../../../packages/core/src/local/types";
import { createMachineTransport } from "../../../packages/machine-client/src";
import { canLaunchSimulator } from "../../../packages/core/src/local/types";
import { deviceInputMode } from "../../../packages/core/src/remote";
import { deviceFormFactor } from "../../../packages/core/src/device-form-factor";
import { DeviceTypeFilter } from "../../web/src/local/DeviceTypeFilter";
import { deviceConnectionLabel, deviceIsBooting as isBooting } from "../../../packages/core/src/device-table";
import { LivePreview } from "../../web/src/local/LivePreview";
import { FloatingRemote } from "../../web/src/local/FloatingRemote";
import { popupAnchor, type PopupAnchor } from "../../web/src/local/anchored-popup";
import { RemoteControl } from "../../web/src/local/RemoteControl";
import { CaptureLibrary } from "../../web/src/local/CaptureLibrary";
import { CaptureToasts, copyImageToClipboard, useCaptureFeedback } from "../../web/src/local/capture-feedback";
import { connectionMessage, ControlGate, needsStandalone } from "./model";
import type { CloudClient } from "./cloud";
import "./touch-workspace.css";

type Transport = ReturnType<typeof createMachineTransport>;
export type Lease = { sessionId: string; leaseToken: string };
export type LeaseMemory = Map<string, Lease>;
const time = (value: string | number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const isTransitioning = (device: Device) => isBooting(device) || device.simulatorState === "stopping";

function MachinePreview({ transport, route, label, lease, controlDevice, inputEnabled, active = true, onControlLost }: { transport: Transport; route: string; label: string; lease?: Lease | null; controlDevice?: Device; inputEnabled?: boolean; active?: boolean; onControlLost?: () => void }) {
  const getSnapshot = useCallback((signal: AbortSignal) => transport.getBlob(route, signal), [transport, route]);
  const sourceId = route.startsWith("/v1/source-preview/") ? decodeURIComponent(route.slice("/v1/source-preview/".length)) : undefined;
  const deviceId = route.startsWith("/v1/preview/") ? decodeURIComponent(route.slice("/v1/preview/".length)) : undefined;
  return <LivePreview key={deviceId || sourceId} name={label} sourceId={sourceId} deviceId={deviceId} operation={transport.operation} getSnapshot={getSnapshot} controlLease={lease} controlDevice={controlDevice} inputEnabled={inputEnabled} active={active} onConnectionStateChange={(state) => { if (state === "error" || state === "disconnected") onControlLost?.(); }} />;
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
  const [remoteRequest, setRemoteRequest] = useState<{ anchor: PopupAnchor }>();
  const [touchSessions, setTouchSessions] = useState<Record<string, string>>({});
  const [selectedFeeds, setSelectedFeeds] = useState<string[] | null>(null);
  const [feedPickerOpen, setFeedPickerOpen] = useState(false);
  const [feedPickerMode, setFeedPickerMode] = useState<"all" | "simulators">("all");
  const [feedSearch, setFeedSearch] = useState("");
  const [formFactor, setFormFactor] = useState("");
  const [revealingDevice, setRevealingDevice] = useState<string>();
  const [launchingDevice, setLaunchingDevice] = useState<string>();
  const [sessionOwner, setSessionOwner] = useState(owner);
  const [capturePreviewId, setCapturePreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef(new AbortController());
  const gate = useRef(new ControlGate());
  const alive = useRef(true);
  const refreshingRef = useRef(false);
  const refreshQueued = useRef(false);
  const touchGeneration = useRef(0);
  const feedPicker = useRef<HTMLDivElement>(null);
  const standalone = needsStandalone(machine.endpoint, location.protocol);
  const captureFeedback = useCaptureFeedback(snapshot?.artifacts);
  const getCaptureBlob = useCallback((item: Artifact, variant: "file" | "clean" | "log" = "file", signal?: AbortSignal) =>
    transport.getBlob(`/v1/artifacts/${encodeURIComponent(item.id)}/${variant}`, signal), [transport]);
  const getCaptureThumbnail = useCallback((item: Artifact, signal?: AbortSignal) =>
    transport.getBlob(`/v1/artifacts/${encodeURIComponent(item.id)}/thumbnail`, signal), [transport]);
  const refresh = async () => {
    if (standalone || lifecycle.current.signal.aborted) return;
    if (refreshingRef.current) { refreshQueued.current = true; return; }
    refreshingRef.current = true; setRefreshing(true);
    // A status request may finish after a new reservation. Only expire the
    // credentials this request actually observed when it began.
    const observedLeases = new Map(leases);
    try {
      const result = await transport.operation<Snapshot>("inventory", {}, AbortSignal.any([lifecycle.current.signal, AbortSignal.timeout(12_000)]));
      if (alive.current) {
        setSnapshot(result); setUpdatedAt(new Date().toISOString()); setError("");
        for (const device of result.devices) {
          const key = `${machine.id}:${device.id}`;
          const lease = observedLeases.get(key);
          if (lease && leases.get(key) === lease && !result.sessions.some((session) => session.id === lease.sessionId && session.state !== "closed" && session.expiresAt > Date.now())) leases.delete(key);
        }
        setTouchSessions((enabled) => Object.fromEntries(Object.entries(enabled).filter(([id, sessionId]) => {
          if (observedLeases.get(`${machine.id}:${id}`)?.sessionId !== sessionId) return true;
          const target = result.devices.find((item) => item.id === id);
          return target?.online && !target.locked && !isTransitioning(target) && result.sessions.some((session) => session.id === sessionId && session.state === "active" && session.expiresAt > Date.now());
        })));
      }
    } catch (failure) {
      gate.current.cancel();
      if (alive.current) { setBusy(false); setTouchSessions({}); setError(connectionMessage(failure)); }
    }
    finally {
      refreshingRef.current = false;
      if (alive.current) {
        setRefreshing(false);
        if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    lifecycle.current = new AbortController();
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    const cancelControls = () => {
      gate.current.cancel();
      touchGeneration.current++;
      setBusy(false);
      setTouchSessions({});
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
  const selectRemote = (id?: string, trigger?: HTMLElement) => {
    gate.current.cancel(); setBusy(false); setNotice(""); setRemoteId(id);
    setRemoteRequest(id && trigger ? { anchor: popupAnchor(trigger) } : undefined);
  };
  useEffect(() => {
    if (!feedPickerOpen) return;
    const close = (event: PointerEvent) => { if (!feedPicker.current?.contains(event.target as Node)) setFeedPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFeedPickerOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    feedPicker.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [feedPickerOpen]);
  const device = snapshot?.devices.find((item) => item.id === remoteId && deviceInputMode(item) === "remote");
  const activeSession = snapshot?.sessions.find((session) => session.deviceId === remoteId && session.state !== "closed" && session.expiresAt > Date.now());
  const leaseKey = device ? `${machine.id}:${device.id}` : "";
  const ownLease = leases.get(leaseKey);
  const occupied = activeSession && activeSession.id !== ownLease?.sessionId;
  const hasConnection = Boolean(device?.online && !isTransitioning(device) && !device.locked && !error);
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
      lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
      leases.set(key, lease);
      if (!current()) throw new DOMException("Cancelled", "AbortError");
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
  const capture = (operation: "captures.screenshot" | "recordings.start" | "recordings.stop", target = device) => command(async (signal, current) => {
    if (!target) return false;
    const lease = await withDeviceLease(target, signal, current);
    if (!current()) return false;
    const item = await transport.operation<Artifact | null>(operation, operation === "captures.screenshot" ? { ...lease, clipboard: false } : lease, signal);
    if (current()) {
      if (item && operation !== "recordings.start") captureFeedback.completed(item);
      setNotice(operation === "recordings.start" ? "Recording started. You can keep using the device." : operation === "recordings.stop" ? item ? "Recording finished. See Captures for the saved file." : "No recording is active." : "Screenshot saved to Captures.");
    }
    return item;
  }, operation === "recordings.stop" ? 180_000 : 60_000, null);
  const screenshotToClipboard = (target = device) => {
    if (!target) return;
    let currentRequest = () => alive.current;
    void copyImageToClipboard(async () => {
      const result = await command(async (signal, current) => {
        currentRequest = current;
        const lease = await withDeviceLease(target, signal, current);
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
    const generation = touchGeneration.current;
    if (!target.online || isTransitioning(target) || target.locked || !target.capabilities.includes("touch")) throw new Error("Touch is unavailable until this device is ready.");
    const session = snapshot?.sessions.find((s) => s.deviceId === target.id && s.state !== "closed" && s.expiresAt > Date.now());
    const own = leases.get(`${machine.id}:${target.id}`);
    if (!sessionOwner.trim()) throw new Error("Enter a session owner first.");
    if (session?.id === own?.sessionId && session && !window.confirm(`Enable touch for your current session on ${target.name}? Touch input can interrupt work or running tests. Your reservation and any recording stay active.`)) return false;
    let lease: Lease;
    if (session && session.id !== own?.sessionId) {
      if (!takeOver || !window.confirm(`Take over ${target.name} from ${session.owner}? Any active recording will be finalized.`)) return false;
      const reserved = await transport.operation<{ session: Session; leaseToken: string }>("sessions.takeover", { deviceId: target.id, owner: sessionOwner, reason: "Take over from Device Deck feed", confirmed: true }, signal);
      lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
      leases.set(`${machine.id}:${target.id}`, lease);
    } else lease = await withDeviceLease(target, signal, current);
    if (!current() || touchGeneration.current !== generation) return false;
    setTouchSessions((sessions) => ({ ...sessions, [target.id]: lease.sessionId }));
    return lease;
  }, takeOver ? 180_000 : 10_000, "Touch enabled. Tap, swipe or drag on the device screen.");
  const disableFeedControl = (target: Device) => {
    touchGeneration.current++;
    setTouchSessions((sessions) => { const next = { ...sessions }; delete next[target.id]; return next; });
    setNotice("Touch disabled. Your reservation and any recording remain active.");
  };
  const endFeedControl = (target: Device) => command(async (signal, current) => {
    const key = `${machine.id}:${target.id}`, lease = leases.get(key);
    if (!lease) return false;
    if (!window.confirm(`End your session for ${target.name}?${snapshot?.recordings.some((item) => item.deviceId === target.id) ? " The recording will stop and save." : " Touch control will stop."}`)) return false;
    const result = await transport.operation("sessions.release", lease, signal);
    if (current()) {
      leases.delete(key);
      setTouchSessions((sessions) => { const next = { ...sessions }; delete next[target.id]; return next; });
    }
    return result;
  }, 180_000);
  const launchFeed = (target: Device) => command(async (signal, current) => {
    if (isTransitioning(target)) return false;
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
  const matchesType = (target?: Device) => !formFactor || deviceFormFactor(target) === formFactor;
  const visibleFeeds = feeds.filter((feed) => chosenFeeds.includes(feed.source.id) && matchesType(feed.device));
  const visibleDevices = snapshot?.devices.filter(matchesType) || [];
  const visibleFeedKey = visibleFeeds.map((feed) => `${feed.source.id}:${feed.device?.id || ""}`).join(",");
  useEffect(() => {
    touchGeneration.current++;
    const visibleIds = new Set(tab === "feeds" ? visibleFeeds.map((feed) => feed.device?.id) : []);
    setTouchSessions((sessions) => Object.fromEntries(Object.entries(sessions).filter(([id]) => visibleIds.has(id))));
  }, [tab, visibleFeedKey]);
  const simulators = snapshot?.devices.filter(canLaunchSimulator) || [];
  const query = feedSearch.trim().toLocaleLowerCase();
  const listedFeeds = feeds.filter((feed) => matchesType(feed.device) && (feedPickerMode !== "simulators" || Boolean(feed.device && canLaunchSimulator(feed.device))) && `${feed.source.name} ${feed.device?.name || ""}`.toLocaleLowerCase().includes(query));
  const unboundSimulators = simulators.filter((simulator) => matchesType(simulator) && !feeds.some((feed) => feed.device?.id === simulator.id) && simulator.name.toLocaleLowerCase().includes(query));
  const showFeed = (id: string) => { setSelectedFeeds((ids) => [...new Set([...(ids ?? chosenFeeds), id])]); setTab("feeds"); setFeedPickerOpen(false); };
  const openDeviceFeed = (target: Device) => {
    setFormFactor("");
    const feed = feeds.find((item) => item.device?.id === target.id);
    setTab("feeds");
    if (feed) showFeed(feed.source.id);
    else if (!target.online && !isTransitioning(target) && canLaunchSimulator(target)) void launchFeed(target);
    else { setRevealingDevice(target.id); setNotice(isBooting(target) ? `${target.name} is booting. Its feed will appear when ready.` : `${target.name} has no capture feed. Configure a capture input on the host Mac.`); }
  };
  const chooseFeeds = (mode: "all" | "simulators") => { setFeedSearch(""); setFeedPickerMode(mode); setFeedPickerOpen(true); };
  const booting = snapshot?.devices.filter((target) => isBooting(target) || launchingDevice === target.id) || [];
  useEffect(() => {
    const enabled = new Set(Object.values(touchSessions));
    const expiries = snapshot?.sessions.filter((session) => enabled.has(session.id)).map((session) => session.expiresAt) || [];
    if (!expiries.length) return;
    const timer = setTimeout(() => setTouchSessions((sessions) => Object.fromEntries(Object.entries(sessions).filter(([, id]) => snapshot?.sessions.some((session) => session.id === id && session.state === "active" && session.expiresAt > Date.now())))), Math.max(0, Math.min(...expiries) - Date.now()));
    return () => clearTimeout(timer);
  }, [touchSessions, snapshot?.sessions]);
  useEffect(() => {
    if (!booting.length) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [booting.length > 0, transport]);
  useEffect(() => {
    if (!revealingDevice || !snapshot) return;
    const target = snapshot.devices.find((d) => d.id === revealingDevice);
    const source = snapshot.sources.find((s) => s.id === target?.captureSourceId || s.deviceId === revealingDevice);
    if (!target?.online || !source) return;
    setFormFactor((current) => !current || deviceFormFactor(target) === current ? current : "");
    setSelectedFeeds((ids) => [...new Set([...(ids ?? snapshot.sources.filter((s) => s.status === "connected").map((s) => s.id)), source.id])]);
    setRevealingDevice(undefined); setNotice(`${target.name} is ready in Feeds.`);
  }, [revealingDevice, snapshot]);
  return <div className="machine-workspace">
    <div className="workspace-heading"><button className="secondary back-button" onClick={onBack}><ArrowLeft size={17} />Machines</button><div><h1>{machine.name}</h1><a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">{machine.endpoint}<ExternalLink size={13} /></a></div><button className="secondary" aria-label="Refresh machine" onClick={() => void refresh()} disabled={refreshing || standalone}><RefreshCw size={17} className={refreshing ? "spin" : ""} /><span>Refresh</span></button></div>
    {standalone ? <div className="empty-panel"><ExternalLink size={38} /><h2>Open this machine directly</h2><p>This address uses HTTP. Phone browsers and secure pages need trusted HTTPS for embedded feeds and controls.</p><a className="primary" href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open standalone <ExternalLink size={16} /></a><p className="field-note">Update its address to trusted HTTPS in Machine settings to use it inside Device Deck.</p></div> : <>
      <div className="workspace-status"><span className={`status-dot ${error ? "warn" : snapshot ? "good" : ""}`} />{error ? "Connection interrupted" : snapshot ? "Connected directly from this browser" : "Connecting to machine…"}{updatedAt && <span>Last checked {time(updatedAt)}</span>}</div>
      {error && <div className="notice error" role="alert">{error}<a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open machine address <ExternalLink size={14} /></a></div>}
      <nav className="workspace-tabs" aria-label="Machine views">{([['feeds', Grid2X2, 'Feeds', feeds.length], ['devices', Tv, 'Devices', snapshot?.devices.length], ['captures', Camera, 'Captures', snapshot?.artifacts.filter((item) => !item.deletedAt && !item.purgedAt).length]] as const).map(([key, Icon, label, count]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}><Icon size={18} />{label}<span>{count ?? "—"}</span></button>)}</nav>
      {booting.length > 0 && <p className="notice portal-booting-status" role="status"><LoaderCircle className="spin" size={17} />Booting: {booting.map((target) => target.name).join(", ")}. Controls become available when the device is ready.</p>}
      {!snapshot && !error && <div className="empty-panel" role="status"><LoaderCircle className="spin" size={32} /><p>Loading devices and feeds…</p></div>}
      {tab === "feeds" && snapshot && <>
        <div className="portal-feed-toolbar" ref={feedPicker}>
          <div><strong>{visibleFeeds.length} {visibleFeeds.length === 1 ? "feed" : "feeds"}</strong><span>Choose a screen, then start a session to control it.</span></div>
          <DeviceTypeFilter value={formFactor} onChange={setFormFactor} />
          <button className="secondary" aria-expanded={feedPickerOpen && feedPickerMode === "all"} onClick={() => feedPickerOpen && feedPickerMode === "all" ? setFeedPickerOpen(false) : chooseFeeds("all")}>Choose feeds<ChevronDown size={15} /></button>
          {simulators.length > 0 && <button className="secondary" onClick={() => chooseFeeds("simulators")}><Play size={15} />Start simulator</button>}
          {feedPickerOpen && <div className="portal-feed-picker" role="dialog" aria-label="Choose feeds">
            <header><strong>{feedPickerMode === "simulators" ? "Simulators" : "Choose feeds"}</strong><button className="icon-button" aria-label="Close feed picker" onClick={() => setFeedPickerOpen(false)}><X size={17} /></button></header>
            <label className="portal-feed-search"><Search size={16} /><input type="search" aria-label="Find a feed" placeholder="Find a feed…" value={feedSearch} onChange={(event) => setFeedSearch(event.target.value)} /></label>
            <div className="portal-feed-options">{listedFeeds.map(({ source, device: target }) => <div className="portal-feed-option" key={source.id}>
              <label><input type="checkbox" checked={chosenFeeds.includes(source.id)} onChange={() => setSelectedFeeds((ids) => (ids ?? chosenFeeds).includes(source.id) ? (ids ?? chosenFeeds).filter((id) => id !== source.id) : [...(ids ?? chosenFeeds), source.id])} /><span><strong>{source.name}</strong><small>{target ? `${target.name} · ${launchingDevice === target.id ? "Booting…" : deviceConnectionLabel(target)}` : "USB capture"}</small></span></label>
              {target && canLaunchSimulator(target) && !target.online ? <button className="secondary" aria-label={`Launch ${target.name} and show feed`} disabled={busy || isTransitioning(target) || target.locked || target.simulatorState === "unavailable" || Boolean(error)} onClick={() => void launchFeed(target)}>{isBooting(target) || launchingDevice === target.id ? "Booting…" : "Launch & show feed"}</button> : <button className="text-button" onClick={() => showFeed(source.id)}>Show feed</button>}
            </div>)}{unboundSimulators.map((target) => <div className="portal-feed-option" key={target.id}><div className="portal-feed-option-name"><Monitor size={18} /><span><strong>{target.name}</strong><small>{target.platform} · {launchingDevice === target.id ? "Booting…" : deviceConnectionLabel(target)}</small></span></div><button className="secondary" aria-label={`Launch ${target.name} and show feed`} disabled={busy || isTransitioning(target) || target.locked || target.simulatorState === "unavailable" || Boolean(error)} onClick={() => void launchFeed(target)}>{isBooting(target) || launchingDevice === target.id ? "Booting…" : "Launch & show feed"}</button></div>)}
              {!listedFeeds.length && !unboundSimulators.length && <p className="portal-feed-none">No matching feeds.</p>}
            </div>
            {launchingDevice && <p className="portal-feed-launch-status" role="status"><LoaderCircle className="spin" size={15} />{notice}</p>}
          </div>}
        </div>
        {notice && !remoteId && <p className="notice" role="status">{notice}</p>}
        {visibleFeeds.length ? <div className="feed-grid">{visibleFeeds.map(({ source, device: feedDevice, route }) => {
          const session = snapshot.sessions.find((s) => s.deviceId === feedDevice?.id && s.state !== "closed" && s.expiresAt > Date.now());
          const lease = feedDevice ? leases.get(`${machine.id}:${feedDevice.id}`) : undefined;
          const ours = Boolean(lease && session?.id === lease.sessionId && session.state === "active");
          const enabled = Boolean(feedDevice?.online && !isTransitioning(feedDevice) && !feedDevice.locked && !error && ours && touchSessions[feedDevice.id] === lease?.sessionId);
          const reserved = Boolean(session && !ours);
          const touchDevice = Boolean(feedDevice && deviceInputMode(feedDevice) === "touch");
          const ready = Boolean(feedDevice?.online && !isTransitioning(feedDevice) && !feedDevice.locked && !error);
          const activeRecording = snapshot.recordings.some((item) => item.deviceId === feedDevice?.id);
          return <article className="feed-card" data-feed-source={source.id} key={source.id}>
            {feedDevice && (isTransitioning(feedDevice) || launchingDevice === feedDevice.id) ? <div className="portal-feed-booting" role="status"><LoaderCircle className="spin" size={28} /><strong>{feedDevice.simulatorState === "stopping" ? "Stopping…" : "Booting…"}</strong><span>{feedDevice.name} · {feedDevice.healthDetail}</span></div> : source.status === "missing" ? <div className="portal-feed-booting" role="status"><Monitor size={28} /><strong>{feedDevice?.simulatorState === "shutdown" ? "Stopped" : feedDevice && !feedDevice.online ? "Device offline" : "Input unavailable"}</strong><span>{feedDevice?.healthDetail || "Connect this capture input to resume."}</span>{feedDevice && canLaunchSimulator(feedDevice) && !feedDevice.online && <button className="primary" disabled={busy || feedDevice.locked || feedDevice.simulatorState === "unavailable" || Boolean(error)} onClick={() => void launchFeed(feedDevice)}><Play size={15} />Launch &amp; show feed</button>}</div> : <MachinePreview transport={transport} route={enabled && feedDevice ? `/v1/preview/${encodeURIComponent(feedDevice.id)}` : route} label={source.name} active={source.kind === "usb" || Boolean(feedDevice?.online)} lease={enabled ? lease : null} controlDevice={enabled ? feedDevice : undefined} inputEnabled={!busy && !remoteId} onControlLost={() => { touchGeneration.current++; if (feedDevice) setTouchSessions((sessions) => { if (!sessions[feedDevice.id]) return sessions; const next = { ...sessions }; delete next[feedDevice.id]; return next; }); }} />}
            <footer><div><strong>{source.name}</strong><span>{feedDevice?.name || "Unassigned input"}</span></div>{feedDevice && deviceInputMode(feedDevice) === "remote" && <button className="secondary" onClick={(event) => selectRemote(feedDevice.id, event.currentTarget)}><Radio size={16} />Remote</button>}</footer>
            {feedDevice && touchDevice && <div className="portal-feed-control" aria-label={`Touch controls for ${feedDevice.name}`}><span>{reserved ? `Reserved by ${session!.owner}. Enabling touch requires taking over their session.` : enabled ? "Touch enabled · Your reservation" : ours ? "Touch off · Your reservation remains active" : "View only · Enabling touch reserves this device for 15 minutes."}</span>
              {!session && <input aria-label={`Control session owner for ${feedDevice.name}`} value={sessionOwner} maxLength={128} onChange={(event) => setSessionOwner(event.target.value)} />}
              <button type="button" className="secondary portal-touch-switch" role="switch" aria-label="Enable touch" aria-checked={enabled} disabled={!enabled && (busy || !ready || !feedDevice.capabilities.includes("touch") || !sessionOwner.trim() || Boolean(session && session.state !== "active"))} onClick={() => enabled ? disableFeedControl(feedDevice) : void startFeedControl(feedDevice, reserved)}><span aria-hidden="true" />Enable touch</button>
              {!feedDevice.capabilities.includes("touch") && <small className="portal-touch-unavailable">{isBooting(feedDevice) ? "Touch is available after booting finishes." : !feedDevice.online ? "Connect or start this device to use touch." : feedDevice.healthDetail || "Touch control is unavailable for this device."}</small>}
              {ours && <button className="text-button" disabled={busy} onClick={() => void endFeedControl(feedDevice)}>{snapshot.recordings.some((r) => r.deviceId === feedDevice.id) ? "End session & save recording" : "End session"}</button>}
              <div className="portal-phone-capture-actions"><button className="secondary" disabled={busy || !ready || reserved || !feedDevice.capabilities.includes("screenshot")} onClick={() => void capture("captures.screenshot", feedDevice)}><Camera size={16} />Screenshot</button><button className="secondary" disabled={busy || !ready || reserved || !feedDevice.capabilities.includes("screenshot")} onClick={() => screenshotToClipboard(feedDevice)}><Clipboard size={16} />Screenshot to clipboard</button><button className={activeRecording ? "danger" : "secondary"} disabled={busy || !ready || reserved || !feedDevice.capabilities.includes("record")} onClick={() => void capture(activeRecording ? "recordings.stop" : "recordings.start", feedDevice)}>{activeRecording ? <Square size={16} /> : <Film size={16} />}{activeRecording ? "Stop recording" : "Record"}</button></div>
            </div>}
          </article>;
        })}</div> : <div className="empty-panel"><Monitor size={38} /><h2>{formFactor ? "No selected feeds match this device type" : feeds.length || simulators.length ? "Choose a feed to get started" : "No feeds configured yet"}</h2><p>{feeds.length || simulators.length ? "Show a connected screen or launch a simulator from the feed picker." : "Add devices or capture cards on this machine to see their live screens here."}</p>{formFactor && <button className="secondary" onClick={() => setFormFactor("")}>Show all device types</button>}{feeds.length || simulators.length ? <button className="secondary" onClick={() => chooseFeeds("all")}>Choose feeds</button> : <a className="secondary" href={`${machine.endpoint}/`} target="_blank" rel="noreferrer">Open machine setup <ExternalLink size={15} /></a>}</div>}
      </>}
      {tab === "devices" && snapshot && <><div className="portal-feed-toolbar"><DeviceTypeFilter value={formFactor} onChange={setFormFactor} /></div><div className="device-grid">{visibleDevices.length ? visibleDevices.map((item) => {
        const session = snapshot.sessions.find((entry) => entry.deviceId === item.id && entry.state !== "closed");
        const touch = deviceInputMode(item) === "touch", remote = deviceInputMode(item) === "remote";
        return <article className="device-card" key={item.id}><div className="device-card-top"><span className="machine-icon">{touch ? <Smartphone size={25} /> : <Tv size={25} />}</span><span className={`pill ${item.online && !isTransitioning(item) ? "good" : "muted"}`}>{launchingDevice === item.id ? "Booting…" : isTransitioning(item) ? deviceConnectionLabel(item) : item.locked ? "Locked" : deviceConnectionLabel(item)}</span></div><h2>{item.name}</h2><p>{item.platform} · {item.kind}</p><small>{launchingDevice === item.id || isBooting(item) ? "Waiting for the device to finish booting." : item.simulatorState === "stopping" ? "Waiting for the device to stop." : session ? `Reserved by ${session.owner}` : item.healthDetail || "Available"}</small><button className="primary" onClick={(event) => remote ? selectRemote(item.id, event.currentTarget) : openDeviceFeed(item)}>{remote ? <Radio size={17} /> : <Monitor size={17} />}{remote ? "Open remote" : "Open device screen"}</button></article>;
      }) : <div className="empty-panel"><Tv size={38} /><h2>{formFactor ? "No devices match this device type" : "No devices configured"}</h2>{formFactor ? <button className="secondary" onClick={() => setFormFactor("")}>Show all device types</button> : <p>Discover or add devices from the machine's standalone dashboard.</p>}</div>}</div></>}
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
    {device && remoteRequest && <FloatingRemote
      key={`${machine.id}:${device.id}`}
      storageKey={`${machine.id}:${device.id}`}
      requestKey={remoteRequest}
      anchor={remoteRequest.anchor}
      title={device.name}
      initialMenu={Boolean(occupied || device.locked || !device.online || error)}
      onClose={() => selectRemote()}
    >{(menu) => <>
      {menu && <div className="remote-options">
        {error && <p className="control-warning" role="alert">{error}</p>}
        <div className="control-session">
          <div className="control-session-title"><strong>{occupied ? `Reserved by ${activeSession.owner}` : ownLease ? "Your reservation" : "Available to reserve"}</strong><span>{device.locked ? "Locked" : device.online ? "Online" : "Offline"}</span></div>
          <p>{activeSession ? `${activeSession.owner} · ${recording ? "recording" : activeSession.state} · until ${time(activeSession.expiresAt)}` : "First command reserves this device for 15 minutes."}</p>
          {!activeSession && <div className="control-reserve-fields"><label>Owner<input aria-label="Control session owner" value={sessionOwner} maxLength={128} onChange={(event) => setSessionOwner(event.target.value)} /></label></div>}
          {!device.online && canLaunchSimulator(device) && <button className="primary" disabled={busy || device.locked || Boolean(error) || Boolean(activeSession)} onClick={() => { selectRemote(); void launchFeed(device); }}>Launch &amp; show feed</button>}
          {occupied && <button className="primary" disabled={busy} onClick={() => void takeover()}>Take over control</button>}
          {ownLease && <button disabled={busy} onClick={() => void endSession()}>{recording ? "End session & save recording" : "End session"}</button>}
        </div>
        <div className="control-capture">
          <h3>Quick capture</h3>
          <button disabled={!canControl || busy || !device.capabilities.includes("screenshot")} onClick={() => void capture("captures.screenshot")}><Camera size={17} />Screenshot</button>
          <button disabled={!canControl || busy || !device.capabilities.includes("screenshot")} onClick={() => screenshotToClipboard()}><Clipboard size={17} />Screenshot to clipboard</button>
          <button className={recording ? "danger" : "primary"} disabled={!canControl || busy || !device.capabilities.includes("record")} onClick={() => void capture(recording ? "recordings.stop" : "recordings.start")}>
            {recording ? <Square size={17} /> : <Film size={17} />}{recording ? "Stop recording" : "Record"}
          </button>
          <small>Closing the popup keeps your session and recording running. Captures are saved in the library.</small>
        </div>
      </div>}
      <RemoteControl key={device.id} preferenceScope={machine.id} device={device} enabled={Boolean(canControl && !menu)} busy={busy} sendKey={(key) => remoteInput({ key })} sendText={(text) => remoteInput({ text })} wakeEnabled={!menu && !device.locked && !error} wake={wake} />
      {notice && <p className="control-notice" role="status">{notice === "Command sent." && <Check size={16} />}{notice}</p>}
    </>}</FloatingRemote>}
    <CaptureToasts toasts={captureFeedback.toasts} dismiss={captureFeedback.dismiss} onOpen={(id) => { selectRemote(); setTab("captures"); setCapturePreviewId(id); }} />
  </div>;
}
