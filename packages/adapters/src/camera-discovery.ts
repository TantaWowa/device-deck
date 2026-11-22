import { DeckError, type Observation, type SourceConfig } from "../../core/src/local/types";
import type { DetectedCard } from "../../core/src/capture-cards";
import { run } from "./process";

export type CameraObservation = Observation & { devices: DetectedCard[] };
type GateTask = { start: () => void; cancel: () => void };

/** One daemon owns raw camera discovery and the short native-initialization gate.
 * Running streams do not hold the gate. There are no recurring timers. */
export class CameraDiscovery {
  private devices: DetectedCard[] = [];
  private observedAt: number | null = null;
  private error: string | null = null;
  private desktopErrors?: Map<number | undefined, string>;
  private startedAt = -Infinity;
  private nextRetryAt = 0;
  private failures = 0;
  private invalidated = false;
  private pending?: Promise<CameraObservation>;
  private controller = new AbortController();
  private gateActive = false;
  private gateQueue: GateTask[] = [];
  private gateIdle?: { promise: Promise<void>; resolve: () => void };
  private counters = { requests: 0, hits: 0, shared: 0, starts: 0, failures: 0, active: 0, peakActive: 0, lastDurationMs: 0 };

  constructor(
    private helper: string,
    private execute: typeof run = run,
    private now: () => number = Date.now,
    private sources: () => SourceConfig[] = () => [],
    private ttl = 30_000,
    private cooldown = 5_000,
    private deadline = 25_000,
  ) {}

  peek(): CameraObservation {
    return {
      devices: this.devices.map((device) => ({ ...device })),
      observedAt: this.observedAt,
      refreshing: Boolean(this.pending),
      stale: this.invalidated || this.observedAt === null || Boolean(this.error) || this.now() - this.observedAt >= this.ttl,
      error: this.error,
      nextRefreshAt: Math.max(this.startedAt + this.cooldown, this.nextRetryAt),
    };
  }

  stats() { return { ...this.counters, queued: this.gateQueue.length, initializing: this.gateActive }; }

  observationFor(desktop: number | undefined, observation: Observation): Observation {
    if (!this.desktopErrors || !observation.error) return observation;
    const error = this.desktopErrors.get(desktop) || null;
    return { ...observation, error, stale: Boolean(error) || this.invalidated || this.now() - (observation.observedAt ?? 0) >= this.ttl };
  }

  private async listDesktop(uid: number | undefined, signal: AbortSignal): Promise<DetectedCard[]> {
    const args = uid === undefined ? ["list"] : ["--desktop", String(uid), "list"];
    const result = await this.execute(this.helper, args, 5_000, { signal });
    const parsed: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(parsed) || !parsed.every(card => card && typeof card.uniqueId === "string" && card.uniqueId.length && typeof card.name === "string"))
      throw new Error("Camera discovery returned invalid device data.");
    return parsed.map(card => ({ uniqueId: card.uniqueId, name: card.name, ...(typeof card.inUse === "string" ? { inUse: card.inUse } : {}) }));
  }

  private async collect(signal: AbortSignal) {
    const routed = new Map(this.sources().filter(s => s.kind === "usb" && s.uniqueId && s.captureDesktopUid !== undefined).map(s => [s.uniqueId!, s.captureDesktopUid!]));
    const desktops = [undefined, ...new Set(routed.values())];
    const results = await Promise.allSettled(desktops.map(uid => this.listDesktop(uid, signal)));
    const devices: DetectedCard[] = [];
    const errors = new Map<number | undefined, string>();
    for (const [i, result] of results.entries()) {
      const uid = desktops[i];
      if (result.status === "fulfilled") devices.push(...result.value.filter(card => routed.get(card.uniqueId) === uid));
      else errors.set(uid, (uid === undefined ? "" : `USB desktop ${uid}: `) + (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    }
    const detail = [...errors.values()].join("; ");
    if (errors.size === results.length) throw new Error(detail);
    return { devices, errors, error: detail || null };
  }

  /** Invalidation expires the observation, never the global cooldown/backoff. */
  invalidate() { this.invalidated = true; }

  read({ force = false }: { force?: boolean } = {}): Promise<CameraObservation> {
    this.counters.requests++;
    if (this.controller.signal.aborted) return Promise.reject(this.stopped());
    if (this.pending) { this.counters.shared++; return this.pending; }
    const state = this.peek();
    if ((!force && !state.stale) || this.now() < state.nextRefreshAt) {
      this.counters.hits++;
      return Promise.resolve(state);
    }
    this.pending = this.initialize(async (signal) => {
      this.startedAt = this.now();
      this.counters.starts++;
      this.counters.active++;
      this.counters.peakActive = Math.max(this.counters.peakActive, this.counters.active);
      try {
        const observation = await this.collect(signal);
        this.devices = observation.devices;
        this.desktopErrors = observation.errors;
        this.observedAt = this.now();
        this.error = observation.error;
        this.failures = 0;
        this.nextRetryAt = 0;
        this.invalidated = false;
      } finally {
        this.counters.active--;
        this.counters.lastDurationMs = Math.max(0, this.now() - this.startedAt);
      }
    }, AbortSignal.timeout(this.deadline), true).catch((error) => {
      this.desktopErrors = undefined;
      this.error = (error as Error).message;
      this.counters.failures++;
      const delays = [5_000, 15_000, 30_000, 60_000];
      this.nextRetryAt = this.now() + delays[Math.min(this.failures++, delays.length - 1)];
    }).then(() => {
      const observation = this.peek();
      return { ...observation, refreshing: false };
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private stopped() { return new DeckError("camera-stopping", "Camera discovery is stopping.", 503); }

  /** Actions must finish their own child cleanup before settling on abort/error. */
  initialize<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, priority = false): Promise<T> {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted) return Promise.reject(combined.reason || this.stopped());
    if (this.gateQueue.length >= 32) return Promise.reject(new DeckError("camera-busy", "Camera initialization is busy. Retry shortly.", 503));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const task: GateTask = {
        cancel: () => {
          if (started) return;
          const index = this.gateQueue.indexOf(task);
          if (index >= 0) this.gateQueue.splice(index, 1);
          combined.removeEventListener("abort", task.cancel);
          reject(combined.reason || this.stopped());
        },
        start: () => {
          started = true;
          combined.removeEventListener("abort", task.cancel);
          if (combined.aborted) { reject(combined.reason || this.stopped()); this.drain(); return; }
          this.gateActive = true;
          void Promise.resolve().then(() => {
            combined.throwIfAborted();
            return action(combined);
          }).then(resolve, reject).finally(() => {
            this.gateActive = false;
            this.drain();
          });
        },
      };
      combined.addEventListener("abort", task.cancel, { once: true });
      if (priority) this.gateQueue.unshift(task);
      else this.gateQueue.push(task);
      this.drain();
    });
  }

  private drain() {
    if (this.gateActive) return;
    const next = this.gateQueue.shift();
    if (next) next.start();
    else { this.gateIdle?.resolve(); this.gateIdle = undefined; }
  }

  async close() {
    this.controller.abort(this.stopped());
    if (this.gateActive) {
      if (!this.gateIdle) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        this.gateIdle = { promise, resolve };
      }
      await this.gateIdle.promise;
    }
    await this.pending?.catch(() => {});
  }
}
