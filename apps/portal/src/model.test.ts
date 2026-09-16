import assert from "node:assert/strict";
import test from "node:test";
import type { MachineRecord } from "../../../packages/core/src/hub";
import { cacheKey, clearMachineCache, ControlGate, endpointInput, needsStandalone, observationLabel, readMachineCache, writeMachineCache } from "./model";

const machine: MachineRecord = {
  id: "c99fa80b-2ab3-43dc-83ae-e5416f7be10f", pairingId: "070c030a-b4a5-430d-8b13-a2e5545f9781",
  name: "Studio", endpoint: "https://studio.example.com:47831",
  publicKey: { kty: "OKP", crv: "Ed25519", x: "a".repeat(43) },
  createdAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z",
};
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};

test("saved machine lists are account scoped, exclude credentials, and clear on logout", () => {
  const cache = storage();
  const supplied = { ...machine, token: "never-cache", leaseToken: "never-cache-either" };
  writeMachineCache(cache, "first-user", [supplied], new Date("2026-09-16T11:00:00.000Z"));
  assert.equal(readMachineCache(cache, "second-user"), undefined);
  assert.deepEqual(readMachineCache(cache, "first-user"), { machines: [machine], savedAt: "2026-09-16T11:00:00.000Z" });
  assert.ok(!cache.getItem(cacheKey("first-user"))?.includes("never-cache"));
  writeMachineCache(cache, "second-user", [machine]);
  clearMachineCache(cache, "first-user");
  assert.equal(readMachineCache(cache, "first-user"), undefined);
  assert.equal(readMachineCache(cache, "second-user")?.machines.length, 1);
});

test("corrupt or invalid cached lists are discarded", () => {
  const cache = storage();
  for (const raw of ["not JSON", "{}", JSON.stringify({ machines: [machine], savedAt: "yesterday" }), JSON.stringify({ machines: [{ ...machine, endpoint: "javascript:alert(1)" }], savedAt: machine.updatedAt })]) {
    cache.setItem(cacheKey("user"), raw);
    assert.equal(readMachineCache(cache, "user"), undefined);
  }
});

test("connection labels never present old observations as live availability", () => {
  const checkedAt = "2026-09-16T10:00:00.000Z";
  assert.equal(observationLabel(undefined), "Not checked");
  assert.equal(observationLabel({ state: "reachable", checkedAt }, Date.parse(checkedAt) + 1000), "Reachable from this browser");
  assert.equal(observationLabel({ state: "reachable", checkedAt }, Date.parse(checkedAt) + 60_000), "Check needed");
  assert.equal(observationLabel({ state: "unreachable", checkedAt }, Date.parse(checkedAt) + 1000), "Not reachable from this browser");
});

test("addresses default to HTTPS and insecure cross-origin use is standalone only", () => {
  assert.equal(endpointInput("  studio.example.com:47831 "), "https://studio.example.com:47831");
  assert.equal(endpointInput("http://192.168.1.20:47831"), "http://192.168.1.20:47831");
  assert.equal(needsStandalone("http://192.168.1.20:47831", "https:"), true);
  assert.equal(needsStandalone("https://studio.example.com:47831", "https:"), false);
  assert.equal(needsStandalone("http://127.0.0.1:47831", "http:"), false);
});

test("control gate drops simultaneous controls instead of queuing or replaying them", async () => {
  const gate = new ControlGate();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const sent: string[] = [];
  const first = gate.run(async () => { await pending; sent.push("first"); });
  assert.equal(await gate.run(async () => { sent.push("second"); }), undefined);
  finish(); await first;
  assert.deepEqual(sent, ["first"]);
  await gate.run(async () => { sent.push("fresh press"); });
  assert.deepEqual(sent, ["first", "fresh press"]);
});

test("switching machine or logging out cancels pending controls before input dispatch", async () => {
  const gate = new ControlGate();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const sent: string[] = [];
  let oldSignal: AbortSignal | undefined;
  const old = gate.run(async (signal, current) => { oldSignal = signal; await pending; if (current()) sent.push("old machine"); });
  gate.cancel();
  assert.equal(oldSignal?.aborted, true);
  await gate.run(async (_signal, current) => { if (current()) sent.push("new machine"); });
  finish(); await old;
  assert.deepEqual(sent, ["new machine"]);
});
