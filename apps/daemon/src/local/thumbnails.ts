import { stat } from "node:fs/promises";
import { run } from "../../../../packages/adapters/src/process";
import { fail, type Artifact } from "../../../../packages/core/src/local/types";

type CacheEntry = { id: string; data: Buffer };
type Job = { work: () => Promise<Buffer>; resolve: (data: Buffer) => void; reject: (reason: unknown) => void };
const limits = { concurrency: 2, queued: 24, entries: 128, bytes: 16 * 1024 * 1024, thumbnailBytes: 512 * 1024 };

/** One bounded cache/worker pool per daemon; never writes thumbnail sidecars. */
export class CaptureThumbnails {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<Buffer>>();
  private queue: Job[] = [];
  private active = 0;
  private bytes = 0;
  private closed = false;
  constructor(
    private artifact: (id: string) => Artifact,
    private ffmpeg: () => string,
    private execute = run,
    private capacity = limits,
  ) {}

  private current(id: string, expected?: Artifact) {
    if (this.closed) fail("service-stopping", "Service is stopping.", 503);
    const artifact = { ...this.artifact(id) };
    if (artifact.deletedAt || artifact.purgedAt) {
      this.invalidate(id);
      fail("artifact-removed", "Restore this capture from Trash before viewing its thumbnail.", 410);
    }
    if (artifact.status === "recording" || artifact.status === "finalizing") {
      this.invalidate(id);
      fail("artifact-not-ready", "The thumbnail will be available when this capture finishes.", 409);
    }
    if (expected && (artifact.path !== expected.path || artifact.kind !== expected.kind))
      fail("artifact-changed", "The capture changed while its thumbnail was loading. Try again.", 409);
    return artifact;
  }
  private invalidate(id: string) {
    for (const [key, entry] of this.cache) if (entry.id === id) {
      this.cache.delete(key); this.bytes -= entry.data.length;
    }
  }
  private async identity(artifact: Artifact, ffmpeg: string) {
    let info;
    try { info = await stat(artifact.path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail("artifact-file-missing", "This capture's file is no longer available.", 404);
      throw error;
    }
    if (!info.isFile()) fail("artifact-file-missing", "This capture's file is no longer available.", 404);
    return JSON.stringify([artifact.id, artifact.path, artifact.kind, ffmpeg, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
  }
  assertAvailable(id: string) {
    this.current(id);
  }
  async get(id: string): Promise<Buffer> {
    const artifact = this.current(id), ffmpeg = this.ffmpeg();
    const key = await this.identity(artifact, ffmpeg);
    this.current(id, artifact);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return cached.data;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      const work = this.schedule(async () => {
        this.current(id, artifact);
        if (await this.identity(artifact, ffmpeg) !== key)
          fail("artifact-changed", "The capture changed while its thumbnail was loading. Try again.", 409);
        const { stdout } = await this.execute(ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1",
          "-i", artifact.path, "-an", "-frames:v", "1",
          "-vf", "scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "mjpeg", "-q:v", "5", "-threads", "1", "-f", "image2pipe", "pipe:1",
        ], 10_000);
        if (stdout.length < 4 || stdout.length > this.capacity.thumbnailBytes || stdout.readUInt16BE(0) !== 0xffd8 || stdout.readUInt16BE(stdout.length - 2) !== 0xffd9)
          fail("thumbnail-failed", "The capture did not produce a valid small JPEG thumbnail.", 502);
        this.current(id, artifact);
        if (await this.identity(artifact, ffmpeg) !== key)
          fail("artifact-changed", "The capture changed while its thumbnail was loading. Try again.", 409);
        this.current(id, artifact);
        this.invalidate(id);
        if (stdout.length <= this.capacity.bytes) {
          this.cache.set(key, { id, data: stdout }); this.bytes += stdout.length;
          while (this.cache.size > this.capacity.entries || this.bytes > this.capacity.bytes) {
            const oldest = this.cache.keys().next().value!;
            this.bytes -= this.cache.get(oldest)!.data.length; this.cache.delete(oldest);
          }
        }
        return stdout;
      });
      pending = work.finally(() => { this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    const data = await pending;
    // A queued/encoding request can overlap Trash, Purge or recording changes.
    this.current(id, artifact);
    return data;
  }
  private schedule(work: Job["work"]) {
    if (this.queue.length >= this.capacity.queued)
      fail("thumbnail-busy", "Thumbnail generation is busy. Try again shortly.", 429);
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ work, resolve, reject }); this.pump();
    });
  }
  private pump() {
    while (!this.closed && this.active < this.capacity.concurrency && this.queue.length) {
      const job = this.queue.shift()!; this.active++;
      void job.work().then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("Thumbnail service is stopping."));
    await Promise.allSettled(this.pending.values());
    this.cache.clear(); this.bytes = 0;
  }
}
