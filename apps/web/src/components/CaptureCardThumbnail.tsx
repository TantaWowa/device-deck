import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Monitor, X } from "lucide-react";
import { thumbnailRequests } from "../../../../packages/ui/src/thumbnail-requests";
import { popupAnchor, useAnchoredPopup, type PopupAnchor } from "../local/anchored-popup";
import "./capture-card-thumbnail.css";

function EnlargedThumbnail({ anchor, name, url, message, sample, close, enter, leave }: {
  anchor: PopupAnchor;
  name: string;
  url: string;
  message: string;
  sample: boolean;
  close: () => void;
  enter: () => void;
  leave: () => void;
}) {
  const key = useRef({});
  const title = useId();
  const { panel, host, position } = useAnchoredPopup({
    anchor, requestKey: key.current, fallbackSize: { width: 420, height: 286 },
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.element.contains(event.target)) close();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [anchor, close, panel]);
  return createPortal(<div ref={panel} className="capture-card-zoom" role="region" aria-labelledby={title}
    style={{ left: position.x, top: position.y }} onPointerEnter={enter}
    onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) leave(); }}
    onFocus={enter} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}>
    <header><strong id={title}>{name}</strong><button type="button" aria-label={`Close preview of ${name}`} onClick={close}><X size={16} /></button></header>
    <div className="capture-card-zoom-image">{url ? <img src={url} alt={`Enlarged ${sample ? "sample " : ""}preview of ${name}`} /> : <span>{message}</span>}</div>
    <small>{sample ? "Simulated preview" : message || "Snapshot preview"}</small>
  </div>, host);
}

/** One snapshot on entry; a later hover can refresh it. No recurring video or polling. */
export function CaptureCardThumbnail({ name, endpoint, unavailable = "", refreshKey = 0, paused = false, sample = false }: {
  name: string;
  endpoint?: string;
  unavailable?: string;
  refreshKey?: number;
  paused?: boolean;
  sample?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const image = useRef("");
  const pending = useRef<AbortController | null>(null);
  const attemptedAt = useRef(0);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inView, setInView] = useState(false);
  const [foreground, setForeground] = useState(() => !document.hidden && navigator.onLine);
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null);
  const enabled = Boolean(endpoint && inView && foreground && !paused && !unavailable);
  const close = useCallback(() => { clearTimeout(leaveTimer.current); pinned.current = false; setAnchor(null); }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    if (button.current) observer.observe(button.current);
    const visibility = () => setForeground(!document.hidden && navigator.onLine);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", visibility);
    return () => {
      observer.disconnect(); clearTimeout(leaveTimer.current);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", visibility);
    };
  }, []);
  useEffect(() => {
    attemptedAt.current = 0;
    setUrl(""); setError("");
    return () => {
      pending.current?.abort(); pending.current = null;
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = "";
    };
  }, [endpoint, unavailable, refreshKey]);

  const load = useCallback(async () => {
    if (pending.current?.signal.aborted) { pending.current = null; attemptedAt.current = 0; }
    if (!enabled || !endpoint || pending.current || Date.now() - attemptedAt.current < 30_000) return;
    const controller = new AbortController();
    pending.current = controller; attemptedAt.current = Date.now(); setLoading(true);
    try {
      const blob = await thumbnailRequests.request(endpoint, async (signal) => {
        const response = await fetch(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]), cache: "no-store" });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || "Preview unavailable");
        }
        const value = await response.blob();
        if (!/^image\/(png|jpeg|webp)$/.test(value.type)) throw new Error("Preview unavailable");
        return value;
      }, controller.signal);
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = next; setUrl(next); setError("");
    } catch (failure) {
      if (controller.signal.aborted) { if (pending.current === controller) attemptedAt.current = 0; }
      else setError((failure as Error).message);
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [enabled, endpoint, refreshKey]);
  useEffect(() => {
    if (enabled) void load();
    else { pending.current?.abort(); close(); }
    return () => { pending.current?.abort(); };
  }, [enabled, load, close]);

  const open = () => {
    clearTimeout(leaveTimer.current);
    if (enabled && button.current && !anchor) { setAnchor(popupAnchor(button.current)); void load(); }
  };
  const enter = () => clearTimeout(leaveTimer.current);
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== button.current) setAnchor(null);
    }, 160);
  };
  const message = unavailable || error || (!foreground || paused ? "Preview paused" : loading ? "Loading preview…" : "Preview unavailable");
  return <>
    <button ref={button} type="button" className="capture-card-thumbnail" aria-label={`Enlarge preview of ${name}`}
      aria-expanded={Boolean(anchor)} disabled={Boolean(unavailable) || !endpoint || paused}
      title={unavailable || error || "Hover, focus or tap to enlarge"}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") open(); }} onPointerLeave={leave}
      onFocus={open} onBlur={leave} onClick={() => { if (pinned.current) close(); else { pinned.current = true; open(); } }}>
      {url ? <img src={url} alt={`${sample ? "Sample preview" : "Preview"} of ${name}`} /> : <span className="capture-card-thumbnail-empty"><Monitor size={19} /><span>{message}</span></span>}
      {url && <span className="capture-card-thumbnail-hint">{sample ? "Sample" : "Preview"}</span>}
    </button>
    {anchor && <EnlargedThumbnail anchor={anchor} name={name} url={url} message={url ? error : message} sample={sample} close={close} enter={enter} leave={leave} />}
  </>;
}
