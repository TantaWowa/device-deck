import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decideWarmPool, parseMemoryPressure, type WarmPoolInput } from "./local/warm-pool";
import { Store } from "./local/store";
import { warmPoolSettings, type WarmDevice } from "../../../packages/core/src/local/types";

const minute = 60_000;
const now = 1_000 * minute;
const entry = (deviceId: string, idleMinutes: number): WarmDevice => ({ deviceId, lastUsedAt: now - idleMinutes * minute });
const input = (overrides: Partial<WarmPoolInput> = {}): WarmPoolInput => ({
  now,
  settings: { enabled: true, idleMinutes: 240, maxBooted: 4, memoryPressure: true },
  entries: [entry("a", 10), entry("b", 20), entry("c", 30)],
  booted: ["a", "b", "c"],
  gone: [],
  busy: [],
  pressure: 1,
  ...overrides,
});

test("warm pool keeps recent devices and closes those idle past the limit", () => {
  assert.deepEqual(decideWarmPool(input()), { drop: [], close: [] });
  const decision = decideWarmPool(input({ entries: [entry("a", 10), entry("b", 241), entry("c", 500)] }));
  assert.deepEqual(decision.close, [
    { deviceId: "c", reason: "idle" },
    { deviceId: "b", reason: "idle" },
  ]);
});

test("warm pool limit counts unowned booted devices but closes only owned ones, least recently used first", () => {
  const decision = decideWarmPool(input({
    settings: { enabled: true, idleMinutes: 240, maxBooted: 3, memoryPressure: true },
    booted: ["a", "b", "c", "xcode-1", "xcode-2"],
  }));
  assert.deepEqual(decision.close, [
    { deviceId: "c", reason: "pool limit" },
    { deviceId: "b", reason: "pool limit" },
  ]);
  // Only owned candidates can be closed, even when unowned devices alone exceed the limit.
  assert.deepEqual(
    decideWarmPool(input({
      settings: { enabled: true, idleMinutes: 240, maxBooted: 1, memoryPressure: true },
      entries: [entry("a", 1)],
      booted: ["a", "xcode-1", "xcode-2", "xcode-3"],
    })).close,
    [{ deviceId: "a", reason: "pool limit" }],
  );
  // Idle closures already reduce the booted count.
  assert.deepEqual(
    decideWarmPool(input({
      settings: { enabled: true, idleMinutes: 240, maxBooted: 2, memoryPressure: true },
      entries: [entry("a", 10), entry("b", 20), entry("c", 300)],
    })).close,
    [{ deviceId: "c", reason: "idle" }],
  );
});

test("warm pool never closes reserved, locked, viewed or changing devices", () => {
  const decision = decideWarmPool(input({
    settings: { enabled: true, idleMinutes: 1, maxBooted: 1, memoryPressure: true },
    busy: ["a", "c"],
    pressure: 4,
  }));
  assert.deepEqual(decision.close, [{ deviceId: "b", reason: "idle" }]);
});

test("warm pool drops records of stopped or removed devices and ignores devices of unknown state", () => {
  const decision = decideWarmPool(input({
    settings: { enabled: true, idleMinutes: 1, maxBooted: 4, memoryPressure: true },
    booted: ["a"],
    gone: ["b"],
  }));
  assert.deepEqual(decision.drop, ["b"]);
  // "c" is neither booted nor known stopped: it is kept and not closed.
  assert.deepEqual(decision.close, [{ deviceId: "a", reason: "idle" }]);
});

test("critical memory pressure closes one device per tick; warning closes only a device unused for 30 minutes", () => {
  assert.deepEqual(decideWarmPool(input({ pressure: 4 })).close, [{ deviceId: "c", reason: "memory pressure" }]);
  // A recently used device survives sustained warning-level pressure.
  assert.deepEqual(decideWarmPool(input({ pressure: 2 })), { drop: [], close: [] });
  assert.deepEqual(
    decideWarmPool(input({ pressure: 2, entries: [entry("a", 10), entry("b", 31), entry("c", 45)] })).close,
    [{ deviceId: "c", reason: "memory pressure" }],
  );
  assert.deepEqual(
    decideWarmPool(input({ pressure: 4, settings: { enabled: true, idleMinutes: 240, maxBooted: 4, memoryPressure: false } })).close,
    [],
  );
});

test("unreadable memory pressure counts as normal", () => {
  assert.equal(parseMemoryPressure("4\n"), 4);
  assert.equal(parseMemoryPressure("2"), 2);
  assert.equal(parseMemoryPressure("1"), 1);
  assert.equal(parseMemoryPressure(""), 1);
  assert.equal(parseMemoryPressure("sysctl: unknown oid"), 1);
});

test("a disabled warm pool closes every idle device it still owns", () => {
  const decision = decideWarmPool(input({
    settings: { enabled: false, idleMinutes: 240, maxBooted: 4, memoryPressure: true },
    busy: ["b"],
  }));
  assert.deepEqual(decision.close.map((item) => item.deviceId), ["c", "a"]);
  assert.ok(decision.close.every((item) => item.reason === "warm pool disabled"));
});

test("warm pool settings default from host memory", () => {
  const settings = { folder: "/c", naming: "", owner: "o", ttl: 15, overlay: true, logging: true, clipboard: false,
    captureMode: "clean" as const, maxRecordingMinutes: 15, previewIntervalMs: 750 };
  assert.deepEqual(warmPoolSettings(settings, 64 * 2 ** 30), { enabled: true, idleMinutes: 240, maxBooted: 10, memoryPressure: true });
  assert.equal(warmPoolSettings(settings, 8 * 2 ** 30).maxBooted, 2);
  assert.equal(warmPoolSettings({ ...settings, warmPool: { enabled: true, idleMinutes: 30, maxBooted: 5, memoryPressure: false } }, 8 * 2 ** 30).maxBooted, 5);
});

test("warm device records survive a store reload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-warm-"));
  const file = path.join(dir, "state.sqlite");
  try {
    const store = new Store(file);
    store.putWarmDevice({ deviceId: "one", simulatorLaunch: { type: "android-emulator", avdName: "Tv", marker: "m".repeat(32) }, lastUsedAt: 5 });
    store.putWarmDevice({ deviceId: "two", lastUsedAt: 6 });
    store.touchWarmDevice("two", 9);
    store.touchWarmDevice("missing", 9);
    store.close();
    const reloaded = new Store(file);
    assert.deepEqual(reloaded.warmDevices().sort((a, b) => a.deviceId.localeCompare(b.deviceId)), [
      { deviceId: "one", simulatorLaunch: { type: "android-emulator", avdName: "Tv", marker: "m".repeat(32) }, lastUsedAt: 5 },
      { deviceId: "two", lastUsedAt: 9 },
    ]);
    reloaded.dropWarmDevice("one");
    assert.equal(reloaded.warmDevice("one"), undefined);
    reloaded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
