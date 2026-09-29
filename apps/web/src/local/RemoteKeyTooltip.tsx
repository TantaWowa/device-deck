import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const remoteShortcuts: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  OK: "Enter",
  Back: "B",
  Home: "H",
  Play: "Space",
  Rewind: "R",
  FastForward: "F",
  Replay: "P",
  Special: "S",
  Backspace: "Backspace",
};
export type RemoteTooltip = {
  element: HTMLButtonElement;
  label: string;
  shortcut?: string;
  unavailable: boolean;
};

export function RemoteKeyTooltip({
  id,
  tooltip,
}: {
  id: string;
  tooltip: RemoteTooltip;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [host, setHost] = useState<Element>(
    () =>
      tooltip.element.closest("dialog[open]") ||
      document.fullscreenElement ||
      document.body,
  );
  useLayoutEffect(() => {
    const place = () => {
      const anchor = tooltip.element.getBoundingClientRect();
      const width = ref.current?.offsetWidth || 180;
      const height = ref.current?.offsetHeight || 32;
      setPosition({
        left: Math.max(
          6,
          Math.min(
            innerWidth - width - 6,
            anchor.left + (anchor.width - width) / 2,
          ),
        ),
        top: Math.max(
          6,
          Math.min(
            innerHeight - height - 6,
            anchor.top - height - 7 >= 6
              ? anchor.top - height - 7
              : anchor.bottom + 7,
          ),
        ),
        ready: true,
      });
    };
    const fullscreen = () =>
      setHost(
        tooltip.element.closest("dialog[open]") ||
          document.fullscreenElement ||
          document.body,
      );
    place();
    const observer = new ResizeObserver(place);
    observer.observe(tooltip.element);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [tooltip, host]);
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="remote-key-tooltip"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
    >
      <span>{tooltip.label}</span>
      {tooltip.shortcut && <kbd>{tooltip.shortcut}</kbd>}
      {tooltip.unavailable && <small>Unavailable with this connection</small>}
    </div>,
    host,
  );
}
