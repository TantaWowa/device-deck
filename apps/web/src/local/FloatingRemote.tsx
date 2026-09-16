import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Menu, X } from "lucide-react";
import { clampPopup } from "../../../../packages/ui/src/popup-position";
import { useAnchoredPopup, type PopupAnchor } from "./anchored-popup";
import "./anchored-popup.css";
import "./mobile-remote.css";
export function FloatingRemote({
  title,
  initialMenu = false,
  storageKey,
  requestKey,
  anchor,
  onClose,
  children,
}: {
  title: string;
  storageKey: string;
  requestKey: object;
  anchor?: PopupAnchor | null;
  initialMenu?: boolean;
  onClose: () => void;
  children: (
    menu: boolean,
    setMenu: (open: boolean) => void,
  ) => React.ReactNode;
}) {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 640px)");
    const changed = () => setMobile(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const saved = useRef<{
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
  const [menu, setMenu] = useState(initialMenu);
  const previousRequest = useRef(requestKey);
  const { panel, host, position, setPosition, detach } = useAnchoredPopup({
    anchor,
    requestKey,
    fallbackSize: size,
  });
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current
      ?.querySelector<HTMLButtonElement>('[aria-label="Close remote"]')
      ?.focus({ preventScroll: true });
    // The remote's window capture listener gets Escape first to release keyboard input.
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog[open],.anchored-popover")
      )
        return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const target = anchor?.element.isConnected ? anchor.element : previous;
      if (target instanceof HTMLElement && target.isConnected)
        target.focus({ preventScroll: true });
    };
  }, [anchor, requestKey, host]);
  useEffect(() => {
    // Inventory updates must not reopen the menu after this popup reserves a device.
    if (previousRequest.current === requestKey) return;
    previousRequest.current = requestKey;
    setMenu(initialMenu);
  }, [initialMenu, requestKey]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `deck-remote-position-${storageKey}`,
        JSON.stringify(size),
      );
    } catch {}
  }, [size, storageKey]);
  useEffect(() => {
    if (mobile) return;
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
  }, [host, mobile]);
  return createPortal(
    <div
      ref={panel}
      role="region"
      tabIndex={-1}
      aria-label={`Remote for ${title}`}
      className={`floating-remote anchored-remote ${menu ? "options-open" : ""}`}
      data-mobile-sheet={mobile}
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
          if (mobile) return;
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          detach();
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
          setPosition(
            clampPopup(
              {
                x: drag.current.left + e.clientX - drag.current.x,
                y: drag.current.top + e.clientY - drag.current.y,
              },
              {
                width: panel.current?.offsetWidth || size.width,
                height: panel.current?.offsetHeight || size.height,
              },
              { width: innerWidth, height: innerHeight },
            ),
          );
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
