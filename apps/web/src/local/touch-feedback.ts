import type { FramePoint } from "./live-input";

export type TouchPhase = "active" | "released" | "cancelled" | "rejected";
export type TouchTrace = {
  key: number;
  contactId: number;
  points: FramePoint[];
  phase: TouchPhase;
  expiresAt: number | null;
};

/** The inverse of framePoint, in CSS pixels inside an object-fit: contain video. */
export function touchFeedbackPoint(width: number, height: number, point: FramePoint): { x: number; y: number } | null {
  if (![width, height, point.x, point.y, point.width, point.height].every(Number.isFinite) || width <= 0 || height <= 0 || point.width <= 0 || point.height <= 0) return null;
  const scale = Math.min(width / point.width, height / point.height);
  return {
    x: (width - point.width * scale) / 2 + point.x * scale,
    y: (height - point.height * scale) / 2 + point.y * scale,
  };
}

/** Local gesture feedback only: sending input is not a device acknowledgment. */
export class TouchFeedback {
  private traces = new Map<number, TouchTrace>();
  private sequence = 0;

  start(contactId: number, point: FramePoint) {
    this.traces.set(contactId, { key: ++this.sequence, contactId, points: [point], phase: "active", expiresAt: null });
  }

  move(contactId: number, point: FramePoint) {
    const trace = this.traces.get(contactId);
    if (!trace || trace.phase !== "active") return;
    const last = trace.points[trace.points.length - 1];
    if (last.width !== point.width || last.height !== point.height) { this.traces.delete(contactId); return; }
    if (last.x === point.x && last.y === point.y) return;
    // Retain both ends and the full route, thinning older samples as needed.
    const points = trace.points.length >= 64 ? trace.points.filter((_, index) => index % 2 === 0 || index === trace.points.length - 1) : trace.points;
    this.traces.set(contactId, { ...trace, points: [...points, point] });
  }

  finish(contactId: number, phase: Exclude<TouchPhase, "active">, now: number) {
    const trace = this.traces.get(contactId);
    if (!trace) return;
    this.traces.set(contactId, { ...trace, phase, expiresAt: now + (phase === "released" ? 550 : 650) });
  }

  cancelActive(now: number) {
    for (const trace of this.traces.values()) if (trace.phase === "active") this.finish(trace.contactId, "cancelled", now);
  }

  prune(now: number): boolean {
    let changed = false;
    for (const trace of this.traces.values()) {
      if (trace.expiresAt !== null && trace.expiresAt <= now) { this.traces.delete(trace.contactId); changed = true; }
    }
    return changed;
  }

  clear() { this.traces.clear(); }
  snapshot(): TouchTrace[] { return [...this.traces.values()]; }
}
