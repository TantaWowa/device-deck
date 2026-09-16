import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  clampPopup,
  positionPopup,
  type PopupPosition,
  type PopupRect,
  type PopupSize,
} from "../../../../packages/ui/src/popup-position";

export type PopupAnchor = { element: HTMLElement; rect: PopupRect };
export function popupAnchor(element: HTMLElement): PopupAnchor {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { element, rect: { left, top, right, bottom } };
}

export function useAnchoredPopup({
  anchor,
  requestKey,
  fallbackSize,
}: {
  anchor?: PopupAnchor | null;
  requestKey: object;
  fallbackSize: PopupSize;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const detached = useRef(false);
  const lastRect = useRef(anchor?.rect);
  const [host, setHost] = useState<Element>(
    document.fullscreenElement || document.body,
  );
  const [position, setPosition] = useState<PopupPosition>({ x: 8, y: 8 });
  useLayoutEffect(() => {
    detached.current = false;
    lastRect.current = anchor?.rect;
  }, [anchor, requestKey]);
  const fit = useCallback(() => {
    const element = panel.current;
    const size = {
      width: element?.offsetWidth || fallbackSize.width,
      height: element?.offsetHeight || fallbackSize.height,
    };
    const viewport = { width: innerWidth, height: innerHeight };
    if (anchor?.element.isConnected)
      lastRect.current = anchor.element.getBoundingClientRect();
    const rect = lastRect.current;
    setPosition((previous) => {
      const next =
        rect && !detached.current
          ? positionPopup(rect, size, viewport)
          : clampPopup(previous, size, viewport);
      return previous.x === next.x && previous.y === next.y ? previous : next;
    });
  }, [anchor, fallbackSize.width, fallbackSize.height]);
  // Sorting can move a trigger without resizing it or scrolling the page.
  useLayoutEffect(() => {
    fit();
  });
  useLayoutEffect(() => {
    const fullscreen = () =>
      setHost(document.fullscreenElement || document.body);
    const observer = new ResizeObserver(fit);
    if (panel.current) observer.observe(panel.current);
    if (anchor?.element.isConnected) observer.observe(anchor.element);
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [anchor, host, fit]);
  return {
    panel,
    host,
    position,
    setPosition,
    detach: () => {
      detached.current = true;
    },
  };
}
