import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { ThumbnailRequests } from "./thumbnail-requests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const frame = () => new Blob(["frame"], { type: "image/png" });

test("thumbnail requests run in FIFO order with only one active loader", async () => {
  const requests = new ThumbnailRequests();
  const gates = [deferred<Blob>(), deferred<Blob>(), deferred<Blob>()];
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const results = gates.map((gate, index) => requests.request(String(index), async () => {
    started.push(index);
    peak = Math.max(peak, ++active);
    try { return await gate.promise; } finally { active -= 1; }
  }, new AbortController().signal));
  await setImmediate();
  assert.deepEqual(started, [0]);
  gates[0].resolve(frame());
  await results[0];
  await setImmediate();
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve(frame());
  await results[1];
  await setImmediate();
  assert.deepEqual(started, [0, 1, 2]);
  gates[2].resolve(frame());
  await Promise.all(results);
  assert.equal(peak, 1);
});

test("same-key subscribers share unfinished work but completed images are not cached", async () => {
  const requests = new ThumbnailRequests();
  const gate = deferred<Blob>();
  const controllers = [new AbortController(), new AbortController()];
  let calls = 0;
  const load = () => { calls += 1; return gate.promise; };
  const first = requests.request("card", load, controllers[0].signal);
  const second = requests.request("card", load, controllers[1].signal);
  await setImmediate();
  assert.equal(calls, 1);
  const blob = frame();
  gate.resolve(blob);
  assert.deepEqual(await Promise.all([first, second]), [blob, blob]);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await requests.request("card", load, new AbortController().signal);
  assert.equal(calls, 2);
});

test("cancelling queued requests rejects promptly and never invokes their loaders", async () => {
  const requests = new ThumbnailRequests();
  const gate = deferred<Blob>();
  const first = requests.request("first", () => gate.promise, new AbortController().signal);
  const controller = new AbortController();
  let cancelledCalls = 0;
  const queued = requests.request("cancelled", async () => { cancelledCalls += 1; return frame(); }, controller.signal);
  const rejection = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  gate.resolve(frame());
  await first;
  await requests.request("last", async () => frame(), new AbortController().signal);
  assert.equal(cancelledCalls, 0);
});

test("cancelling an active request holds its slot until its loader settles", async () => {
  const requests = new ThumbnailRequests();
  const gate = deferred<Blob>();
  const controller = new AbortController();
  let underlyingSignal: AbortSignal | undefined;
  const first = requests.request("card", signal => { underlyingSignal = signal; return gate.promise; }, controller.signal);
  const rejection = assert.rejects(first, { name: "AbortError" });
  await setImmediate();
  controller.abort();
  await rejection;
  assert.equal(underlyingSignal?.aborted, true);
  let freshCalls = 0;
  // Even the same key starts new work after cancellation, without overlap.
  const fresh = requests.request("card", async () => { freshCalls += 1; return frame(); }, new AbortController().signal);
  await setImmediate();
  assert.equal(freshCalls, 0);
  gate.resolve(frame());
  await fresh;
  assert.equal(freshCalls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("one subscriber cancelling leaves another subscriber's capture running", async () => {
  const requests = new ThumbnailRequests();
  const gate = deferred<Blob>();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let underlyingSignal: AbortSignal | undefined;
  const first = requests.request("card", signal => { underlyingSignal = signal; return gate.promise; }, firstController.signal);
  const second = requests.request("card", async () => { throw new Error("Must share first loader"); }, secondController.signal);
  const rejection = assert.rejects(first, { name: "AbortError" });
  await setImmediate();
  firstController.abort();
  await rejection;
  assert.equal(underlyingSignal?.aborted, false);
  const blob = frame();
  gate.resolve(blob);
  assert.equal(await second, blob);
  for (const controller of [firstController, secondController]) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("loader failures release the queue and subscriber listeners", async () => {
  const requests = new ThumbnailRequests();
  const controllers = [new AbortController(), new AbortController()];
  const synchronous = requests.request("sync", () => { throw new Error("Synchronous failure"); }, controllers[0].signal);
  const asynchronous = requests.request("async", async () => { throw new Error("Async failure"); }, controllers[1].signal);
  const last = requests.request("last", async () => frame(), new AbortController().signal);
  await Promise.all([
    assert.rejects(synchronous, /Synchronous failure/),
    assert.rejects(asynchronous, /Async failure/),
    last,
  ]);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("already aborted subscribers do not enqueue work", async () => {
  const requests = new ThumbnailRequests();
  const controller = new AbortController();
  const reason = new Error("Screen closed");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(requests.request("card", async () => { calls += 1; return frame(); }, controller.signal), error => error === reason);
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
