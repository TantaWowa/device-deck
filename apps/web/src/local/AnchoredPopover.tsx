import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAnchoredPopup, type PopupAnchor } from "./anchored-popup";
import "./anchored-popup.css";

export function AnchoredPopover({
  title,
  anchor,
  onClose,
  children,
}: {
  title: string;
  anchor?: PopupAnchor | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const requestKey = useRef({});
  const close = useRef(onClose);
  close.current = onClose;
  const { panel, host, position } = useAnchoredPopup({
    anchor,
    requestKey: requestKey.current,
    fallbackSize: { width: 440, height: 500 },
  });
  useEffect(() => {
    const previous = document.activeElement;
    panel.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close.current();
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !anchor?.element.contains(event.target)
      )
        close.current();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
      const target = anchor?.element.isConnected ? anchor.element : previous;
      if (target instanceof HTMLElement && target.isConnected)
        target.focus({ preventScroll: true });
    };
  }, [anchor, host]);
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-labelledby={titleId}
      className="anchored-popover"
      style={{ left: position.x, top: position.y }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close dialog">
          <X size={18} />
        </button>
      </header>
      <div className="anchored-popover-content">{children}</div>
    </div>,
    host,
  );
}
