import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { CameraDiscovery } from "./camera-discovery";
import { Adapters, helper } from "./index";
import type { run } from "./process";
import { configSchema } from "../../core/src/local/types";

const cards = [{ uniqueId: "camera-one", name: "Camera", inUse: "false" }];
const response = (value: unknown) => ({ stdout: Buffer.from(JSON.stringify(value)), stderr: "" });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("one, five and ten clients share one enumeration budget and no consumers create no recurring work", async () => {
  let now = 0, starts = 0;
  const discovery = new CameraDiscovery("camera", async () => { starts++; await setImmediate(); return response(cards); }, () => now);
  await setImmediate();
  now = 60_000;
  await setImmediate();
  assert.equal(starts, 0);
  for (const clients of [1, 5, 10]) {
    const before: number = starts;
    const results = await Promise.all(Array.from({ length: clients }, () => discovery.read()));
    assert.equal(starts, before + 1);
    assert.ok(results.every((result) => result.devices.length === 1));
    await Promise.all(Array.from({ length: clients }, () => discovery.read()));
    assert.equal(starts, before + 1);
    now += 30_000;
  }
  assert.equal(discovery.stats().peakActive, 1);
  now += 600_000;
  await setImmediate();
  assert.equal(starts, 3, "aging a cache cannot start hardware work without a caller");
  await discovery.close();
});

test("forced refresh respects five-second cooldown and failures retain last facts with bounded backoff", async () => {
  let now = 0, broken = false, starts = 0;
  const discovery = new CameraDiscovery("camera", async () => { starts++; if (broken) throw new Error("unavailable"); return response(cards); }, () => now);
  const first = await discovery.read();
  first.devices[0].name = "mutated";
  assert.equal(discovery.peek().devices[0].name, "Camera");
  await discovery.read({ force: true });
  assert.equal(starts, 1);
  broken = true; now = 5000;
  const failed = await discovery.read({ force: true });
  assert.equal(failed.error, "unavailable");
  assert.equal(failed.observedAt, 0);
  assert.equal(failed.devices.length, 1);
  assert.equal(failed.stale, true);
  assert.equal(failed.nextRefreshAt, 10_000);
  discovery.invalidate();
  await discovery.read({ force: true });
  assert.equal(starts, 2, "manual refresh and invalidation cannot override backoff");
  for (const [at, retry] of [[10_000, 25_000], [25_000, 55_000], [55_000, 115_000], [115_000, 175_000]]) {
    now = at;
    assert.equal((await discovery.read({ force: true })).nextRefreshAt, retry);
  }
  broken = false; now = 175_000;
  assert.equal((await discovery.read()).error, null);
  await discovery.close();
});

test("first discovery failure is unknown; malformed data never replaces a successful observation", async () => {
  let now = 0, mode = "fail";
  const discovery = new CameraDiscovery("camera", async () => {
    if (mode === "fail") throw new Error("no camera service");
    return response(mode === "ok" ? cards : [{ uniqueId: 42 }]);
  }, () => now);
  assert.equal((await discovery.read()).observedAt, null);
  now = 5000; mode = "ok";
  await discovery.read();
  now = 35_000; mode = "bad";
  const failed = await discovery.read();
  assert.match(failed.error!, /invalid device data/);
  assert.equal(failed.devices[0].uniqueId, "camera-one");
  await discovery.close();
});

test("list and capture startup serialize, cancelled waiters never start, and shutdown waits for cleanup", async () => {
  const entered = deferred(), finish = deferred(), cleaned = deferred();
  let starts = 0, aborted = false;
  const discovery = new CameraDiscovery("camera", async () => { starts++; return response(cards); });
  const stream = discovery.initialize(async (signal) => {
    entered.resolve();
    await finish.promise;
    aborted = signal.aborted;
    cleaned.resolve();
  });
  await entered.promise;
  const listing = discovery.read();
  const controller = new AbortController();
  const cancelled = assert.rejects(discovery.initialize(async () => { throw new Error("Must not start"); }, controller.signal), /abort/i);
  controller.abort();
  await cancelled;
  assert.equal(starts, 0);
  let stopped = false;
  const close = discovery.close().then(() => { stopped = true; });
  await setImmediate();
  assert.equal(stopped, false);
  finish.resolve();
  const [, , observation] = await Promise.all([stream, close, listing, cleaned.promise]);
  assert.match(observation.error!, /stopping/);
  assert.equal(aborted, true);
  assert.equal(starts, 0);
  assert.equal(discovery.stats().queued, 0);
});

