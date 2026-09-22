import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { healthProbeRunner, ProbeScheduler } from "./health-probes";
import { Adapters } from "./index";
import type { run } from "./process";
import { configSchema, deviceSchema, type Device } from "../../core/src/local/types";

const response = (value: unknown) => ({ stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), stderr: "" });
const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" } });

test("one inventory runner shares identical probes but retains executable, arguments and cwd identity", async () => {
  const calls: string[] = [];
  const execute: typeof run = async (command, args, _timeout, options) => { calls.push(JSON.stringify([command, args, options?.cwd])); return response("ready"); };
  const probe = healthProbeRunner(execute);
  const one = probe("xcrun", ["simctl", "list", "devices", "--json"]);
  const two = probe("xcrun", ["simctl", "list", "devices", "--json"]);
  assert.equal(one, two, "concurrent callers share the same in-flight result");
  await Promise.all([one, two]);
  await probe("xcrun", ["simctl", "list", "devices", "--json"]);
  assert.equal(calls.length, 1, "later devices in this same scan reuse the read-only result");
  await Promise.all([probe("/different/xcrun", ["simctl", "list", "devices", "--json"]), probe("xcrun", ["simctl", "bootstatus", "exact-udid"]), probe("xcrun", ["simctl", "list", "devices", "--json"], undefined, { cwd: "/tmp" })]);
  assert.equal(calls.length, 4);
  await healthProbeRunner(execute)("xcrun", ["simctl", "list", "devices", "--json"]);
  assert.equal(calls.length, 5, "a new scan never inherits cached readiness");
});

test("a daemon scheduler bounds different scans together and cancels queued work without launching it", async () => {
  let active = 0, peak = 0, starts = 0;
  const releases: (() => void)[] = [];
  const scheduler = new ProbeScheduler(async (_command, _args, _timeout, options) => {
    starts++; active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => {
      const done = () => { options?.signal?.removeEventListener("abort", done); resolve(); };
      releases.push(done);
      options?.signal?.addEventListener("abort", done, { once: true });
    });
    active--;
    return response("ready");
  }, 2, 3);
  const first = healthProbeRunner(scheduler.run), second = healthProbeRunner(scheduler.run);
  const started = [first("a", []), second("b", [])];
  for (let i = 0; i < 5 && starts < 2; i++) await setImmediate();
  assert.equal(starts, 2);
  const abort = new AbortController();
  const queued = scheduler.run("cancelled", [], undefined, { signal: abort.signal });
  const rejected = assert.rejects(queued, /cancelled/);
  abort.abort();
  await rejected;
  const pending = [scheduler.run("one", []), scheduler.run("two", []), scheduler.run("three", [])];
  const failures = pending.map((promise) => assert.rejects(promise, /cancelled/));
  await assert.rejects(scheduler.run("overflow", []), /busy/);
  await scheduler.close();
  await Promise.all([...started, ...failures]);
  assert.equal(starts, 2);
  assert.equal(peak, 2);
  assert.equal(scheduler.stats().queued, 0);
});

