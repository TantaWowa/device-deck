import { setImmediate } from "node:timers/promises";
import { run } from "./process";
import { DeckError } from "../../core/src/local/types";

/** Daemon-wide budget for read-only discovery, independent of control/capture. */
export class ProbeScheduler {
  private controller = new AbortController();
  private active = 0;
  private scheduling = false;
  private queue: { start: () => void; cancel: () => void }[] = [];
  private pending = new Set<Promise<unknown>>();
  private peak = 0;
  private commands = {
    cameraList: { starts: 0, failures: 0, totalDurationMs: 0 },
    simulatorList: { starts: 0, failures: 0, totalDurationMs: 0 },
    simulatorReadiness: { starts: 0, failures: 0, totalDurationMs: 0 },
    other: { starts: 0, failures: 0, totalDurationMs: 0 },
  };
  constructor(private execute: typeof run = run, private concurrency = 2, private capacity = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(capacity) || capacity < 1)
      throw new Error("Discovery concurrency and queue capacity must be positive integers.");
  }
  stats() { return { active: this.active, queued: this.queue.length, peak: this.peak, commands: structuredClone(this.commands) }; }
  readonly run: typeof run = (command, args, timeout, options) => {
    const signal = AbortSignal.any([this.controller.signal, ...(options?.signal ? [options.signal] : [])]);
    if (signal.aborted) return Promise.reject(new DeckError("probe-cancelled", "Discovery was cancelled.", 499));
    if (this.queue.length >= this.capacity) return Promise.reject(new DeckError("probe-busy", "Discovery budget is busy. Retry shortly.", 503));
    const result = new Promise<Awaited<ReturnType<typeof run>>>((resolve, reject) => {
      const task = {
        cancel: () => {
          const index = this.queue.indexOf(task);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", task.cancel);
          reject(new DeckError("probe-cancelled", "Discovery was cancelled.", 499));
        },
        start: () => {
          signal.removeEventListener("abort", task.cancel);
          if (signal.aborted) { reject(new DeckError("probe-cancelled", "Discovery was cancelled.", 499)); this.drain(); return; }
          this.active++; this.peak = Math.max(this.peak, this.active);
          const category = command.endsWith("deck-camera") && args[0] === "list" ? "cameraList"
            : args[0] === "simctl" && args[1] === "list" ? "simulatorList"
            : args[0] === "simctl" && args[1] === "bootstatus" ? "simulatorReadiness" : "other";
          const counters = this.commands[category], began = performance.now();
          counters.starts++;
          void this.execute(command, args, timeout, { ...options, signal }).then(resolve, (error) => { counters.failures++; reject(error); }).finally(() => {
            counters.totalDurationMs += performance.now() - began;
            this.active--; this.drain();
          });
        },
      };
      signal.addEventListener("abort", task.cancel, { once: true });
      this.queue.push(task);
      this.drain();
    });
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    return result;
  };
  private drain() {
    if (this.scheduling || this.active >= this.concurrency || !this.queue.length) return;
    this.scheduling = true;
    void setImmediate().then(() => {
      this.scheduling = false;
      this.queue.shift()?.start();
      this.drain();
    });
  }
  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}

/** One inventory scan owns this runner. Identical read-only probes share a
 * result only within that scan, never with a later scan or an input/lifecycle
 * operation. Limit and yield process launches so video/HTTP can keep flowing
 * while macOS's synchronous posix_spawn work runs on the Node main thread. */
export function healthProbeRunner(execute = run, concurrency = 2, signal?: AbortSignal): typeof run {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Health probe concurrency must be positive.");
  const probes = new Map<string, ReturnType<typeof run>>();
  const queue: (() => Promise<void>)[] = [];
  let active = 0, scheduling = false;
  const drain = () => {
    if (scheduling || active >= concurrency || !queue.length) return;
    scheduling = true;
    void (async () => {
      await setImmediate();
      scheduling = false; active++;
      const task = queue.shift()!;
      void task().finally(() => { active--; drain(); });
      // A newly scheduled immediate runs on the next event-loop turn. Even
      // when several slots are free, never launch a burst in one callback.
      drain();
    })();
  };
  return (command, args, timeout, options) => {
    const key = JSON.stringify([command, args, timeout ?? 15000, options?.cwd ?? null]);
    let result = probes.get(key);
    if (!result) {
      result = new Promise((resolve, reject) => {
        queue.push(async () => {
          try {
            const combined = signal && options?.signal ? AbortSignal.any([signal, options.signal]) : signal || options?.signal;
            if (combined?.aborted) throw new DeckError("probe-cancelled", "Discovery was cancelled.", 499);
            resolve(await execute(command, args, timeout, { ...options, ...(combined ? { signal: combined } : {}) }));
          }
          catch (error) { reject(error); }
        });
        drain();
      });
      probes.set(key, result);
    }
    return result;
  };
}
