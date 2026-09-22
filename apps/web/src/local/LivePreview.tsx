import React, { useEffect, useId, useRef, useState } from "react";
import { Monitor, RefreshCw } from "lucide-react";
import type { Device, Operation } from "../../../../packages/core/src/local/types";
import type { GestureCapability, PointerInput, StreamAnswer } from "../../../../packages/core/src/live";
import { completedGesture, framePoint, PointerQueue, type FramePoint } from "./live-input";
import { TouchFeedback, touchFeedbackPoint, type TouchTrace } from "./touch-feedback";
import { PhoneHardwareControls } from "./PhoneHardwareControls";
import "./live-preview.css";

export type LiveLease = { sessionId: string; leaseToken: string };
export type LiveOperation = <T = unknown>(name: Operation, args?: unknown, signal?: AbortSignal) => Promise<T>;
type OpenedStream = StreamAnswer;
export type LiveConnectionState = "connecting" | "ready" | "reconnecting" | "disconnected" | "error";
type ConnectionState = LiveConnectionState;
type Contact = { start: FramePoint; last: FramePoint; startedAt: number };
type VideoBox = { left: number; top: number; width: number; height: number };

export function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); signal.removeEventListener("abort", aborted); };
    const changed = () => { if (peer.iceGatheringState === "complete") { clean(); resolve(); } };
    const aborted = () => { clean(); reject(signal.reason); };
    const timer = setTimeout(() => { clean(); reject(new Error("Timed out preparing the video connection.")); }, 8000);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}

