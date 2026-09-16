import type { GestureInput, PointerInput } from "../../../../packages/core/src/live";

export type FramePoint = { x: number; y: number; width: number; height: number };
export type FrameRect = { left: number; top: number; width: number; height: number };

/** Map CSS coordinates into the actual contained video, excluding letterboxes. */
export function framePoint(rect: FrameRect, width: number, height: number, clientX: number, clientY: number): FramePoint | null {
  if (![rect.left, rect.top, rect.width, rect.height, width, height, clientX, clientY].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y, width, height };
}

export function completedGesture(start: FramePoint, end: FramePoint, durationMs: number): GestureInput {
  const duration = Math.max(50, Math.min(5000, Math.round(durationMs)));
  // A proportional threshold stays consistent across portrait, landscape and quality profiles.
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance > Math.max(8, Math.min(start.width, start.height) * 0.018))
    return { type: "swipe", ...start, toX: end.x, toY: end.y, durationMs: duration };
  return duration >= 500 ? { type: "longPress", ...start, durationMs: duration } : { type: "tap", ...start };
}

/** Only moves can be replaced. Boundaries always retain order and flush the latest moves. */
export class PointerQueue {
  private moves = new Map<number, PointerInput>();
  private contacts = new Set<number>();
  constructor(private readonly send: (event: PointerInput) => boolean) {}
  push(event: PointerInput): boolean {
    if (event.type === "down") {
      if (this.contacts.has(event.contactId) || this.contacts.size >= 10) return false;
      if (!this.flush()) return false;
      if (!this.send(event)) return false;
      this.contacts.add(event.contactId);
      return true;
    }
    if (!this.contacts.has(event.contactId)) return false;
    if (event.type === "move") { this.moves.set(event.contactId, event); return true; }
    if (!this.flush()) return false;
    const sent = this.send(event);
    this.contacts.delete(event.contactId);
    return sent;
  }
  flush(): boolean {
    const moves = [...this.moves.values()];
    this.moves.clear();
    for (const event of moves) if (!this.send(event)) { this.reset(); return false; }
    return true;
  }
  reset() { this.moves.clear(); this.contacts.clear(); }
  get size() { return this.moves.size; }
}
