import { DeckError, fail } from "../../../../packages/core/src/local/types";

type Entry = { at: number; data?: Buffer; error?: unknown };
type Job = { work: () => Promise<Buffer>; resolve: (data: Buffer) => void; reject: (error: unknown) => void };
const limits = { concurrency: 1, queued: 24, entries: 64, bytes: 16 * 1024 * 1024, frameBytes: 2 * 1024 * 1024, ttl: 30_000 };

/** One-shot card snapshots share a bounded pool/cache. No timers or video loops. */
export class CaptureCardThumbnails {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Promise<Buffer>>();
  private queue: Job[] = [];
  private active = 0;
  private bytes = 0;
  private closed = false;
  constructor(private now = Date.now, private capacity = limits) {}

  async get(key: string, work: Job["work"]): Promise<Buffer> {
    if (this.closed) fail("service-stopping", "Service is stopping.", 503);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.capacity.ttl) {
      if (cached.error) throw cached.error;
      return cached.data!;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.queue.length >= this.capacity.queued)
        fail("thumbnail-busy", "Capture card previews are busy. Try again shortly.", 429);
      const job = new Promise<Buffer>((resolve, reject) => {
        this.queue.push({ work, resolve, reject }); this.pump();
      });
      pending = job.then((data) => {
        if (data.length < 4 || data.length > this.capacity.frameBytes || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9)
          fail("thumbnail-failed", "The capture card did not produce a valid preview image.", 502);
        this.remember(key, { at: this.now(), data });
        return data;
      }).catch((error: unknown) => {
        // No-signal and permission failures must not spawn a helper per hover/client.
        this.remember(key, { at: this.now(), error });
        throw error;
      }).finally(() => { this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    return pending;
  }
  private remember(key: string, entry: Entry) {
    this.bytes -= this.cache.get(key)?.data?.length ?? 0;
    this.cache.delete(key);
    if (this.closed) return;
    this.cache.set(key, entry); this.bytes += entry.data?.length ?? 0;
    while (this.cache.size > this.capacity.entries || this.bytes > this.capacity.bytes) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)?.data?.length ?? 0;
      this.cache.delete(oldest);
    }
  }
  private pump() {
    while (!this.closed && this.active < this.capacity.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.active++;
      void Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new DeckError("service-stopping", "Service is stopping.", 503));
    await Promise.allSettled(this.pending.values());
    this.cache.clear(); this.bytes = 0;
  }
}