export function LivePreview({ name, deviceId, sourceId, operation, getSnapshot, active = true, controlLease, controlDevice, inputEnabled = true, onConnectionStateChange }: {
  name: string;
  deviceId?: string;
  sourceId?: string;
  operation: LiveOperation;
  getSnapshot: (signal: AbortSignal) => Promise<Blob>;
  active?: boolean;
  controlLease?: LiveLease | null;
  controlDevice?: Device;
  inputEnabled?: boolean;
  onConnectionStateChange?: (state: LiveConnectionState) => void;
}) {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [controlError, setControlError] = useState("");
  const [mode, setMode] = useState<"live" | "snapshots">("live");
  const [snapshotMode, setSnapshotMode] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState("");
  const [profile, setProfile] = useState<"low" | "balanced" | "high">("balanced");
  const [generation, setGeneration] = useState(0);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [capabilities, setCapabilities] = useState<GestureCapability[]>([]);
  const [channelReady, setChannelReady] = useState(false);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [supportsInputBarrier, setSupportsInputBarrier] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const feedback = useRef(new TouchFeedback());
  const [touchTraces, setTouchTraces] = useState<TouchTrace[]>([]);
  const [videoBox, setVideoBox] = useState<VideoBox>({ left: 0, top: 0, width: 0, height: 0 });
  const feedbackFrame = useRef<number | null>(null);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);
  const playbackReady = useRef<() => void>(() => {});
  const channel = useRef<RTCDataChannel | null>(null);
  const contacts = useRef(new Map<number, Contact>());
  const fail = useRef<(message: string) => void>(() => {});
  const queue = useRef<PointerQueue | null>(null);
  const barrierSequence = useRef(0);
  const hardwareBarrier = useRef<{ id: string; resolve(): void; reject(reason: unknown): void } | null>(null);
  const controlsReady = Boolean(active && visible && controlLease && inputEnabled && state === "ready" && channelReady && !snapshotMode);
  const isControlling = controlsReady && !hardwareBusy;
  const latest = useRef({ getSnapshot, isControlling, capabilities });
  latest.current = { getSnapshot, isControlling, capabilities };
  const connectionListener = useRef(onConnectionStateChange);
  connectionListener.current = onConnectionStateChange;
  useEffect(() => { connectionListener.current?.(state); }, [state]);
  useEffect(() => { setControlError(""); }, [deviceId, sourceId]);
  useEffect(() => { if (controlLease) setControlError(""); }, [controlLease?.sessionId, controlLease?.leaseToken]);

  const publishFeedback = () => {
    if (feedbackFrame.current !== null) return;
    feedbackFrame.current = requestAnimationFrame(() => { feedbackFrame.current = null; setTouchTraces(feedback.current.snapshot()); });
  };
  const measureVideo = () => {
    const media = video.current;
    if (!media) return;
    const box = { left: media.offsetLeft, top: media.offsetTop, width: media.clientWidth, height: media.clientHeight };
    setVideoBox((previous) => Object.keys(box).every((key) => previous[key as keyof VideoBox] === box[key as keyof VideoBox]) ? previous : box);
  };
  const cancelInput = () => {
    const hadContacts = contacts.current.size > 0;
    contacts.current.clear();
    queue.current?.reset();
    const dc = channel.current;
    if (hadContacts && dc?.readyState === "open" && dc.bufferedAmount < 64_000) {
      try { dc.send(JSON.stringify({ type: "cancel" })); } catch { /* Closing channels cannot accept cancellation. */ }
    }
  };
  const cancel = () => {
    cancelInput();
    feedback.current.clear();
    if (feedbackFrame.current !== null) cancelAnimationFrame(feedbackFrame.current);
    feedbackFrame.current = null;
    setTouchTraces([]);
  };
  const cancelGesture = () => {
    cancelInput();
    feedback.current.cancelActive(performance.now());
    publishFeedback();
  };
  const send = (message: unknown): boolean => {
    const dc = channel.current;
    if (!latest.current.isControlling || !navigator.onLine || dc?.readyState !== "open") return false;
    if (dc.bufferedAmount > 64_000) { fail.current("Control connection is congested. Reconnect before sending more input."); return false; }
    try { dc.send(JSON.stringify(message)); return true; }
    catch { fail.current("Control connection closed. Reconnect to continue."); return false; }
  };
  const prepareHardwareInput = (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    latest.current.isControlling = false;
    cancel();
    const dc = channel.current;
    if (dc?.readyState !== "open" || dc.bufferedAmount > 64_000) return Promise.reject(new Error("The control connection is unavailable. Reconnect before sending a phone button."));
    const id = `hardware-${++barrierSequence.current}`;
    // The receipt travels behind every earlier gesture on the ordered channel.
    // Only then may HTTP hardware input cancel/wait for those gestures safely.
    return new Promise<void>((resolve, reject) => {
      const finish = (failure?: unknown) => {
        if (hardwareBarrier.current?.id !== id) return;
        hardwareBarrier.current = null;
        signal.removeEventListener("abort", aborted);
        if (failure) reject(failure); else resolve();
      };
      const aborted = () => finish(signal.reason || new DOMException("Cancelled", "AbortError"));
      hardwareBarrier.current = { id, resolve: () => finish(), reject: (reason) => finish(reason) };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try { dc.send(JSON.stringify({ type: "input-barrier", id })); }
      catch (failure) { finish(failure); }
    });
  };
  if (!queue.current) queue.current = new PointerQueue((event) => send({ type: "pointer", event }));

  useEffect(() => {
    const hidden = () => { if (document.hidden) { latest.current.isControlling = false; cancel(); } setVisible(!document.hidden); };
    window.addEventListener("blur", cancel);
    window.addEventListener("offline", cancel);
    document.addEventListener("visibilitychange", hidden);
    const moves = setInterval(() => {
      if (queue.current?.flush() === false) cancel();
      if (feedback.current.prune(performance.now())) publishFeedback();
    }, 32);
    return () => { cancel(); clearInterval(moves); window.removeEventListener("blur", cancel); window.removeEventListener("offline", cancel); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  useEffect(() => { if (!isControlling) cancel(); }, [isControlling, controlLease?.sessionId, controlLease?.leaseToken]);
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    measureVideo();
    const observer = new ResizeObserver(measureVideo);
    observer.observe(media);
    return () => observer.disconnect();
  }, [snapshotMode]);

  useEffect(() => {
    if (!active || snapshotMode) return;
    const abort = new AbortController();
    let peer: RTCPeerConnection | undefined;
    let dataChannel: RTCDataChannel | undefined;
    let credentials: { id: string; token: string } | undefined;
    let closed = false;
    let pinging = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    let disconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let media: MediaStream | undefined;
    let receivedFrame = false;
    setState("connecting"); setError(""); setCapabilities([]); setChannelReady(false); setSupportsInputBarrier(false);
    const ready = () => {
      if (closed || !media || video.current?.srcObject !== media || video.current.readyState < 2) return;
      receivedFrame = true;
      setHasVideoFrame(true);
      if (peer?.connectionState === "connected") {
        clearTimeout(connectTimeout); clearTimeout(disconnectTimeout); disconnectTimeout = undefined;
        setState("ready"); setError("");
      }
    };
    playbackReady.current = ready;
    const close = () => {
      if (closed) return;
      closed = true;
      hardwareBarrier.current?.reject(new Error("The control connection closed before the phone button could be sent."));
      cancel(); abort.abort(); clearInterval(heartbeat); clearTimeout(connectTimeout); clearTimeout(disconnectTimeout);
      if (channel.current === dataChannel) channel.current = null;
      if (playbackReady.current === ready) playbackReady.current = () => {};
      peer?.close();
      // Retain the last displayed frame during a touch/profile handoff. Closing
      // this peer stops its tracks; the next peer's ontrack replaces the media.
      if (credentials) void operation("streams.close", credentials, AbortSignal.timeout(5000)).catch(() => {});
    };
    const failed = (message: string) => { if (closed) return; setState("error"); setError(message); setChannelReady(false); close(); };
    fail.current = failed;
    const start = async () => {
      try {
        if (typeof RTCPeerConnection === "undefined") throw new Error("This browser does not support live video. Use snapshot preview below.");
        peer = new RTCPeerConnection({ iceServers: [] });
        peer.addTransceiver("video", { direction: "recvonly" });
        const dc = peer.createDataChannel("control", { ordered: true });
        dataChannel = dc;
        channel.current = dc;
        dc.onopen = () => { if (!closed) setChannelReady(true); };
        dc.onclose = () => { if (!closed) failed("Live control connection closed. Reconnect to continue."); };
        dc.onerror = () => failed("Live control connection failed.");
        dc.onmessage = ({ data }) => {
          if (closed || typeof data !== "string") return;
          try {
            const message = JSON.parse(data);
            if (message.type === "input-barrier" && message.id === hardwareBarrier.current?.id) hardwareBarrier.current?.resolve();
            if (message.type === "ready" && Array.isArray(message.capabilities)) setCapabilities(message.capabilities);
            if (message.type === "error") {
              const reason = typeof message.message === "string" ? message.message : "Device rejected the gesture.";
              // The parent disarms touch on error and reconnects as view only.
              // Keep this reason visible until the user explicitly enables it again.
              if (controlLease) setControlError(reason);
              failed(reason);
            }
            if (message.type === "geometry") cancel();
          } catch { failed("The device sent an invalid control message."); }
        };
        peer.ontrack = ({ track, streams }) => {
          if (closed || !video.current) return;
          media = streams[0] || new MediaStream([track]);
          receivedFrame = false;
          video.current.srcObject = media;
          void video.current.play().catch(() => { if (!closed) setError("Tap the video to start playback."); });
          track.onended = () => failed("The device video source stopped.");
        };
        peer.onconnectionstatechange = () => {
          if (closed) return;
          if (peer?.connectionState === "failed") failed("Video could not connect. Check that this browser can reach the machine over the LAN or Tailscale.");
          else if (peer?.connectionState === "disconnected") {
            // A short ICE interruption may recover on this same connection.
            // Pause input immediately without forcing a parent lease teardown.
            latest.current.isControlling = false; cancel(); setState("reconnecting");
            disconnectTimeout ??= setTimeout(() => failed("Video did not reconnect. Check the network, then reconnect the feed."), 5000);
          } else if (peer?.connectionState === "connected") {
            clearTimeout(disconnectTimeout); disconnectTimeout = undefined;
            if (receivedFrame) ready();
          }
        };
        await peer.setLocalDescription(await peer.createOffer());
        await waitForIce(peer, abort.signal);
        const result = await operation<OpenedStream>("streams.open", {
          ...(deviceId ? { deviceId } : { sourceId }), offer: peer.localDescription!.sdp, profile,
          control: Boolean(controlLease), ...(controlLease || {}),
        }, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]));
        // Signaling may finish after this viewer unmounted or changed devices.
        if (closed) { void operation("streams.close", { id: result.id, token: result.token }, AbortSignal.timeout(5000)).catch(() => {}); return; }
        credentials = { id: result.id, token: result.token };
        setMode(result.mode); setCapabilities(result.capabilities); setSupportsInputBarrier(result.supportsInputBarrier === true);
        await peer.setRemoteDescription({ type: "answer", sdp: result.answer });
        if (closed) return;
        connectTimeout = setTimeout(() => {
          if (!receivedFrame || peer?.connectionState !== "connected") failed("No video arrived from the machine. Reconnect or use snapshot preview.");
        }, 20_000);
        heartbeat = setInterval(() => {
          if (closed || pinging) return;
          pinging = true;
          void operation("streams.ping", credentials, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])).catch((failure) => failed((failure as Error).message)).finally(() => { pinging = false; });
        }, 5000);
      } catch (failure) { if (!closed) failed((failure as Error).message); }
    };
    void start();
    return close;
  }, [active, snapshotMode, deviceId, sourceId, operation, profile, generation, controlLease?.sessionId, controlLease?.leaseToken]);

  useEffect(() => {
    if (!snapshotMode || !active) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let url = "";
    setState("connecting"); setError("");
    const update = async () => {
      try {
        const blob = await latest.current.getSnapshot(AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        if (abort.signal.aborted) return;
        if (!/^image\/(png|jpeg|webp)/.test(blob.type)) throw new Error("The machine returned an unsupported snapshot.");
        const next = URL.createObjectURL(blob);
        if (url) URL.revokeObjectURL(url);
        url = next; setSnapshotUrl(next); setState("ready"); setError("");
      } catch (failure) { if (!abort.signal.aborted) { setError((failure as Error).message); setState("error"); } }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => void update(), 1000); }
    };
    void update();
    return () => { abort.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); setSnapshotUrl(""); };
  }, [snapshotMode, active, deviceId, sourceId]);

  const pointFor = (event: React.PointerEvent<HTMLVideoElement>) => {
    const media = video.current;
    return media ? framePoint(media.getBoundingClientRect(), media.videoWidth, media.videoHeight, event.clientX, event.clientY) : null;
  };
  const pointer = (type: PointerInput["type"], event: React.PointerEvent<HTMLVideoElement>) => {
    if (!latest.current.isControlling || !navigator.onLine || !touchAvailable) return;
    if (type === "down" && event.button !== 0) return;
    const continuous = capabilities.includes("drag");
    const contact = contacts.current.get(event.pointerId);
    const point = pointFor(event);
    if (type === "down") {
      if (!point || (contacts.current.size && !capabilities.includes("multitouch"))) return;
      event.preventDefault();
      if (continuous && !queue.current?.push({ type, contactId: event.pointerId, ...point })) { cancel(); return; }
      contacts.current.set(event.pointerId, { start: point, last: point, startedAt: performance.now() });
      event.currentTarget.setPointerCapture(event.pointerId);
      measureVideo();
      feedback.current.start(event.pointerId, point);
      publishFeedback();
      return;
    }
    if (!contact) return;
    event.preventDefault();
    if (type === "cancel" || !point) { cancelGesture(); return; }
    if (point.width !== contact.start.width || point.height !== contact.start.height) { cancel(); return; }
    contact.last = point;
    if (continuous && !queue.current?.push({ type, contactId: event.pointerId, ...point })) { cancel(); return; }
    feedback.current.move(event.pointerId, point);
    if (type === "up") {
      contacts.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!continuous) {
        const gesture = completedGesture(contact.start, point, performance.now() - contact.startedAt);
        if (!capabilities.includes(gesture.type)) {
          feedback.current.finish(event.pointerId, "rejected", performance.now());
          publishFeedback();
          return;
        }
        if (!send({ type: "gesture", gesture })) { cancel(); return; }
      }
      feedback.current.finish(event.pointerId, "released", performance.now());
    }
    publishFeedback();
  };
  const touchAvailable = capabilities.some((capability) => ["tap", "swipe", "longPress", "drag"].includes(capability));
  const gestureNotice = touchTraces.some(({ phase }) => phase === "rejected") ? "Gesture unavailable for this device. " : touchTraces.some(({ phase }) => phase === "cancelled") ? "Touch cancelled. " : "";
  const label = !active || !visible ? "Preview paused" : state === "ready" ? snapshotMode ? "Snapshot preview · view only" : mode === "snapshots" ? "Limited-refresh video · simulator snapshots" : "Live video · H.264 · silent" : state === "connecting" ? snapshotMode ? "Loading snapshot…" : "Connecting to live video…" : state === "reconnecting" ? "Connection interrupted · reconnecting…" : snapshotMode ? "Snapshot unavailable" : "Video disconnected";
  return <><div className={`deck-live-preview live-screen ${isControlling && touchAvailable ? "deck-touch-enabled" : ""}`}>
    {snapshotMode ? snapshotUrl && <img src={snapshotUrl} alt={`Snapshot of ${name}`} /> : <video ref={video} autoPlay muted playsInline aria-label={`Live video of ${name}`} onPlaying={() => playbackReady.current()} onResize={() => { cancel(); measureVideo(); }} onPointerDown={(event) => pointer("down", event)} onPointerMove={(event) => pointer("move", event)} onPointerUp={(event) => pointer("up", event)} onPointerCancel={(event) => pointer("cancel", event)} onLostPointerCapture={(event) => { if (contacts.current.has(event.pointerId)) cancelGesture(); }} onContextMenu={(event) => { if (isControlling) event.preventDefault(); }} onClick={() => { if (video.current?.paused) void video.current.play(); }} />}
    {isControlling && touchAvailable && touchTraces.length > 0 && <TouchOverlay traces={touchTraces} box={videoBox} />}
    {(state !== "ready" || !active || !visible) && <div className={`deck-live-placeholder ${hasVideoFrame && !snapshotMode && active && visible ? "has-frame" : ""}`} role="status"><Monitor size={28} /><strong>{label}</strong>{error && <span>{error}</span>}{(state === "error" || state === "disconnected") && <div className="deck-live-recovery"><button type="button" onClick={() => { setSnapshotMode(false); setGeneration((value) => value + 1); }}><RefreshCw size={14} />Reconnect video</button>{!snapshotMode && <button type="button" onClick={() => setSnapshotMode(true)}>Use snapshot preview</button>}</div>}</div>}
    <div className="deck-live-status"><span>{label}</span>{!snapshotMode && <label>Quality<select aria-label={`Video quality for ${name}`} value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}><option value="low">Low bandwidth</option><option value="balanced">Balanced</option><option value="high">High detail</option></select></label>}{snapshotMode && <button type="button" onClick={() => { setSnapshotMode(false); setGeneration((value) => value + 1); }}>Try live video</button>}</div>
    {controlLease && state === "ready" && !snapshotMode && <div className="deck-touch-help" role="status">{hardwareBusy ? "Sending phone button…" : !inputEnabled ? "Touch paused while session options are open." : !channelReady ? "Connecting controls…" : touchAvailable ? `${gestureNotice}${capabilities.includes("drag") ? "Tap, drag and scroll" : "Tap, swipe or hold, then release"}${capabilities.includes("multitouch") ? " · two-finger pinch" : ""}` : "Touch input is unavailable for this device. Check its input tools and reconnect."}</div>}
    {controlError && !controlLease && <div className="deck-live-error" role="alert">Touch stopped: {controlError}</div>}
    {state === "ready" && error && <div className="deck-live-error" role="alert">{error}</div>}
  </div>
    {controlDevice && controlLease && <PhoneHardwareControls device={controlDevice} lease={controlLease} operation={operation} enabled={controlsReady && touchAvailable && supportsInputBarrier} unavailableReason={state === "ready" && !snapshotMode && !supportsInputBarrier ? "Update Device Deck on this machine to use phone buttons." : undefined} onBeforeInput={prepareHardwareInput} onBusyChange={setHardwareBusy} />}
  </>;
}

