import React, { useEffect, useRef, useState } from "react";
import { Camera, Film } from "lucide-react";
import type { Artifact } from "../../../../packages/core/src/local/types";
import { captureIsBusy } from "../../../../packages/core/src/capture-library";

export type CaptureThumbnailProps = {
  artifact: Artifact;
  thumbnailUrl?: (artifact: Artifact) => string;
  getThumbnail?: (artifact: Artifact, signal?: AbortSignal) => Promise<Blob>;
};

/** Load small library images only near the viewport, including authenticated portal requests. */
export function CaptureThumbnail({ artifact, thumbnailUrl, getThumbnail }: CaptureThumbnailProps) {
  const frame = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  const [image, setImage] = useState<{ key: string; url?: string; failed?: boolean }>();
  const [retry, setRetry] = useState<{ key: string; count: number }>();
  const loader = useRef(getThumbnail);
  loader.current = getThumbnail;
  const key = `${artifact.id}:${artifact.path}:${artifact.bytes}:${artifact.status}`;
  const available = !artifact.deletedAt && !artifact.purgedAt && !captureIsBusy(artifact);
  const direct = available ? thumbnailUrl?.(artifact) : undefined;
  const current = image?.key === key ? image : undefined;
  const attempt = retry?.key === key ? retry.count : 0;
  useEffect(() => {
    if (!frame.current) return;
    if (!globalThis.IntersectionObserver) { setNearby(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!nearby || !available) return;
    if (direct) {
      const url = new URL(direct, window.location.href);
      if (attempt) url.searchParams.set("thumbnailRetry", String(attempt));
      setImage({ key, url: url.href }); return;
    }
    if (!loader.current) { setImage({ key, failed: true }); return; }
    setImage({ key });
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void loader.current(artifact, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ key, url: objectUrl });
    }).catch(() => { if (!controller.signal.aborted) setImage({ key, failed: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key, direct, nearby, available, attempt]);
  useEffect(() => {
    if (!nearby || !available || !current?.failed || attempt >= 2) return;
    const timer = window.setTimeout(() => setRetry({ key, count: attempt + 1 }), attempt ? 1500 : 500);
    return () => clearTimeout(timer);
  }, [key, nearby, available, current?.failed, attempt]);
  const label = artifact.deletedAt ? "Restore to preview" : captureIsBusy(artifact)
    ? artifact.status === "recording" ? "Capturing…" : "Finalizing…"
    : current?.failed ? "Preview unavailable" : "Loading preview…";
  return <span ref={frame} className="capture-thumbnail">
    {available && current?.url && !current.failed
      ? <img src={current.url} alt={`Preview of ${artifact.name}`} loading="lazy" decoding="async" onError={() => setImage({ key, failed: true })} />
      : <span className="capture-thumbnail-placeholder">{artifact.kind === "recording" ? <Film size={23} /> : <Camera size={23} />}<span>{label}</span></span>}
  </span>;
}
