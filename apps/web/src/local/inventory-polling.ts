/** Ordinary reads have one owner; media and session heartbeats never use this timer. */
export class InventoryPolling {
  private timer?: ReturnType<typeof setTimeout>;
  private request?: { controller: AbortController; promise: Promise<void> };
  private resumed = false;
  private closed = false;

  constructor(
    private readonly read: (signal: AbortSignal, manual: boolean) => Promise<void>,
    private readonly demanded: () => boolean,
    private readonly interval: () => number,
  ) {}

  refresh = (manual = false): Promise<void> => {
    clearTimeout(this.timer);
    if (this.closed || !this.demanded()) return Promise.resolve();
    if (this.request) {
      // Only a resume after cancellation gets one replacement, never each tick.
      if (this.request.controller.signal.aborted) this.resumed = true;
      return this.request.promise;
    }
    const controller = new AbortController();
    const request = { controller, promise: Promise.resolve() };
    this.request = request;
    request.promise = Promise.resolve().then(() => {
      if (!controller.signal.aborted) return this.read(controller.signal, manual);
    }).catch(() => { /* The caller presents read errors; cancellation is quiet. */ }).finally(() => {
      if (this.request !== request) return;
      this.request = undefined;
      if (this.closed || !this.demanded()) return;
      if (this.resumed) { this.resumed = false; void this.refresh(); }
      else this.timer = setTimeout(() => void this.refresh(), this.interval());
    });
    return request.promise;
  };

  pause() {
    clearTimeout(this.timer);
    this.resumed = false;
    this.request?.controller.abort();
  }

  dispose() { this.closed = true; this.pause(); }
}
