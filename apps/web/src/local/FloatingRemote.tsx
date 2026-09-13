import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Menu, X } from "lucide-react";
export function FloatingRemote({
  title,
  initialMenu = false,
  storageKey,
  requestKey,
  onClose,
  children,
}: {
  title: string;
  storageKey: string;
  requestKey: object;
  initialMenu?: boolean;
  onClose: () => void;
  children: (
    menu: boolean,
    setMenu: (open: boolean) => void,
  ) => React.ReactNode;
}) {
  const saved = useRef<{
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }>({});
  const loaded = useRef(false);
  if (!loaded.current) {
    try {
      saved.current = JSON.parse(
        localStorage.getItem(`deck-remote-position-${storageKey}`) || "{}",
      );
    } catch {}
    loaded.current = true;
  }
  const [size, setSize] = useState(() => ({
    width: Math.max(260, Math.min(520, Number(saved.current.width) || 300)),
    height: Math.max(
      275,
      Math.min(innerHeight, Number(saved.current.height) || 302),
    ),
  }));
  const panel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(initialMenu);
  const [host, setHost] = useState<Element>(
    document.fullscreenElement || document.body,
  );
  const [position, setPosition] = useState(() => ({
    x: Math.max(
      0,
      Math.min(
        Number(saved.current.x ?? innerWidth - 320),
        innerWidth - size.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(Number(saved.current.y ?? 120), innerHeight - size.height),
    ),
  }));
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    setMenu(initialMenu);
  }, [initialMenu, requestKey]);
  useEffect(() => {
    localStorage.setItem(
      `deck-remote-position-${storageKey}`,
      JSON.stringify({ ...position, ...size }),
    );
  }, [position, size, storageKey]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!panel.current) return;
      const { width, height } = panel.current.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height },
      );
    });
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    const fit = () =>
      setPosition((p) => ({
        x: Math.max(
          0,
          Math.min(
            p.x,
            innerWidth -
              Math.min(panel.current?.offsetWidth || 300, innerWidth),
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            p.y,
            innerHeight -
              Math.min(panel.current?.offsetHeight || 330, innerHeight),
          ),
        ),
      }));
    const fullscreen = () => {
      setHost(document.fullscreenElement || document.body);
      fit();
    };
    window.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, []);
  return createPortal(
    <div
      ref={panel}
      role="region"
      aria-label={`Remote for ${title}`}
      className={`floating-remote ${menu ? "options-open" : ""}`}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      <header
        className="floating-remote-bar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: position.x,
            top: position.y,
          };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPosition({
            x: Math.max(
              0,
              Math.min(
                innerWidth - (panel.current?.offsetWidth || 300),
                drag.current.left + e.clientX - drag.current.x,
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                innerHeight - (panel.current?.offsetHeight || 330),
                drag.current.top + e.clientY - drag.current.y,
              ),
            ),
          });
        }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <GripVertical size={14} />
        <strong title={title}>{title}</strong>
        <button
          type="button"
          aria-label="Remote menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <Menu size={17} />
        </button>
        <button type="button" aria-label="Close remote" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="floating-remote-body">{children(menu, setMenu)}</div>
    </div>,
    host,
  );
}
