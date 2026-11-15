import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { Adapters } from "./index";
import { IdbInput, isCompanionFor, isStaleHidConnection } from "./idb-input";
import { startIdbInteractive } from "./interactive";
import { wakeSimulator } from "./simulator";
import type { run } from "./process";

const udid = "0371776A-0FC2-4DD1-8831-8941C7D1088A";
const invalidated = "/fixture/idb: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded";
const tapInvalidated = `${invalidated}; releasing the gesture then failed: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded`;
const interrupted = "The dtuhidd connection was interrupted during the gesture, so the guest no longer has it";
const companion = (id: string) => `/opt/homebrew/bin/idb_companion --udid ${id} --grpc-domain-sock /tmp/idb/${id}_companion.sock --only simulator`;
const processes = [
  { pid: 101, command: companion(udid) },
  { pid: 102, command: companion("0371776A-0FC2-4DD1-8831-8941C7D1088B") },
  // Shares a prefix with the target; a substring match would hit it.
  { pid: 103, command: companion(`${udid}-EXTRA`) },
  { pid: 104, command: `/usr/bin/tail -f /tmp/idb_companion --udid ${udid}.log` },
  { pid: 105, command: `/opt/homebrew/bin/idb ui tap 1 2 --udid ${udid}` },
];

function harness(failures: string[] = [], options: { lingering?: boolean } = {}) {
  const calls: string[][] = [], killed: [number, string][] = [];
  const living = new Set(processes.map((p) => p.pid));
  let listed = 0;
  const execute: typeof run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "ui" && failures.length) throw new Error(failures.shift());
    return { stdout: Buffer.from(""), stderr: "" };
  };
  const input = new IdbInput({
    execute,
    listProcesses: async () => { listed++; return processes.filter((p) => living.has(p.pid)); },
    kill: (pid, signal) => { killed.push([pid, signal]); if (signal === "SIGKILL" || !options.lingering) living.delete(pid); },
    alive: (pid) => living.has(pid),
    sleep: async () => {},
    now: () => 1234,
  });
  return { calls, killed, input, execute, listed: () => listed, ui: () => calls.filter((c) => c[1] === "ui") };
}

test("the stale HID matcher accepts only invalidated or interrupted dtuhidd connections", () => {
  for (const text of [invalidated, tapInvalidated, interrupted]) assert(isStaleHidConnection(text), text);
  for (const text of [
    "Touch input is not supported on tvOS targets (no touchscreen)",
    "/fixture/idb: Timed out after 15 seconds.",
    "Failed to connect to companion at /tmp/idb/X_companion.sock",
    "dtuhidd started",
  ]) assert(!isStaleHidConnection(text), text);
});
test("companion matching requires the idb_companion executable and the exact UDID token", () => {
  assert(isCompanionFor(companion(udid), udid));
  assert(isCompanionFor(companion(udid), udid.toLowerCase()));
  assert(!isCompanionFor(companion(`${udid}-EXTRA`), udid));
  assert(!isCompanionFor(companion("0371776A-0FC2-4DD1-8831-8941C7D1088B"), udid));
  assert(!isCompanionFor(`/usr/bin/tail -f /tmp/idb_companion --udid ${udid}.log`, udid));
  assert(!isCompanionFor(`/opt/homebrew/bin/idb ui tap 1 2 --udid ${udid}`, udid));
});
test("an invalidated HID connection restarts only that UDID's companion and retries once", async () => {
  const h = harness([tapInvalidated]);
  await h.input.run("/fixture/idb", ["ui", "tap", "1", "2", "--udid", udid]);
  assert.deepEqual(h.killed, [[101, "SIGTERM"]]);
  assert.deepEqual(h.calls, [
    ["/fixture/idb", "ui", "tap", "1", "2", "--udid", udid],
    ["/fixture/idb", "disconnect", udid],
    ["/fixture/idb", "ui", "tap", "1", "2", "--udid", udid],
  ]);
  assert.deepEqual(h.input.health(udid), { available: true });
});
test("a companion that ignores SIGTERM is killed, still only for the exact UDID", async () => {
  const h = harness([interrupted], { lingering: true });
  await h.input.run("/fixture/idb", ["ui", "key", "40", "--udid", udid]);
  assert.deepEqual(h.killed, [[101, "SIGTERM"], [101, "SIGKILL"]]);
  assert.equal(h.ui().length, 2);
});
test("unrelated failures are not retried and kill nothing", async () => {
  const h = harness(["Touch input is not supported on tvOS targets (no touchscreen)"]);
  await assert.rejects(h.input.run("/fixture/idb", ["ui", "tap", "1", "2", "--udid", udid]), /not supported on tvOS/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.listed(), 0);
  assert.deepEqual(h.killed, []);
  assert.deepEqual(h.input.health(udid), { available: true });
});
test("concurrent inputs on one stale companion share a single restart", async () => {
  const h = harness([invalidated, invalidated, invalidated]);
  await Promise.all([1, 2, 3].map((n) => h.input.run("/fixture/idb", ["ui", "key", String(n), "--udid", udid])));
  assert.equal(h.listed(), 1);
  assert.deepEqual(h.killed, [[101, "SIGTERM"]]);
  assert.equal(h.calls.filter((c) => c[1] === "disconnect").length, 1);
  assert.equal(h.ui().length, 6);
});

