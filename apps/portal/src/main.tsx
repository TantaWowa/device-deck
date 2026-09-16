import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signOut, type Auth, type User } from "firebase/auth";
import { ArrowRight, Download, ExternalLink, LogOut, Monitor, MoreHorizontal, Plus, Radio, RefreshCw, Search, Settings2, Trash2, WifiOff, X } from "lucide-react";
import { grantSchema, machinesResponseSchema, type MachineRecord } from "../../../packages/core/src/hub";
import { createMachineTransport } from "../../../packages/machine-client/src";
import { AuthView } from "./AuthView";
import { MachineDialog } from "./MachineDialog";
import { MachineWorkspace, type LeaseMemory } from "./MachineWorkspace";
import { createCloudClient, type CloudClient } from "./cloud";
import { initializePortalAuth, authMessage } from "./firebase";
import { clearMachineCache, connectionMessage, needsStandalone, observationLabel, readMachineCache, writeMachineCache, type Observation } from "./model";
import "./style.css";
import "./remote.css";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

function MachineCard({ machine, cloud, cached, onOpen, onEdit, onRemove }: {
  machine: MachineRecord; cloud: CloudClient; cached: boolean; onOpen: () => void; onEdit: () => void; onRemove: () => void;
}) {
  const [observation, setObservation] = useState<Observation>();
  const [menu, setMenu] = useState(false);
  const [check, setCheck] = useState(0);
  useEffect(() => {
    if (needsStandalone(machine.endpoint, location.protocol)) { setObservation({ state: "standalone" }); return; }
    if (cached) { setObservation(undefined); return; }
    const controller = new AbortController();
    const transport = createMachineTransport({
      endpoint: machine.endpoint, expectedMachineId: machine.id, expectedPublicKey: machine.publicKey,
      getGrant: async () => grantSchema.parse(await cloud(`/machines/${encodeURIComponent(machine.id)}/grant`, { method: "POST", body: {}, signal: controller.signal })),
    });
    let timer: ReturnType<typeof setTimeout>;
    const visibility = () => {
      if (!document.hidden) setObservation((value) => value ? { ...value } : value);
    };
    document.addEventListener("visibilitychange", visibility);
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (!document.hidden) {
        setObservation((value) => ({ ...value, state: "checking" }));
        try {
          await transport.getJson("/v1/health", AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
          if (!controller.signal.aborted) setObservation({ state: "reachable", checkedAt: new Date().toISOString() });
        } catch (failure) {
          if (!controller.signal.aborted) setObservation({ state: "unreachable", checkedAt: new Date().toISOString(), detail: connectionMessage(failure) });
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 30_000);
    };
    void poll();
    return () => { controller.abort(); transport.dispose(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [machine.id, machine.endpoint, machine.publicKey.x, cloud, cached, check]);
  return <article className="machine-card">
    <div className="machine-card-top"><span className="machine-icon"><Monitor size={27} /></span><div className="machine-menu"><button className="icon-button" aria-label={`Options for ${machine.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={21} /></button>{menu && <div className="menu-popover"><button onClick={() => { setMenu(false); onEdit(); }}><Settings2 size={16} />Edit machine</button><button onClick={() => { setMenu(false); setCheck((value) => value + 1); }}><RefreshCw size={16} />Check connection</button><a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open standalone</a><button className="danger-text" onClick={() => { setMenu(false); onRemove(); }}><Trash2 size={16} />Remove machine</button></div>}</div></div>
    <h2><a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer" title="Open full machine dashboard in a new tab">{machine.name}</a></h2>
    <p className="machine-address"><a href={`${machine.endpoint}/`} target="_blank" rel="noreferrer" title="Open full machine dashboard in a new tab">{machine.endpoint}</a></p>
    <div className={`connection-state ${observation?.state || "unknown"}`}><span className="status-dot" />{observationLabel(observation)}</div>
    <p className="machine-check-time">{cached ? "Saved machine · connection not checked" : observation?.checkedAt ? `Checked ${new Date(observation.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Connection is checked from your browser"}</p>
    {observation?.state === "unreachable" && <p className="machine-error-detail">{observation.detail}</p>}
    <button className="machine-open" onClick={onOpen}>{observation?.state === "standalone" ? "Open machine" : "Feeds & controls"}<ArrowRight size={19} /></button>
  </article>;
}

function RemoveDialog({ machine, cloud, onDone, onClose }: { machine: MachineRecord; cloud: CloudClient; onDone: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef(new AbortController());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); return () => controller.current.abort(); }, []);
  const remove = async () => {
    setBusy(true); setError("");
    try { await cloud(`/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE", signal: controller.current.signal }); await onDone(); onClose(); }
    catch (failure) { if (!controller.current.signal.aborted) setError(connectionMessage(failure)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="portal-dialog" onCancel={onClose}><header><span className="dialog-icon"><Trash2 size={22} /></span><button className="icon-button" aria-label="Cancel removal" onClick={onClose}><X /></button></header><h2>Remove {machine.name}?</h2><p>This removes the machine from your account. Device Deck keeps running on the machine; pair it again to reconnect.</p>{error && <p className="notice error" role="alert">{error}</p>}<footer><button className="secondary" onClick={onClose} disabled={busy}>Keep machine</button><button className="danger" onClick={() => void remove()} disabled={busy}>{busy ? "Removing…" : "Remove machine"}</button></footer></dialog>;
}

function Account({ user, onLogout, install }: { user: User; onLogout: () => Promise<void>; install?: InstallPrompt }) {
  const cloud = useMemo(() => createCloudClient(user), [user]);
  const initial = useMemo(() => readMachineCache(localStorage, user.uid), [user.uid]);
  const [machines, setMachines] = useState<MachineRecord[]>(initial?.machines || []);
  const [cached, setCached] = useState(Boolean(initial));
  const [savedAt, setSavedAt] = useState(initial?.savedAt || "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>(() => new URLSearchParams(location.hash.slice(1)).get("machine") || "");
  const [edit, setEdit] = useState<MachineRecord | "new">();
  const [remove, setRemove] = useState<MachineRecord>();
  const [online, setOnline] = useState(navigator.onLine);
  const [leaving, setLeaving] = useState(false);
  const lifetime = useRef(new AbortController());
  const leases = useRef<LeaseMemory>(new Map());
  const loadId = useRef(0);
  const refresh = async () => {
    const id = ++loadId.current;
    setLoading(true); setError("");
    try {
      const result = machinesResponseSchema.parse(await cloud("/machines", { signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(12_000)]) }));
      if (lifetime.current.signal.aborted || id !== loadId.current) return;
      setMachines(result.machines); setCached(false);
      setSavedAt(writeMachineCache(localStorage, user.uid, result.machines));
      if (selected && !result.machines.some((machine) => machine.id === selected)) setSelected("");
    } catch (failure) {
      if (!lifetime.current.signal.aborted && id === loadId.current) { setError(connectionMessage(failure)); setCached(true); }
    } finally { if (!lifetime.current.signal.aborted && id === loadId.current) setLoading(false); }
  };
  useEffect(() => {
    void refresh();
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed); window.addEventListener("offline", changed);
    return () => { lifetime.current.abort(); leases.current.clear(); window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, []);
  useEffect(() => { if (online && !loading && cached) void refresh(); }, [online]);
  const choose = (id: string) => { setSelected(id); history.replaceState(null, "", `${location.pathname}${id ? `#machine=${encodeURIComponent(id)}` : ""}`); };
  const logout = async () => {
    setLeaving(true); lifetime.current.abort(); leases.current.clear(); clearMachineCache(localStorage, user.uid);
    history.replaceState(null, "", location.pathname);
    await onLogout();
  };
  const active = machines.find((machine) => machine.id === selected);
  const visible = machines.filter((machine) => `${machine.name} ${machine.endpoint}`.toLowerCase().includes(query.toLowerCase()));
  if (leaving) return <main className="signing-out" role="status">Signing out…</main>;
  return <div className="portal-shell">
    <header className="portal-header"><a href="/app/" className="brand" onClick={(event) => { event.preventDefault(); choose(""); }}><span className="brand-icon"><Monitor size={22} /></span>Device Deck<span className="brand-tag">CONNECT</span></a><nav aria-label="Account"><span className="account-label">{user.displayName || user.email || "Your account"}</span>{install && <button className="icon-button" title="Install Device Deck" aria-label="Install Device Deck" onClick={() => void install.prompt()}><Download size={18} /></button>}<button className="secondary logout-button" aria-label="Sign out" onClick={() => void logout()}><LogOut size={17} /><span>Sign out</span></button></nav></header>
    {!online && <div className="network-banner" role="status"><WifiOff size={17} />Your browser is offline. Saved machines may be out of date. Controls require a live connection.</div>}
    <main className="portal-main">
      {active ? <MachineWorkspace key={`${active.id}:${active.endpoint}:${active.updatedAt}`} machine={active} cloud={cloud} owner={user.displayName || user.email || "Device Deck user"} leases={leases.current} onBack={() => choose("")} /> : <>
        <div className="dashboard-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>Your machines<span className="count-badge">{machines.length}</span></h1><p>Live feeds and familiar controls. Wherever you work.</p></div><button className="primary" onClick={() => setEdit("new")} disabled={!online}><Plus size={19} />Add machine</button></div>
        <div className="dashboard-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Search machines" placeholder="Find a machine…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary" aria-label="Refresh machines" disabled={loading || !online} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spin" : ""} /><span>Refresh</span></button></div>
        {cached && savedAt && <div className="notice" role="status"><strong>Saved list · last updated {new Date(savedAt).toLocaleString()}</strong><span>These are saved account details. Machine availability has not been checked.</span></div>}
        {error && <div className="notice error" role="alert">{error}</div>}
        {loading && !machines.length ? <div className="empty-panel" role="status"><RefreshCw className="spin" size={32} /><p>Loading your machines…</p></div> : !machines.length ? <section className="first-machine"><div className="first-machine-art" aria-hidden="true"><Monitor size={78} /><span><Plus size={23} /></span></div><span className="eyebrow">A GOOD PLACE TO START</span><h2>Bring your first machine aboard.</h2><p>Add the Mac running Device Deck. Once paired, its devices, feeds and remotes are a tap away.</p><button className="primary" onClick={() => setEdit("new")} disabled={!online}><Plus size={18} />Add your first machine</button><div className="onboarding-steps"><span><b>1</b>Run Device Deck</span><span><b>2</b>Get a pairing code</span><span><b>3</b>Connect & control</span></div></section> : visible.length ? <div className="machine-grid">{visible.map((machine) => <MachineCard key={`${machine.id}:${machine.endpoint}`} machine={machine} cloud={cloud} cached={cached} onOpen={() => choose(machine.id)} onEdit={() => setEdit(machine)} onRemove={() => setRemove(machine)} />)}<button className="add-machine-card" onClick={() => setEdit("new")} disabled={!online}><span><Plus size={25} /></span><strong>Add another machine</strong><small>More screens. One workspace.</small></button></div> : <div className="empty-panel"><Search size={32} /><h2>No matching machines</h2><p>Try a different name or address.</p></div>}
        <div className="workspace-note"><Radio size={19} /><p><strong>A direct connection to your lab.</strong> Feeds and controls travel between this browser and your machines. Connect to their local network or VPN and use a trusted HTTPS address.</p></div>
      </>}
    </main>
    <footer className="portal-footer"><span>Device Deck</span><span>Your screens, within reach.</span><a href="/" target="_blank" rel="noreferrer">About Device Deck <ExternalLink size={12} /></a></footer>
    {edit && <MachineDialog machine={edit === "new" ? undefined : edit} cloud={cloud} onSaved={refresh} onClose={() => setEdit(undefined)} />}
    {remove && <RemoveDialog machine={remove} cloud={cloud} onClose={() => setRemove(undefined)} onDone={async () => { if (selected === remove.id) choose(""); for (const key of leases.current.keys()) if (key.startsWith(`${remove.id}:`)) leases.current.delete(key); await refresh(); }} />}
  </div>;
}

function App() {
  const [auth, setAuth] = useState<Auth>();
  const [user, setUser] = useState<User | null>(null);
  const [setupError, setSetupError] = useState("");
  const [install, setInstall] = useState<InstallPrompt>();
  useEffect(() => {
    let unsubscribe = () => {};
    let alive = true;
    void initializePortalAuth().then((value) => {
      if (!alive) return;
      setAuth(value); unsubscribe = onAuthStateChanged(value, (next) => { if (alive) setUser(next); });
    }).catch((error) => { if (alive) setSetupError(authMessage(error)); });
    const offer = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const installed = () => setInstall(undefined);
    window.addEventListener("beforeinstallprompt", offer); window.addEventListener("appinstalled", installed);
    return () => { alive = false; unsubscribe(); window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", installed); };
  }, []);
  return user && auth ? <Account key={user.uid} user={user} install={install} onLogout={async () => { setUser(null); await signOut(auth); }} /> : <AuthView auth={auth} setupError={setupError} />;
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator && location.protocol === "https:") {
  void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then(async () => {
    const registration = await navigator.serviceWorker.ready;
    const urls = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[rel="stylesheet"]')].map((element) => element instanceof HTMLScriptElement ? element.src : element.href);
    registration.active?.postMessage({ type: "CACHE_SHELL", urls });
  }).catch(() => { /* The portal still works if installation is unavailable. */ });
}
