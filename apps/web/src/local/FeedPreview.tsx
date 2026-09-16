import React, { useCallback, useState } from "react";
import type { Device, Session, Source } from "../../../../packages/core/src/local/types";
import { api } from "./api";
import { LivePreview, type LiveLease } from "./LivePreview";
import type { DeviceLease } from "./DeviceControls";

/** The feed owns video and touch; the floating remote contains buttons only. */
export function FeedPreview({ source, device, session, lease, owner: defaultOwner, recording, onLease, refresh }: {
  source: Source;
  device?: Device;
  session?: Session;
  lease: LiveLease | null;
  owner: string;
  recording: boolean;
  onLease: (lease: DeviceLease) => void;
  refresh: () => Promise<unknown>;
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const [approved, setApproved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"takeover" | "release" | null>(null);
  const owned = Boolean(lease && session?.id === lease.sessionId && session.state === "active" && session.expiresAt > Date.now());
  const touch = Boolean(device?.capabilities.includes("touch"));
  const controlling = owned && approved === session?.id && touch;
  const endpoint = source.kind === "usb" ? `/v1/source-preview/${encodeURIComponent(source.id)}` : `/v1/preview/${encodeURIComponent(source.deviceId!)}`;
  const getSnapshot = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(endpoint, { signal, cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.message || "Snapshot unavailable.");
    }
    return response.blob();
  }, [endpoint]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); setConfirm(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { await refresh(); setBusy(false); }
  };
  const start = () => {
    if (!device) return;
    if (session && !owned) { setConfirm("takeover"); return; }
    void run(async () => {
      if (owned && lease) { setApproved(lease.sessionId); return; }
      const result = await api<DeviceLease>("sessions.reserve", {
        selector: { device: device.id }, owner, reason: "Touch control from live feed",
      });
      onLease(result); setApproved(result.session.id);
    });
  };
  return <div className="feed-preview-workspace">
    <LivePreview
      name={source.name}
      deviceId={controlling ? device?.id : source.kind === "native" ? source.deviceId : undefined}
      sourceId={!controlling && source.kind === "usb" ? source.id : undefined}
      operation={api}
      getSnapshot={getSnapshot}
      controlLease={controlling && !device?.locked ? lease : null}
      inputEnabled={!busy && !confirm && Boolean(device?.online)}
    />
    {device && touch && <div className="feed-session-bar" aria-label={`Touch controls for ${device.name}`}>
      <div className="feed-session-summary"><strong>{controlling ? "Touch control on this feed" : "Touch control"}</strong><span>{session ? `${owned ? "Your reservation" : "Reserved"} · ${session.owner}` : "Start a session to interact with the screen."}</span></div>
      {!session && <input aria-label={`Control session owner for ${device.name}`} value={owner} placeholder="Session owner" maxLength={128} onChange={(event) => setOwner(event.target.value)} />}
      {!controlling && <button type="button" className="primary" disabled={busy || !device.online || device.locked || !owner.trim() || Boolean(session && session.state !== "active")} onClick={start}>{session && !owned ? "Take over control…" : "Start control session"}</button>}
      {owned && <button type="button" disabled={busy} onClick={() => setConfirm("release")}>End session…</button>}
      {error && <p role="alert" className="feed-session-error">{error}</p>}
      {confirm && <div className="feed-session-confirm" role="alertdialog" aria-label="Confirm feed session change">
        <strong>{confirm === "takeover" ? `Take over ${device.name} from ${session?.owner}?` : "End this control session?"}</strong>
        <p>{recording ? "The recording will stop and save before this session ends. " : ""}{confirm === "takeover" ? "The current reservation will end before you take control." : "Touch and remote input will stop until another session starts."}</p>
        {confirm === "takeover" && <input aria-label="New session owner" value={owner} maxLength={128} onChange={(event) => setOwner(event.target.value)} />}
        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className="danger" disabled={busy || (confirm === "takeover" && !owner.trim())} onClick={() => void run(async () => {
          if (confirm === "takeover") {
            const result = await api<DeviceLease>("sessions.takeover", { deviceId: device.id, owner, reason: "Touch control from live feed", confirmed: true });
            onLease(result); setApproved(result.session.id);
          } else {
            await api("sessions.release", lease); setApproved(null);
          }
        })}>{confirm === "takeover" ? "End session & take control" : "End session"}</button>
      </div>}
    </div>}
  </div>;
}