function TouchOverlay({ traces, box }: { traces: TouchTrace[]; box: VideoBox }) {
  const clipId = useId();
  const frame = traces[0]?.points[0];
  if (box.width <= 0 || box.height <= 0 || !frame) return null;
  const topLeft = touchFeedbackPoint(box.width, box.height, { ...frame, x: 0, y: 0 });
  const bottomRight = touchFeedbackPoint(box.width, box.height, { ...frame, x: frame.width, y: frame.height });
  if (!topLeft || !bottomRight) return null;
  return <svg className="deck-touch-feedback" aria-hidden="true" focusable="false" style={box} viewBox={`0 0 ${box.width} ${box.height}`}>
    <defs><clipPath id={clipId}><rect x={topLeft.x} y={topLeft.y} width={bottomRight.x - topLeft.x} height={bottomRight.y - topLeft.y} /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}>{traces.map((trace) => {
      const points = trace.points.map((point) => touchFeedbackPoint(box.width, box.height, point)).filter((point) => point !== null);
      const start = points[0], end = points[points.length - 1];
      if (!start || !end) return null;
      const interrupted = trace.phase === "cancelled" || trace.phase === "rejected";
      return <g key={trace.key} className="deck-touch-trace" data-touch-phase={trace.phase} data-contact-id={trace.contactId}>
        {points.length > 1 && <><polyline className="deck-touch-trail-shadow" points={points.map(({ x, y }) => `${x},${y}`).join(" ")} /><polyline className="deck-touch-trail" points={points.map(({ x, y }) => `${x},${y}`).join(" ")} /><circle className="deck-touch-origin" cx={start.x} cy={start.y} r="4" /></>}
        <g className="deck-touch-endpoint" transform={`translate(${end.x} ${end.y})`}>
          <circle className="deck-touch-ring" r="16" />
          <circle className="deck-touch-contact" r="9" />
          {interrupted && <path className="deck-touch-cross" d="M-4-4 4 4 M4-4-4 4" />}
        </g>
      </g>;
    })}</g>
  </svg>;
}