test("health probes yield between launches and keep failures from blocking the queue or a later scan", async () => {
  const events: string[] = [];
  let active = 0, maximum = 0;
  const execute: typeof run = async (_command, args) => {
    active++; maximum = Math.max(maximum, active); events.push(args[0]);
    void setImmediate().then(() => events.push("io"));
    await setImmediate(); active--;
    if (args[0] === "broken") throw new Error("helper temporarily unavailable");
    return response("ready");
  };
  const probe = healthProbeRunner(execute, 2);
  const results = await Promise.allSettled([probe("helper", ["one"]), probe("helper", ["broken"]), probe("helper", ["broken"]), probe("helper", ["two"])]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected", "fulfilled"]);
  assert.equal(events.filter((entry) => entry === "broken").length, 1);
  assert.ok(events.indexOf("io") < events.indexOf("broken"), "the event loop can service work between process launches");
  assert.ok(maximum <= 2);
  await assert.rejects(healthProbeRunner(execute)("helper", ["broken"]), /temporarily unavailable/);
  assert.equal(events.filter((entry) => entry === "broken").length, 2, "failed results do not poison subsequent scans");
});

test("nineteen simulator rows use one list command per health scan and fresh control readiness checks", async () => {
  const devices = Array.from({ length: 19 }, (_, i) => deviceSchema.parse({
    id: `sim-${i}`, name: `Simulator ${i}`, platform: "Apple", kind: "virtual",
    connection: { type: "simulator", os: "ios", udid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` },
  }));
  let booted = false, ready = false, failed = false, now = 0;
  const calls: string[][] = [];
  const execute: typeof run = async (_command, args) => {
    calls.push(args);
    if (args[1] === "list") {
      if (failed) throw new Error("simctl temporarily unavailable");
      return response({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-2": devices.map((device, i) => ({ udid: device.connection.type === "simulator" ? device.connection.udid : "", state: i === 0 && booted ? "Booted" : "Shutdown", isAvailable: true })) } });
    }
    if (args[1] === "bootstatus") {
      assert.deepEqual(args, ["simctl", "bootstatus", "00000000-0000-4000-8000-000000000000"], "health may observe only the exact simulator and never boot it");
      if (!ready) throw new Error("SpringBoard still starting");
      return response("");
    }
    throw new Error(`Unexpected control command: ${args.join(" ")}`);
  };
  const adapters = new Adapters(() => config, execute, () => now);
  assert.ok((await adapters.inspectAll(devices)).every((device) => device.simulatorState === "shutdown"));
  assert.equal(calls.length, 1);
  booted = true;
  assert.equal((await adapters.inspectAll(devices))[0].simulatorState, "starting");
  assert.equal(calls.filter((args) => args[1] === "list").length, 2);
  ready = true;
  now += 5000;
  assert.equal((await adapters.inspectAll(devices))[0].online, true);
  ready = false;
  await assert.rejects(adapters.input(devices[0], { key: "Home" }), /still booting/);
  assert.equal(calls.filter((args) => args[1] === "list").length, 4, "control must execute a new list instead of using the successful health result");
  failed = true;
  assert.ok((await adapters.inspectAll(devices)).every((device) => !device.online && /temporarily unavailable/.test(device.healthDetail)));
  assert.equal(calls.filter((args) => args[1] === "list").length, 5, "one failed list serves the whole scan");
  failed = false; ready = true;
  assert.equal((await adapters.inspectAll(devices))[0].online, true, "next inventory retries after a failure");
});

test("physical Apple rows share one devicectl listing but independently verify each identifier", async () => {
  const devices = ["phone", "tv", "absent"].map((udid) => deviceSchema.parse({ id: udid, name: udid, platform: "Apple", kind: "physical", connection: { type: "apple-device", udid } }));
  let lists = 0;
  const execute: typeof run = async (_command, args) => {
    lists++;
    await writeFile(args[args.indexOf("--json-output") + 1], JSON.stringify({ result: { devices: [
      { identifier: "phone", hardwareProperties: { platform: "iOS" }, connectionProperties: { tunnelState: "connected" } },
      { identifier: "tv", hardwareProperties: { platform: "tvOS" }, connectionProperties: { tunnelState: "connected" } },
    ] } }));
    return response("");
  };
  const adapters = new Adapters(() => config, execute);
  const result = await adapters.inspectAll(devices);
  assert.equal(lists, 1);
  assert.deepEqual(result.map((device) => device.online), [true, true, false]);
  assert.deepEqual(result.slice(0, 2).map((device) => device.inputMode), ["touch", "remote"]);
  await adapters.inspectAll(devices);
  assert.equal(lists, 2);
});

test("health de-duplication never bypasses a fresh Android hardware identity check", async () => {
  const phone = deviceSchema.parse({ id: "phone", name: "Phone", platform: "Android", kind: "physical", connection: { type: "adb", serial: "transport", hardwareId: "hardware" } });
  let identity = "hardware", identityReads = 0;
  const execute: typeof run = async (_command, args) => {
    if (args.at(-1) === "ro.serialno") { identityReads++; return response(identity); }
    if (args.at(-1) === "get-state") return response("device");
    if (args.at(-1) === "sys.boot_completed") return response("1");
    if (args.at(-1) === "init.svc.bootanim") return response("stopped");
    if (args.at(-1) === "features") return response("feature:android.hardware.touchscreen");
    throw new Error("Unexpected probe");
  };
  const adapters = new Adapters(() => config, execute);
  assert.ok((await adapters.inspectAll([phone, phone])).every((device) => device.online));
  assert.equal(identityReads, 1);
  identity = "different-hardware";
  await assert.rejects(adapters.verifyIdentity(phone), /different hardware serial/);
  assert.equal(identityReads, 2);
});

test("completed inventory rows publish before a slow simulator probe is cancelled", async () => {
  const devices = ["slow", "stopped"].map((id, index) => deviceSchema.parse({
    id, name: id, platform: "Apple", kind: "virtual",
    connection: { type: "simulator", os: "ios", udid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` },
  }));
  const controller = new AbortController();
  const observed: string[] = [];
  let bootstatus = false;
  const execute: typeof run = async (_command, args, _timeout, options) => {
    if (args[1] === "list") return response({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-2": devices.map((device, index) => ({ udid: device.connection.type === "simulator" ? device.connection.udid : "", state: index === 0 ? "Booted" : "Shutdown", isAvailable: true })) } });
    bootstatus = true;
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return response("");
  };
  const adapters = new Adapters(() => config, execute);
  const scan = adapters.inspectAll(devices, controller.signal, (device) => observed.push(device.id));
  for (let i = 0; i < 20 && (!bootstatus || !observed.length); i++) await setImmediate();
  assert.deepEqual(observed, ["stopped"]);
  const rejected = assert.rejects(scan, /abort/i);
  controller.abort();
  await rejected;
  assert.deepEqual(observed, ["stopped"], "late cancelled work cannot publish a stale readiness result");
  await adapters.close();
});

test("large inventories inspect lazily with eight workers and retain configured order", async () => {
  const devices = Array.from({ length: 100 }, (_, index) => deviceSchema.parse({
    id: `device-${index}`, name: `Device ${index}`, platform: "Other", kind: "physical", connection: { type: "capture" },
  }));
  let active = 0, maximum = 0;
  const observed: string[] = [];
  const adapters = new Adapters(() => config, async () => { throw new Error("No subprocess expected"); });
  adapters.inspect = async (device) => {
    active++; maximum = Math.max(maximum, active);
    // Different completion order must not reorder the returned inventory.
    for (let step = 0; step < (Number(device.id.split("-")[1]) % 3) + 1; step++) await setImmediate();
    active--;
    return { ...device, online: false, locked: false, capabilities: [], healthDetail: "Fixture" };
  };
  try {
    const results = await adapters.inspectAll(devices, undefined, (device) => observed.push(device.id));
    assert.equal(maximum, 8);
    assert.equal(active, 0);
    assert.equal(observed.length, 100);
    assert.deepEqual(results.map((device) => device.id), devices.map((device) => device.id));
  } finally { await adapters.close(); }
});

test("cancelled large inventory stops assigning rows and waits for every active inspection to clean up", async () => {
  const devices = Array.from({ length: 100 }, (_, index) => deviceSchema.parse({
    id: `device-${index}`, name: `Device ${index}`, platform: "Other", kind: "physical", connection: { type: "capture" },
  }));
  const controller = new AbortController();
  let started = 0, active = 0, settled = false;
  const observed: Device[] = [];
  let cleanup!: () => void;
  const cleaned = new Promise<void>((resolve) => { cleanup = resolve; });
  const adapters = new Adapters(() => config, async () => { throw new Error("No subprocess expected"); });
  adapters.inspect = async (device) => {
    started++; active++;
    await cleaned;
    active--;
    return { ...device, online: false, locked: false, capabilities: [], healthDetail: "Fixture" };
  };
  const scan = adapters.inspectAll(devices, controller.signal, (device) => observed.push(device));
  const rejection = assert.rejects(scan, /abort/i).then(() => { settled = true; });
  try {
    assert.equal(started, 8);
    controller.abort();
    await setImmediate();
    assert.equal(started, 8);
    assert.equal(settled, false, "cancellation cannot finish before active work cleans up");
    cleanup();
    await rejection;
    assert.equal(active, 0);
    assert.equal(started, 8);
    assert.equal(observed.length, 0);
  } finally { cleanup(); await rejection; await adapters.close(); }
});