test("a pending listing gets the next initialization slot and queued deadline failures enter backoff", async () => {
  const hold = deferred(), entered = deferred();
  const order: string[] = [];
  const discovery = new CameraDiscovery("camera", async () => { order.push("list"); return response(cards); });
  const first = discovery.initialize(async () => { entered.resolve(); await hold.promise; });
  await entered.promise;
  const captures = [1, 2, 3].map((n) => discovery.initialize(async () => { order.push(`capture-${n}`); }));
  const list = discovery.read();
  hold.resolve();
  await Promise.all([first, list, ...captures]);
  assert.deepEqual(order, ["list", "capture-1", "capture-2", "capture-3"]);
  await discovery.close();

  const blocked = deferred(), running = deferred();
  const short = new CameraDiscovery("camera", async () => { throw new Error("Must not enumerate"); }, Date.now, 30_000, 5000, 20);
  const capture = short.initialize(async () => { running.resolve(); await blocked.promise; });
  await running.promise;
  // A live timer stands in for the active native helper during the deadline.
  const alive = setTimeout(() => {}, 100);
  const failed = await short.read();
  clearTimeout(alive);
  assert.equal(short.stats().starts, 0);
  assert.match(failed.error!, /timeout/i);
  assert.ok(failed.nextRefreshAt > Date.now());
  assert.equal(short.stats().queued, 0);
  blocked.resolve();
  await capture;
  await short.close();
});

test("all adapter camera entrypoints share raw results and native-only status starts no helper", async () => {
  let cameraStarts = 0;
  const execute: typeof run = async (command, args) => {
    if (command === helper) { cameraStarts++; await setImmediate(); return response(cards); }
    if (args.includes("--json-output")) await writeFile(args[args.indexOf("--json-output") + 1], '{"result":{"devices":[]}}');
    return args[0] === "simctl" ? response({ devices: {} }) : response([]);
  };
  const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" },
    sources: [{ id: "usb-one", name: "Camera", kind: "usb", uniqueId: "camera-one" }],
    devices: [{ id: "capture-one", name: "Capture", platform: "Other", kind: "physical", connection: { type: "capture" }, captureSourceId: "usb-one" }],
  });
  const adapters = new Adapters(() => config, execute);
  // Discovery's UDP network branch is an external boundary, separate from the runner.
  Object.defineProperty(adapters, "scanRoku", { value: async () => [] });
  try {
    await adapters.inspectSources([]);
    await adapters.inspectSources([{ id: "native", name: "Native", kind: "native", deviceId: "sim" }]);
    assert.equal(cameraStarts, 0);
    const [sources, cards, devices, discovered] = await Promise.all([
      adapters.inspectSources(config.sources), adapters.captureCards(config.sources),
      adapters.inspectAll(config.devices), adapters.discover(),
    ]);
    assert.equal(cameraStarts, 1);
    assert.equal(sources[0].status, "connected");
    assert.equal(cards.sources[0].status, "connected");
    assert.equal(devices[0].online, true);
    assert.ok(discovered.sources.some((source) => source.uniqueId === "camera-one"));
    await Promise.all([adapters.discover(true), adapters.captureCards(config.sources, true)]);
    assert.equal(cameraStarts, 1);
    assert.equal(adapters.inventoryStats().discovery.starts, 1);
  } finally { await adapters.close(); }
});

test("adapter source failure does not report absent hardware without a successful observation", async () => {
  const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" }, sources: [{ id: "usb", name: "USB", kind: "usb", uniqueId: "card" }] });
  const adapters = new Adapters(() => config, async () => { throw new Error("camera service unavailable"); });
  try {
    const sources = await adapters.inspectSources(config.sources);
    assert.equal(sources[0].status, "unknown");
    assert.match(sources[0].observation!.error!, /unavailable/);
    assert.equal((await adapters.captureCards(config.sources)).sources[0].status, "unknown");
  } finally { await adapters.close(); }
});

test("retained camera facts are display-only after a failed admission probe", async () => {
  let now = 0, broken = false;
  const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" },
    sources: [{ id: "usb", name: "USB", kind: "usb", uniqueId: "camera-one" }],
    devices: [{ id: "capture", name: "Capture", platform: "Other", kind: "physical", connection: { type: "capture" }, captureSourceId: "usb" }],
  });
  const adapters = new Adapters(() => config, async () => { if (broken) throw new Error("camera service unavailable"); return response(cards); }, () => now);
  try {
    assert.equal((await adapters.inspect(config.devices[0])).online, true);
    now = 5000; broken = true;
    const admission = await adapters.inspect(config.devices[0]);
    assert.equal(admission.online, false);
    assert.match(admission.healthDetail, /unavailable/);
    const display = (await adapters.inspectAll(config.devices))[0];
    assert.equal(display.online, true, "inventory keeps the last successful hardware fact");
    assert.equal(display.observation?.stale, true);
    assert.match(display.observation!.error!, /unavailable/);
  } finally { await adapters.close(); }
});
