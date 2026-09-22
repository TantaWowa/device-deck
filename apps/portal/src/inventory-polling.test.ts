import test from "node:test";
import assert from "node:assert/strict";
import { InventoryPolling } from "../../web/src/local/inventory-polling";

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("ordinary reads stop hidden and resume once without overlapping or replaying ticks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false;
  const pending: { signal: AbortSignal; finish(): void }[] = [];
  const polling = new InventoryPolling((signal) => new Promise<void>((resolve) => pending.push({ signal, finish: resolve })), () => visible, () => 2500);
  await polling.refresh();
  assert.equal(pending.length, 0);
  visible = true;
  void polling.refresh(); await settle();
  for (let i = 0; i < 10; i++) void polling.refresh();
  t.mock.timers.tick(30_000); await settle();
  assert.equal(pending.length, 1);
  visible = false; polling.pause();
  assert.equal(pending[0].signal.aborted, true);
  visible = true;
  for (let i = 0; i < 10; i++) void polling.refresh();
  pending[0].finish(); await settle();
  assert.equal(pending.length, 2, "Only one resumed read replaces the cancelled request");
  pending[1].finish(); await settle();
  t.mock.timers.tick(2499); await settle();
  assert.equal(pending.length, 2);
  t.mock.timers.tick(1); await settle();
  assert.equal(pending.length, 3);
  polling.dispose();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].finish(); await settle();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(pending.length, 3, "Disposed clients never schedule successors");
});

test("hide cancels a pending resume and failures remain bounded by the ordinary cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true, calls = 0;
  let finish!: () => void;
  const polling = new InventoryPolling(async () => { calls++; if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; }); else throw new Error("offline"); }, () => visible, () => 2500);
  void polling.refresh(); await settle();
  visible = false; polling.pause();
  visible = true; void polling.refresh();
  visible = false; polling.pause();
  finish(); await settle();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 1);
  visible = true; await polling.refresh();
  assert.equal(calls, 2);
  t.mock.timers.tick(2499); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
  polling.dispose();
});

test("manual refresh intent belongs to the clicked request and never leaks into ordinary polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: boolean[] = [];
  const polling = new InventoryPolling(async (_signal, manual) => { requests.push(manual); }, () => true, () => 2500);
  await polling.refresh();
  await polling.refresh(true);
  t.mock.timers.tick(2500); await settle();
  assert.deepEqual(requests, [false, true, false]);
  polling.dispose();
});