const config = (dir: string) => configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" }, tools: { idb: path.join(dir, "idb") } });
const ios = deviceSchema.parse({ id: "ios", name: "iPhone", platform: "Apple", kind: "virtual", connection: { type: "simulator", os: "ios", udid } });
const simctl = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid, state: "Booted", isAvailable: true, dataPath: "/tmp" }] } });
const description = JSON.stringify({ udid, state: "Booted", screen_dimensions: { width: 1170, height: 2532, width_points: 390, height_points: 844 } });
async function withTools<T>(body: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-idb-"));
  const previous = process.env.PATH;
  try {
    for (const name of ["idb", "idb_companion"]) { await writeFile(path.join(dir, name), "#!/bin/sh\n"); await chmod(path.join(dir, name), 0o755); }
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    return await body(dir);
  } finally { process.env.PATH = previous; await rm(dir, { recursive: true, force: true }); }
}
function deviceHarness(dir: string, failures: string[]) {
  const h = harness(failures);
  const execute: typeof run = async (command, args, timeout) => {
    if (command === "xcrun") return { stdout: Buffer.from(simctl), stderr: "" };
    if (args[0] === "describe") return { stdout: Buffer.from(description), stderr: "" };
    return h.execute(command, args, timeout);
  };
  return { ...h, execute, adapters: new Adapters(() => config(dir), execute, Date.now, h.input) };
}

test("a failed recovery reports input-unavailable, hides input capabilities, and a later success restores them", async () => {
  await withTools(async (dir) => {
    const h = deviceHarness(dir, [invalidated, invalidated]);
    assert.deepEqual((await h.adapters.inspect(ios)).capabilities.filter((c) => ["key", "text", "touch"].includes(c)), ["key", "text", "touch"]);
    await assert.rejects(h.adapters.input(ios, { key: "Home" }), (error: any) => {
      assert.equal(error.code, "input-unavailable");
      assert.equal(error.status, 503);
      assert.match(error.message, /idb_companion lost its HID connection/);
      assert.match(error.message, /restarted it and input still fails/);
      assert.match(error.message, /relaunch the simulator through its reservation, and update idb_companion/);
      return true;
    });
    assert.equal(h.ui().length, 2);
    const health = h.input.health(udid);
    assert(!health.available && health.at === 1234);
    const status = await h.adapters.inspect(ios);
    assert.equal(status.online, true);
    assert(!status.capabilities.some((c) => ["key", "text", "touch"].includes(c)), status.capabilities.join());
    assert(!status.gestureCapabilities?.length);
    assert.match(status.healthDetail, /Input unavailable: idb_companion lost its HID connection/);
    await h.adapters.input(ios, { key: "Home" });
    assert.deepEqual(h.input.health(udid), { available: true });
    assert.deepEqual((await h.adapters.inspect(ios)).capabilities.filter((c) => ["key", "text", "touch"].includes(c)), ["key", "text", "touch"]);
  });
});
test("a failed restart is named in the input-unavailable message", async () => {
  const h = harness([invalidated, invalidated]);
  const input = new IdbInput({ execute: h.execute, listProcesses: async () => { throw new Error("ps unavailable"); }, sleep: async () => {} });
  await assert.rejects(input.run("/fixture/idb", ["ui", "key", "40", "--udid", udid]), /restart failed: ps unavailable/);
});
test("remote input, the iOS gesture path and wake all recover through the shared helper", async () => {
  await withTools(async (dir) => {
    const idb = path.join(dir, "idb");
    for (const [name, send] of [
      ["key", (h: ReturnType<typeof deviceHarness>) => h.adapters.input(ios, { key: "Home" })],
      ["text", (h: ReturnType<typeof deviceHarness>) => h.adapters.input(ios, { text: "hi" })],
      ["tap", (h: ReturnType<typeof deviceHarness>) => h.adapters.input(ios, { x: 1, y: 2 })],
      ["gesture", async (h: ReturnType<typeof deviceHarness>) => {
        const source = await startIdbInteractive(ios, idb, true, h.execute, async () => true, h.input);
        await source.gesture({ type: "tap", x: 585, y: 1266, width: 1170, height: 2532 });
        await source.close();
      }],
      ["wake", (h: ReturnType<typeof deviceHarness>) => wakeSimulator(ios, idb, h.execute, h.input)],
    ] as const) {
      const h = deviceHarness(dir, [invalidated]);
      await send(h);
      assert.deepEqual(h.killed, [[101, "SIGTERM"]], name);
      assert.equal(h.ui().length, 2, name);
      assert.deepEqual(h.calls.find((c) => c[1] === "disconnect"), [idb, "disconnect", udid], name);
    }
  });
});
test("reset clears a recorded input failure (used when the simulator is relaunched)", async () => {
  const h = harness([invalidated, invalidated]);
  await assert.rejects(h.input.run("/fixture/idb", ["ui", "key", "40", "--udid", udid]), /input-unavailable|HID connection/);
  assert.equal(h.input.health(udid).available, false);
  h.input.reset(udid);
  assert.deepEqual(h.input.health(udid), { available: true });
});
