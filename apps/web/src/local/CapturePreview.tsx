import React, { useState, useEffect } from "react";
import { Monitor } from "lucide-react";
export function CapturePreview({
  name,
  endpoint,
  active = true,
  intervalMs = 1000,
}: {
  name: string;
  endpoint: string;
  active?: boolean;
  intervalMs?: number;
}) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    setSrc("");
    setError("");
    const controller = new AbortController();
    let done = false,
      url = "",
      timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      let delay = intervalMs;
      try {
        const r = await fetch(endpoint, { signal: controller.signal });
        if (!r.ok) {
          const e = await r.json();
          throw new Error(e.message);
        }
        const blob = await r.blob();
        if (done) return;
        const next = URL.createObjectURL(blob);
        if (url) URL.revokeObjectURL(url);
        url = next;
        setSrc(next);
        setError("");
      } catch (e) {
        delay = 3000;
        if (!done) setError((e as Error).message);
      } finally {
        if (!done) timer = setTimeout(update, delay);
      }
    };
    void update();
    return () => {
      done = true;
      controller.abort();
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [endpoint, active, intervalMs]);
  return (
    <div className="live-screen">
      {src && !error ? (
        <img src={src} alt={`Live screen of ${name}`} />
      ) : (
        <div className="live-screen-message">
          <Monitor size={32} />
          <strong>{error || "Connecting to capture input…"}</strong>
          <span>
            Check the HDMI signal, capture card and macOS camera permission.
          </span>
        </div>
      )}
      <span className="live-screen-label">
        {intervalMs < 1000
          ? "Live USB · up to 10 fps · silent"
          : "Local capture · refreshes about once a second"}
      </span>
    </div>
  );
}
