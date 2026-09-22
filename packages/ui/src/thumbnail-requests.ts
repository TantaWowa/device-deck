type ThumbnailLoader = (signal: AbortSignal) => Promise<Blob>;

interface Subscriber {
  resolve: (blob: Blob) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

interface Request {
  key: string;
  load: ThumbnailLoader;
  controller: AbortController;
  subscribers: Set<Subscriber>;
  running: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Thumbnail request cancelled", "AbortError");
}

/** Shares unfinished thumbnail requests and limits simultaneous capture work. */
export class ThumbnailRequests {
  private readonly concurrency: number;
  private readonly requests = new Map<string, Request>();
  private readonly queue: Request[] = [];
  private active = 0;

  constructor({ concurrency = 1 }: { concurrency?: number } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("Thumbnail concurrency must be a positive integer");
    }
    this.concurrency = concurrency;
  }

  request(key: string, load: ThumbnailLoader, signal: AbortSignal): Promise<Blob> {
    if (signal.aborted) return Promise.reject(abortReason(signal));

    let request = this.requests.get(key);
    if (!request) {
      request = { key, load, controller: new AbortController(), subscribers: new Set(), running: false };
      this.requests.set(key, request);
      this.queue.push(request);
    }
    const pending = request;

    return new Promise<Blob>((resolve, reject) => {
      const cancel = () => {
        subscriber.detach();
        pending.subscribers.delete(subscriber);
        reject(abortReason(signal));
        if (pending.subscribers.size > 0) return;

        // New subscribers must not join a loader already being cancelled.
        if (this.requests.get(key) === pending) this.requests.delete(key);
        if (pending.running) {
          // Keep the slot until the loader settles, even if it ignores abort.
          pending.controller.abort(abortReason(signal));
        } else {
          const index = this.queue.indexOf(pending);
          if (index !== -1) this.queue.splice(index, 1);
        }
      };
      const subscriber: Subscriber = {
        resolve,
        reject,
        detach: () => signal.removeEventListener("abort", cancel),
      };
      pending.subscribers.add(subscriber);
      signal.addEventListener("abort", cancel, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const request = this.queue.shift()!;
      request.running = true;
      this.active += 1;
      // Normalize synchronous throws, and let immediate cancellation avoid work.
      void Promise.resolve().then(() => {
        request.controller.signal.throwIfAborted();
        return request.load(request.controller.signal);
      }).then(
        blob => this.finish(request, subscriber => subscriber.resolve(blob)),
        error => this.finish(request, subscriber => subscriber.reject(error)),
      );
    }
  }

  private finish(request: Request, settle: (subscriber: Subscriber) => void): void {
    if (this.requests.get(request.key) === request) this.requests.delete(request.key);
    this.active -= 1;
    for (const subscriber of request.subscribers) {
      subscriber.detach();
      settle(subscriber);
    }
    request.subscribers.clear();
    this.pump();
  }
}

/** One scheduler across capture-card thumbnails in this browser page. */
export const thumbnailRequests = new ThumbnailRequests();
