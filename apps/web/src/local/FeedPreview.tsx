import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Device, Session, Source } from "../../../../packages/core/src/local/types";
import { deviceInputMode } from "../../../../packages/core/src/remote";
import { api } from "./api";
import { LivePreview, type LiveLease } from "./LivePreview";
import type { DeviceLease } from "./DeviceControls";

type SessionChoice = { action: "takeover" | "release" | "enable"; sessionId: string };

/** Touch permission belongs to this feed and always starts disabled. */
export function FeedPreview({ source, device, session, lease, owner: defaultOwner, recording, onLease, refresh }: {
  source: Source; device?: Device; session?: Session; lease: LiveLease | null; owner: string;
  recording: boolean; onLease: (lease: DeviceLease) => void; refresh: () => Promise<unknown>;
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const [approved, setApproved] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<SessionChoice | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const observed = useRef<string | null>(null);
  const replacedSession = useRef<string | undefined>(undefined);
  const latest = useRef({ device, session, lease });
  latest.current = { device, session, lease };
  const owned = Boolean(lease && session?.id === lease.sessionId && session.state === "active" && session.expiresAt > Date.now());
  const touchDevice = Boolean(device && deviceInputMode(device) === "touch");
  const touch = Boolean(device?.capabilities.includes("touch"));
  const booting = device?.readiness === "starting" || device?.simulatorState === "starting";
  const available = Boolean(device?.online && !booting && !device.locked && touch);
  const controlling = Boolean(owned && approved?.id === session?.id && available);
  const disable = useCallback(() => { generation.current++; observed.current = null; setApproved(null); setConfirm(null); }, []);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) disable(); };
    window.addEventListener("offline", disable);
    document.addEventListener("visibilitychange", hidden);
    return () => { mounted.current = false; generation.current++; window.removeEventListener("offline", disable); document.removeEventListener("visibilitychange", hidden); };
  }, [disable]);
  useEffect(() => {
    if (!approved) return;
    if (session?.id === approved.id) observed.current = approved.id;
    const current = session?.id === approved.id ? session : approved;
    if (!available || document.hidden || !navigator.onLine || current.state !== "active" || current.expiresAt <= Date.now() ||
      (session && session.id !== approved.id && (observed.current === approved.id || session.id !== replacedSession.current)) || (observed.current === approved.id && (!session || !lease || lease.sessionId !== approved.id))) {
      disable(); return;
    }
    const timer = window.setTimeout(disable, Math.max(0, current.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [approved, available, session?.id, session?.state, session?.expiresAt, lease?.sessionId, disable]);
  useEffect(() => { if (confirm && session?.id !== confirm.sessionId) { setConfirm(null); setError("The reservation changed. Review the current session before continuing."); } }, [confirm, session?.id]);

  const endpoint = source.kind === "usb" ? `/v1/source-preview/${encodeURIComponent(source.id)}` : `/v1/preview/${encodeURIComponent(source.deviceId || device?.id || "")}`;
  const getSnapshot = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(endpoint, { signal, cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.message || "Snapshot unavailable.");
    }
    return response.blob();
  }, [endpoint]);
  const run = async (action: (request: number) => Promise<unknown>) => {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true); setError("");
    try { await action(request); if (mounted.current && generation.current === request) setConfirm(null); }
    catch (failure) { if (mounted.current && generation.current === request) setError((failure as Error).message); }
    finally { await refresh(); if (mounted.current) setBusy(false); }
  };
  const approve = (result: DeviceLease, request: number) => {
    onLease(result);
    if (mounted.current && generation.current === request && !document.hidden && navigator.onLine && latest.current.device?.online) {
      observed.current = null; replacedSession.current = latest.current.session?.id; setApproved(result.session);
    }
  };
  const start = () => {
    if (!device || !available) return;
    if (session) { setConfirm({ action: owned ? "enable" : "takeover", sessionId: session.id }); return; }
    void run(async (request) => {
      const result = await api<DeviceLease>("sessions.reserve", {
        selector: { device: device.id }, owner: owner.trim(), reason: "Touch control from live feed",
      });
      approve(result, request);
    });
  };
  return <div className="feed-preview-workspace">
    <LivePreview name={source.name}
      deviceId={controlling ? device?.id : source.kind === "native" ? source.deviceId : undefined}
      sourceId={!controlling && source.kind === "usb" ? source.id : undefined}
      operation={api} getSnapshot={getSnapshot} controlLease={controlling ? lease : null}
      controlDevice={controlling ? device : undefined}
      inputEnabled={!busy && !confirm && available}
      onConnectionStateChange={(state) => { if (state === "error" || state === "disconnected") disable(); }} />
    {device && (touchDevice || touch) && <div className="feed-session-bar" aria-label={`Touch controls for ${device.name}`}>
      <div className="feed-session-summary"><strong>{controlling ? "Touch enabled" : "Touch disabled"}</strong><span>{booting ? "Booting… Waiting for the device to become ready." : session ? `${owned ? "Your reservation" : "Reserved"} · ${session.owner} · until ${new Date(session.expiresAt).toLocaleTimeString()}` : "Enable touch to reserve and control this screen."}</span></div>
      {!session && <input aria-label={`Control session owner for ${device.name}`} value={owner} placeholder="Session owner" maxLength={128} onChange={(event) => setOwner(event.target.value)} />}
      <label className="feed-touch-switch"><input type="checkbox" role="switch" aria-label="Enable touch" checked={controlling} disabled={!controlling && (busy || !available || !owner.trim() || Boolean(session && (session.state !== "active" || session.expiresAt <= Date.now())))} onChange={(event) => { if (!event.target.checked) disable(); else start(); }} /><span>Enable touch</span></label>
      {owned && <button type="button" disabled={busy} onClick={() => setConfirm({ action: "release", sessionId: session!.id })}>End session…</button>}
      {!touch && <p className="feed-touch-unavailable" role="status">Touch input is unavailable for this device. {device.healthDetail || "Check the device input tools and reconnect the feed."}</p>}
      {touch && !device.online && !booting && <p className="feed-touch-unavailable" role="status">Device offline. Touch can be enabled when it reconnects.</p>}
      {device.locked && <p className="feed-touch-unavailable" role="status">Device locked. {device.lockReason}</p>}
      {owned && !controlling && <small className="feed-touch-session-kept">Touch is off. Your reservation{recording ? " and recording remain" : " remains"} active.</small>}
      {error && <p role="alert" className="feed-session-error">{error}</p>}
      {confirm && <div className="feed-session-confirm" role="alertdialog" aria-label="Confirm feed session change">
        <strong>{confirm.action === "takeover" ? `Take over ${device.name} from ${session?.owner}?` : confirm.action === "enable" ? "Enable touch for your current session?" : "End this control session?"}</strong>
        <p>{confirm.action === "enable" ? `Touch input can interrupt work or running tests. Your reservation${recording ? " and recording stay" : " stays"} active.` : `${recording ? "The recording will stop and save before this session ends. " : ""}${confirm.action === "takeover" ? "Touch input can interrupt work or running tests. The current reservation will end before you take control." : "Touch input stops and the reservation is released."}`}</p>
        {confirm.action === "takeover" && <input aria-label="New session owner" value={owner} maxLength={128} onChange={(event) => setOwner(event.target.value)} />}
        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className={confirm.action === "enable" ? "primary" : "danger"} disabled={busy || (confirm.action === "takeover" && !owner.trim())} onClick={() => void run(async (request) => {
          if (latest.current.session?.id !== confirm.sessionId) throw new Error("The reservation changed. Review it before continuing.");
          if (confirm.action === "takeover") {
            const result = await api<DeviceLease>("sessions.takeover", { deviceId: device.id, owner: owner.trim(), reason: "Touch control from live feed", confirmed: true });
            approve(result, request);
          } else if (confirm.action === "enable") {
            if (!lease || !owned || !available) throw new Error("This reservation is no longer available for touch control.");
            if (generation.current === request) setApproved(session!);
          } else {
            setApproved(null);
            await api("sessions.release", lease, AbortSignal.timeout(180_000));
          }
        })}>{confirm.action === "takeover" ? "End session & enable touch" : confirm.action === "enable" ? "Enable touch" : "End session"}</button>
      </div>}
    </div>}
  </div>;
}
