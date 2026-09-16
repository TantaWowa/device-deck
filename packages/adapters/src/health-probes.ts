import { setImmediate } from "node:timers/promises";
import { run } from "./process";

/** One inventory scan owns this runner. Identical read-only probes share a
 * result only within that scan, never with a later scan or an input/lifecycle
 * operation. Limit and yield process launches so video/HTTP can keep flowing
 * while macOS's synchronous posix_spawn work runs on the Node main thread. */
export function healthProbeRunner(execute = run, concurrency = 2): typeof run {
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
          try { resolve(await execute(command, args, timeout, options)); }
          catch (error) { reject(error); }
        });
        drain();
      });
      probes.set(key, result);
    }
    return result;
  };
}
