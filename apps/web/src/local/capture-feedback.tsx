import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Film, X } from "lucide-react";
import type { Artifact } from "../../../../packages/core/src/local/types";
import { CaptureCompletionTracker } from "../../../../packages/core/src/capture-feedback";
export { copyImageToClipboard } from "../../../../packages/ui/src/capture-clipboard";
import "./capture-feedback.css";

export type CaptureToast = { artifact: Artifact; at: number };
export function useCaptureFeedback(artifacts: Artifact[] | undefined) {
  const tracker = useRef(new CaptureCompletionTracker());
  const [toasts, setToasts] = useState<CaptureToast[]>([]);
  const add = useCallback((items: Artifact[]) => {
    if (items.length) setToasts((current) => [...current, ...items.map(artifact => ({ artifact, at: Date.now() }))]);
  }, []);
  useEffect(() => { if (artifacts) add(tracker.current.update(artifacts)); }, [artifacts, add]);
  const completed = useCallback((artifact: Artifact) => {
    const item = tracker.current.completed(artifact);
    if (item) add([item]);
  }, [add]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter(item => item.artifact.id !== id)), []);
  return { toasts, dismiss, completed };
}

function CaptureToastItem({ toast, dismiss, onOpen }: { toast: CaptureToast; dismiss: (id: string) => void; onOpen: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const { artifact: a } = toast;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(a.id), 20_000);
    return () => clearTimeout(timer);
  }, [paused, dismiss, a.id]);
  return <div className="capture-toast" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    {a.kind === "screenshot" ? <Camera size={20} /> : <Film size={20} />}
    <div><strong>{a.kind === "screenshot" ? "Screenshot" : "Recording"} {a.status === "failed" ? "failed" : a.status === "interrupted" ? "saved with interruption" : "saved"}</strong>
      <a href={`#capture=${encodeURIComponent(a.id)}`} onClick={(event) => { event.preventDefault(); onOpen(a.id); dismiss(a.id); }}>{a.name}</a>
      {a.status === "failed" && a.error && <small>{a.error}</small>}
    </div><button type="button" aria-label={`Dismiss notification for ${a.name}`} onClick={() => dismiss(a.id)}><X size={16} /></button>
  </div>;
}

export function CaptureToasts({ toasts, dismiss, onOpen }: { toasts: CaptureToast[]; dismiss: (id: string) => void; onOpen: (id: string) => void }) {
  return <aside className="capture-toasts" aria-label="Capture notifications" aria-live="polite" aria-relevant="additions">
    {toasts.map(toast => <CaptureToastItem key={toast.artifact.id} toast={toast} dismiss={dismiss} onOpen={onOpen} />)}
  </aside>;
}
