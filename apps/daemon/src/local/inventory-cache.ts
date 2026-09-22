import type { Observation } from "../../../../packages/core/src/local/types";

/** A read sponsors one bounded refresh, independent of the HTTP waiter's lifetime. */
export class InventoryCache<T extends { id: string; observation?: Observation }> {
  private values = new Map<string, { value: T; at: number | null; expired?: boolean }>();
  private generation = 0;
  private pending?: Promise<void>;
  private controller?: AbortController;
  private error: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private closed = false;
  constructor(private now = Date.now, private freshnessMs = 30_000, private deadlineMs = 10_000) {}
  invalidate(preserveIds: readonly string[] = [], staleIds: readonly string[] = preserveIds) {
    this.generation++;
    const preserved = new Set(preserveIds), stale = new Set(staleIds);
    for (const [id, row] of this.values) {
      if (!preserved.has(id)) this.values.delete(id);
      else if (stale.has(id)) row.expired = true;
    }
    this.retryAt = 0; this.error = null; this.failures = 0;
    this.controller?.abort(new Error("Inventory configuration changed."));
  }
  peek(ids: readonly string[]): T[] {
    return ids.flatMap((id) => {
      const row = this.values.get(id);
      return row ? [structuredClone(row.value)] : [];
    });
  }
  observation(ids: readonly string[]): Observation {
    const times = ids.map((id) => this.values.get(id)?.at);
    const observedAt = times.length && times.every((at) => at !== undefined && at !== null) ? Math.min(...times as number[]) : null;
    const rowError = ids.map((id) => this.values.get(id)?.value.observation?.error).find(Boolean) || null;
    return { observedAt, refreshing: Boolean(this.pending), stale: observedAt === null || this.now() - observedAt >= this.freshnessMs || Boolean(rowError) || ids.some((id) => this.values.get(id)?.expired),
      error: rowError || this.error, nextRefreshAt: Math.max(this.retryAt, observedAt === null ? 0 : observedAt + this.freshnessMs) };
  }
  refresh(ids: readonly string[], load: (signal: AbortSignal, publish: (row: T) => void) => Promise<T[]>, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!ids.length || (!force && (!this.observation(ids).stale || this.now() < this.retryAt))) return Promise.resolve();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("Inventory probe exceeded its deadline.")), this.deadlineMs);
    timer.unref();
    const publish = (row: T) => {
      if (this.closed || generation !== this.generation || controller.signal.aborted) return;
      const previous = this.values.get(row.id);
      if (row.observation?.error) {
        this.values.set(row.id, { value: structuredClone({ ...(previous?.value || row), observation: row.observation }), at: previous?.at ?? null });
      } else this.values.set(row.id, { value: structuredClone(row), at: row.observation ? row.observation.observedAt : this.now() });
    };
    // Completed targets publish independently; one slow target cannot hide them.
    // Keep the slot until the runner has actually settled, including child cleanup.
    const work = Promise.resolve().then(() => load(controller.signal, publish)).then((rows) => {
      if (this.closed || generation !== this.generation || controller.signal.aborted) return;
      for (const row of rows) publish(row);
      this.error = rows.map((row) => row.observation?.error).find(Boolean) || null;
      if (this.error) this.retryAt = this.now() + [5000, 15000, 30000, 60000][Math.min(this.failures++, 3)];
      else { this.failures = 0; this.retryAt = 0; }
    }).catch((error: unknown) => {
      if (generation !== this.generation || this.closed) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + [5000, 15000, 30000, 60000][Math.min(this.failures++, 3)];
    }).finally(() => {
      clearTimeout(timer);
      if (controller.signal.aborted && generation === this.generation && !this.closed && !this.error) {
        this.error = String(controller.signal.reason?.message || "Inventory probe canceled.");
        this.retryAt = this.now() + 5000;
      }
      if (this.pending === work) { this.pending = undefined; this.controller = undefined; }
    });
    this.pending = work;
    return work;
  }
  async close() {
    this.closed = true;
    this.controller?.abort(new Error("Service is stopping."));
    await this.pending;
    this.values.clear();
  }
}
