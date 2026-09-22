import test from "node:test";
import assert from "node:assert/strict";
import { InventoryCache } from "./local/inventory-cache";

test("inventory reads share bounded work and retain immutable observations across failures", async () => {
  let now = 1000, calls = 0;
  const cache = new InventoryCache<{ id: string; status: string }>(() => now, 30_000);
  let finish!: (rows: { id: string; status: string }[]) => void;
  const loader = async () => { calls++; return new Promise<{ id: string; status: string }[]>((resolve) => { finish = resolve; }); };
  const one = cache.refresh(["one"], loader);
  const two = cache.refresh(["one"], loader);
  assert.equal(one, two);
  await Promise.resolve();
  assert.deepEqual(cache.peek(["one"]), []);
  finish([{ id: "one", status: "ready" }]);
  await one;
  const copy = cache.peek(["one"]); copy[0].status = "changed";
  assert.equal(cache.peek(["one"])[0].status, "ready");
  await cache.refresh(["one"], loader);
  assert.equal(calls, 1);
  now += 30_000;
  await cache.refresh(["one"], async () => { calls++; throw new Error("probe failed"); });
  assert.equal(cache.peek(["one"])[0].status, "ready");
  assert.equal(cache.observation(["one"]).stale, true);
  assert.match(cache.observation(["one"]).error!, /probe failed/);
  await cache.refresh(["one"], loader);
  assert.equal(calls, 2, "repeated client reads cannot bypass failure backoff");
  await cache.close();
});

test("an old configuration cannot repopulate inventory after invalidation", async () => {
  const cache = new InventoryCache<{ id: string }>();
  let finish!: (rows: { id: string }[]) => void;
  const work = cache.refresh(["old"], async () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  finish([{ id: "old" }]);
  await work;
  assert.deepEqual(cache.peek(["old"]), []);
  await cache.refresh(["new"], async () => [{ id: "new" }]);
  assert.deepEqual(cache.peek(["new"]), [{ id: "new" }]);
  await cache.close();
});

test("copying an upstream observation does not extend its freshness", async () => {
  let now = 29_000;
  const cache = new InventoryCache<{ id: string; observation?: import("../../../packages/core/src/local/types").Observation }>(() => now, 30_000);
  await cache.refresh(["camera"], async () => [{ id: "camera", observation: {
    observedAt: 1000, refreshing: false, stale: false, error: null, nextRefreshAt: 31_000,
  } }]);
  assert.equal(cache.observation(["camera"]).observedAt, 1000);
  assert.equal(cache.observation(["camera"]).stale, false);
  now = 31_000;
  assert.equal(cache.observation(["camera"]).stale, true);
  await cache.close();
});

test("targeted invalidation preserves known facts and unrelated freshness", async () => {
  const cache = new InventoryCache<{ id: string; online: boolean }>(() => 1000);
  await cache.refresh(["one", "two", "changed"], async () => [
    { id: "one", online: true }, { id: "two", online: true }, { id: "changed", online: true },
  ]);
  cache.invalidate(["one", "two"], ["one"]);
  assert.equal(cache.peek(["one"])[0].online, true);
  assert.equal(cache.observation(["one"]).observedAt, 1000);
  assert.equal(cache.observation(["one"]).stale, true);
  assert.equal(cache.observation(["two"]).stale, false);
  assert.deepEqual(cache.peek(["changed"]), []);
  await cache.close();
});

test("deadline cancels the probe but keeps its slot until cleanup finishes", async () => {
  const cache = new InventoryCache<{ id: string }>(Date.now, 30_000, 10);
  let aborted = false, calls = 0;
  let cleanup!: () => void;
  const work = cache.refresh(["one"], async (signal) => {
    calls++;
    return new Promise((resolve) => {
      cleanup = () => resolve([{ id: "one" }]);
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(aborted, true);
  assert.equal(cache.refresh(["one"], async () => { calls++; return []; }), work);
  assert.equal(calls, 1);
  cleanup(); await work;
  assert.deepEqual(cache.peek(["one"]), []);
  assert.match(cache.observation(["one"]).error!, /deadline/);
  await cache.close();
});

test("completed rows survive a sibling deadline and a failed probe preserves known facts", async () => {
  const cache = new InventoryCache<{ id: string; online: boolean; observation?: import("../../../packages/core/src/local/types").Observation }>(Date.now, 30_000, 10);
  const work = cache.refresh(["fast", "slow"], async (signal, publish) => {
    publish({ id: "fast", online: true });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [{ id: "slow", online: false }];
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await work;
  assert.equal(cache.peek(["fast"])[0].online, true);
  assert.deepEqual(cache.peek(["slow"]), []);
  await cache.refresh(["fast"], async () => [{ id: "fast", online: false, observation: { observedAt: null, refreshing: false, stale: true, error: "temporary failure", nextRefreshAt: Date.now() + 5000 } }], true);
  assert.equal(cache.peek(["fast"])[0].online, true, "failure is not proof of disconnection");
  assert.equal(cache.observation(["fast"]).stale, true);
  assert.match(cache.observation(["fast"]).error!, /temporary failure/);
  await cache.close();
});
