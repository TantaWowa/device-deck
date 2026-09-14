import React, { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Maximize,
  Monitor,
} from "lucide-react";
import type { Source, Device } from "../../../../packages/core/src/local/types";
import { CapturePreview } from "./CapturePreview";

export function FeedViewer({
  sources,
  devices,
  renderActions,
}: {
  sources: Source[];
  devices: Device[];
  renderActions: (source: Source) => React.ReactNode;
}) {
  const query = new URLSearchParams(location.search);
  const cards = sources.filter((s) => s.kind === "usb");
  const [selected, setSelected] = useState<string[]>(() => {
    const ids = query.get("sources");
    return ids !== null
      ? ids.split(",").filter(Boolean)
      : cards.map((s) => s.id);
  });
  const [layout, setLayout] = useState(
    query.get("layout") === "single" ? "single" : "grid",
  );
  const [active, setActive] = useState(
    query.get("active") || selected[0] || "",
  );
  const [error, setError] = useState("");
  const viewer = useRef<HTMLDivElement>(null);
  const feeds = selected
    .map((id) => cards.find((s) => s.id === id))
    .filter((s): s is Source => Boolean(s));
  const index = Math.max(
    0,
    feeds.findIndex((s) => s.id === active),
  );
  const current = feeds[index];
  const move = (delta: number) => {
    if (feeds.length)
      setActive(feeds[(index + delta + feeds.length) % feeds.length].id);
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewer.current?.requestFullscreen();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.set("view", "feeds");
    params.set("layout", layout);
    params.set("sources", selected.join(","));
    if (current) params.set("active", current.id);
    else params.delete("active");
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }, [layout, selected.join(","), current?.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        document.querySelector("dialog[open]") ||
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        move(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        setLayout((l) => (l === "grid" ? "single" : "grid"));
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void fullscreen();
      } else if (/^[1-9]$/.test(event.key) && feeds[Number(event.key) - 1]) {
        event.preventDefault();
        setActive(feeds[Number(event.key) - 1].id);
        setLayout("single");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const visible = layout === "grid" ? feeds : current ? [current] : [];
  return (
    <div ref={viewer} className="feed-viewer">
      <div className="live-heading">
        <div>
          <span className="eyebrow">CAPTURE WORKSPACE</span>
          <h1>Live feeds</h1>
          <p>
            Choose your inputs, watch them together, or browse one at a time.
          </p>
        </div>
        <div className="live-actions">
          <button
            aria-pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
          >
            <Columns2 size={16} /> Split screen
          </button>
          <button
            aria-pressed={layout === "single"}
            onClick={() => setLayout("single")}
          >
            <Monitor size={16} /> Single feed
          </button>
          <button onClick={() => void fullscreen()}>
            <Maximize size={16} /> Fullscreen
          </button>
        </div>
      </div>
      <div className="feed-picker" aria-label="Choose capture feeds">
        {cards.map((s) => (
          <label key={s.id} title={s.uniqueId}>
            <input
              type="checkbox"
              checked={selected.includes(s.id)}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked
                    ? [...ids, s.id]
                    : ids.filter((id) => id !== s.id),
                )
              }
            />
            {s.name}
            <span
              className={
                s.status === "connected" ? "feed-connected" : "feed-missing"
              }
            >
              {s.status}
            </span>
          </label>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {selected.some((id) => !cards.some((s) => s.id === id)) && (
        <p role="status">
          Some selected feeds are no longer configured. Choose another input
          above.
        </p>
      )}
      <div className="feed-navigation">
        <button
          aria-label="Previous feed"
          disabled={feeds.length < 2}
          onClick={() => move(-1)}
        >
          <ChevronLeft size={20} />
        </button>
        <strong aria-live="polite">
          {current
            ? `${index + 1} / ${feeds.length} · ${current.name}`
            : "No feeds selected"}
        </strong>
        <button
          aria-label="Next feed"
          disabled={feeds.length < 2}
          onClick={() => move(1)}
        >
          <ChevronRight size={20} />
        </button>
        <span>← → switch · 1–9 open feed · G toggle grid · F fullscreen</span>
      </div>
      <div
        className={`feed-grid ${layout}`}
        style={
          {
            "--feed-rows":
              layout === "grid" ? Math.ceil(visible.length / 2) || 1 : 1,
            "--feed-count": visible.length || 1,
          } as React.CSSProperties
        }
      >
        {visible.map((s) => (
          <section
            key={s.id}
            className={`feed-tile ${current?.id === s.id ? "active" : ""}`}
          >
            <button
              className="feed-title"
              onClick={() => {
                setActive(s.id);
                setLayout("single");
              }}
              title="Open this feed"
            >
              <strong>{s.name}</strong>
              <span>
                {devices.find((d) => d.captureSourceId === s.id)?.name ||
                  "USB capture"}
              </span>
            </button>
            {s.status === "missing" ? (
              <div className="feed-offline">
                Capture card disconnected. Reconnect the same card to resume.
              </div>
            ) : (
              <CapturePreview
                name={s.name}
                endpoint={`/v1/source-preview/${encodeURIComponent(s.id)}`}
                intervalMs={100}
              />
            )}
            {renderActions(s)}
            <footer>{s.uniqueId}</footer>
          </section>
        ))}
      </div>
      {!visible.length && (
        <div className="live-empty">
          <Monitor size={36} />
          <h2>
            {cards.length
              ? "Choose a feed above"
              : "Register your capture cards"}
          </h2>
          <p>
            {cards.length
              ? "Select two or more inputs for split screen."
              : "Run devdeck feeds, then devdeck view --mux to register and open connected USB inputs."}
          </p>
        </div>
      )}
    </div>
  );
}
