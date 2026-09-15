export type PopupRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type PopupSize = { width: number; height: number };
export type PopupPosition = { x: number; y: number };

export function clampPopup(
  position: PopupPosition,
  size: PopupSize,
  viewport: PopupSize,
  margin = 8,
): PopupPosition {
  return {
    x: Math.max(
      margin,
      Math.min(position.x, viewport.width - size.width - margin),
    ),
    y: Math.max(
      margin,
      Math.min(position.y, viewport.height - size.height - margin),
    ),
  };
}

/** Prefer immediately above the trigger; flip only when that space is insufficient. */
export function positionPopup(
  anchor: PopupRect,
  size: PopupSize,
  viewport: PopupSize,
  gap = 8,
  margin = 8,
): PopupPosition & { placement: "above" | "below" } {
  const above = anchor.top - gap - margin;
  const below = viewport.height - anchor.bottom - gap - margin;
  const placement = above >= size.height || above >= below ? "above" : "below";
  return {
    ...clampPopup(
      {
        x: (anchor.left + anchor.right - size.width) / 2,
        y:
          placement === "above"
            ? anchor.top - gap - size.height
            : anchor.bottom + gap,
      },
      size,
      viewport,
      margin,
    ),
    placement,
  };
}
