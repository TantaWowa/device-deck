import test from "node:test";
import { licensedManager } from "../../../tests/licensing";
import { LocalDevelopmentLicense } from "../../../scripts/local-license";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createService } from "./server";
import { DeckService } from "./local/service";
import { Store } from "./local/store";
import type { InteractiveSource } from "../../../packages/core/src/live";
import { Adapters } from "../../../packages/adapters/src";
import {
  CaptureEngine,
  type RecordingHandle,
} from "../../../packages/capture/src";
import {
  DeckError,
  type DeviceConfig,
  type Device,
  type Config,
  type Input,
  type SimulatorLaunchOwnership,
  type Source,
  type SourceConfig,
} from "../../../packages/core/src/local/types";
const config: Config = {
  schemaVersion: 1,
  port: 0,
  devices: [],
  sources: [],
  ignoredCaptureCardIds: [],
  settings: {
    folder: "./captures",
    naming: "{device}-{time}",
    owner: "Test",
    ttl: 15,
    overlay: true,
    logging: true,
    clipboard: false,
    captureMode: "clean",
    maxRecordingMinutes: 15,
    previewIntervalMs: 750,
  },
  tools: {},
  savedViews: [],
};
class TestAdapters extends Adapters {
  inputs: string[] = [];
  wakes: string[] = [];
  constructor() {
    super(() => config);
  }
  async diagnostics() {
    return [];
  }
  async inspect(d: DeviceConfig): Promise<Device> {
    return {
      ...d,
      online: true,
      locked: false,
      healthDetail: "Test fixture",
      capabilities: ["key", "preview", "screenshot", "record"],
    };
  }
  async inspectSources(_sources: SourceConfig[] = []): Promise<Source[]> {
    return [];
  }
  async input(d: DeviceConfig) {
    this.inputs.push(d.id);
  }
  async wake(d: DeviceConfig) {
    this.wakes.push(d.id);
    return { method: "Fixture wake" };
  }
}
class TestCapture extends CaptureEngine {
  verifiedDevice?: DeviceConfig;
  previewed: string[] = [];
  async preview(_device: DeviceConfig | null, source: { id: string }) {
    this.previewed.push(source.id);
    return Buffer.from([255, 216, 255, 217]);
  }
  resolveStop?: () => void;
  starts = 0;
  stops = 0;
  disconnected?: (reason: string) => void;
  async startRecording(
    id: string,
    d: DeviceConfig,
    _s: unknown,
    file: string,
  ): Promise<RecordingHandle> {
    this.starts++;
    let endedResolve: (reason: string | undefined) => void = () => {};
    const ended = new Promise<string | undefined>((r) => (endedResolve = r));
    this.disconnected = (r) => endedResolve(r);
    return {
      id,
      device: this.verifiedDevice,
      deviceId: d.id,
      path: file,
      startedAt: Date.now(),
      startedMono: performance.now(),
      ended,
      stop: async () => {
        this.stops++;
        if (this.resolveStop === undefined)
          await new Promise<void>((r) => (this.resolveStop = r));
        endedResolve(undefined);
        return { duration: 1, bytes: 10 };
      },
    };
  }
  async closeSource(_source: any) {}
  async close() {}
}
async function setup(
  free = false,
  groupReadiness: {
    timeoutMs?: number;
    retryIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-service-"));
  const adapters = new TestAdapters(),
    capture = new TestCapture(adapters);
  const licensed = free ? undefined : await licensedManager(dir);
  const deck = new DeckService(
    dir,
    undefined,
    adapters,
    capture,
    licensed?.manager,
    groupReadiness,
  );
  await deck.init();
  const c = structuredClone(deck.config.config);
  c.settings.folder = path.join(dir, "captures");
  for (const id of ["one", "two"]) {
    c.devices.push({
      id,
      name: id,
      platform: "Android",
      kind: "virtual",
      model: "fixture",
      visibility: "local",
      connection: { type: "adb", serial: id, port: 5037 },
      captureSourceId: "screen-" + id,
    });
    c.sources.push({
      id: "screen-" + id,
      name: id,
      kind: "native",
      deviceId: id,
    });
  }
  await deck.execute("config.save", {
    config: c,
    revision: deck.config.revision,
  });
  return {
    dir,
    deck,
    adapters,
    capture,
    licenseProvider: licensed?.provider,
    cleanup: async () => {
      capture.resolveStop?.();
      await deck.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const reserve = (deck: DeckService, device = "one") =>
  deck.execute("sessions.reserve", {
    selector: { device },
    owner: "same label",
    reason: "test",
  }) as Promise<{ session: { id: string }; leaseToken: string }>;
async function useSimulator(deck: DeckService) {
  const c = structuredClone(deck.config.config);
  c.devices[0].platform = "Apple";
  c.devices[0].connection = {
    type: "simulator",
    os: "tvos",
    udid: "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
  };
  await deck.execute("config.save", {
    config: c,
    revision: deck.config.revision,
  });
}
async function useAndroidAvd(deck: DeckService) {
  const c = structuredClone(deck.config.config);
  c.devices[0].connection = {
    type: "adb",
    serial: "emulator-5558",
    avdName: "Television_1080p",
    port: 5037,
  };
  c.devices[0].inputMode = "remote";
  await deck.execute("config.save", {
    config: c,
    revision: deck.config.revision,
  });
}
test("group reservation cold-starts, authenticates, restores and releases idempotently", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  const actions: string[] = [];
  try {
    await useSimulator(deck);
    const current = structuredClone(deck.config.config);
    current.devices[0].tags = ["ci"];
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    const inspect = adapters.inspect.bind(adapters);
    adapters.inspect = async (device) =>
      device.id === "one"
        ? {
            ...device,
            online: running,
            locked: false,
            healthDetail: running ? "Ready" : "Stopped",
            capabilities: [],
            simulatorState: running ? "booted" : "shutdown",
          }
        : inspect(device);
    adapters.simulator = async (device, action, beforeLaunch) => {
      if (action === "launch") {
        await beforeLaunch?.();
        assert.equal(
          deck.store.group("test/group/one").members[0].startedByGroup,
          true,
          "cold-start ownership is durable before lifecycle mutation",
        );
      }
      actions.push(action);
      running = action === "launch";
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        changed: true,
      };
    };
    const request = {
      version: 1,
      groupId: "test/group/one",
      leaseToken: "a".repeat(43),
      owner: "CI",
      reason: "Native regression",
      requests: {
        television: {
          selector: {
            platform: "Apple",
            kind: "virtual",
            formFactor: "tv",
            tags: ["ci"],
          },
        },
      },
    } as const;
    const reserved: any = await deck.execute("sessions.reserveGroup", request);
    assert.equal(reserved.devices.television.id, "one");
    assert.equal(reserved.devices.television.startedByGroup, true);
    assert.deepEqual(actions, ["launch"]);
    adapters.verifyIdentity = async () => {
      throw new Error("Transient simulator identity lookup failed");
    };
    const retried: any = await deck.execute("sessions.reserveGroup", request);
    assert.equal(
      retried.devices.television.sessionId,
      reserved.devices.television.sessionId,
    );
    assert.deepEqual(
      retried.devices.television.connection,
      reserved.devices.television.connection,
    );
    assert.deepEqual(actions, ["launch"]);
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        ...request,
        reason: "A different reservation request",
      }),
      (error) => (error as any).code === "group-conflict",
    );
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        ...request,
        leaseToken: "w".repeat(43),
      }),
      (error) => (error as any).code === "invalid-lease",
    );
    running = false;
    await assert.rejects(
      deck.execute("sessions.reserveGroup", request),
      (error) => (error as any).code === "group-not-ready",
    );
    running = true;
    await assert.rejects(
      deck.execute("sessions.releaseGroup", {
        groupId: reserved.groupId,
        leaseToken: "not-the-token",
      }),
      /does not own/,
    );
    await assert.rejects(
      deck.execute("sessions.takeover", {
        deviceId: "one",
        owner: "Operator",
        reason: "interrupt",
        confirmed: true,
      }),
      /owning reservation group/,
    );
    const released: any = await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.equal(released.state, "closed");
    assert.deepEqual(actions, ["launch", "close"]);
    assert.equal(running, false);
    const repeated: any = await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.equal(repeated.state, "closed");
    assert.deepEqual(actions, ["launch", "close"]);
  } finally {
    await cleanup();
  }
});

test("group reservation waits for a warm emulator identity without owning its lifecycle", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 100,
    retryIntervalMs: 0,
  });
  const actions: string[] = [];
  let preparationInspections = 0;
  try {
    await useAndroidAvd(deck);
    adapters.inspect = async (device) => {
      const preparing = deck.store.groups().some(
        (group) => group.state === "preparing",
      );
      if (preparing && device.id === "one") preparationInspections++;
      const ready = preparing && preparationInspections >= 3;
      return {
        ...device,
        online: ready,
        locked: false,
        healthDetail: ready
          ? "Ready"
          : "An emulator connection is present but its AVD identity is not available yet.",
        capabilities: [],
        readiness: ready ? "ready" : "starting",
        simulatorState: ready ? "booted" : "starting",
      };
    };
    adapters.verifyIdentity = async (device) => ({
      ...device,
      connection: device.connection.type === "adb"
        ? { ...device.connection, serial: "emulator-5572" }
        : device.connection,
    });
    adapters.simulator = async (device, action) => {
      actions.push(action);
      return {
        deviceId: device.id,
        action,
        state: action === "launch" ? "booted" : "shutdown",
        changed: true,
      };
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/warm-identity-pending",
      leaseToken: "i".repeat(43),
      owner: "CI",
      reason: "Warm Android identity stabilization",
      requests: { television: { selector: { device: "one" } } },
    });
    assert.equal(preparationInspections, 3);
    assert.equal(reserved.devices.television.startedByGroup, false);
    assert.equal(
      reserved.devices.television.connection.serial,
      "emulator-5572",
    );
    assert.deepEqual(actions, []);
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.deepEqual(actions, []);
  } finally {
    await cleanup();
  }
});

test("parallel cold AVD starts retry while a sibling launch identity is pending", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 1_000,
    retryIntervalMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const states = new Map<string, "shutdown" | "unidentified" | "booted">([
    ["one", "shutdown"],
    ["two", "shutdown"],
  ]);
  let firstSpawned: (() => void) | undefined;
  const siblingIsUnidentified = new Promise<void>(
    (resolve) => (firstSpawned = resolve),
  );
  let finishFirst: (() => void) | undefined;
  const firstMayIdentify = new Promise<void>(
    (resolve) => (finishFirst = resolve),
  );
  const actualLaunches: string[] = [];
  let secondControlAttempts = 0;
  try {
    const current = structuredClone(deck.config.config);
    current.devices[0].connection = {
      type: "adb",
      serial: "emulator-5554",
      avdName: "Phone_API_36",
      port: 5037,
    };
    current.devices[1].connection = {
      type: "adb",
      serial: "emulator-5558",
      avdName: "Television_1080p",
      port: 5037,
    };
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    adapters.inspect = async (device) => {
      const state = states.get(device.id)!;
      return {
        ...device,
        online: state === "booted",
        locked: false,
        healthDetail: state === "booted" ? "Ready" : "Stopped",
        capabilities: [],
        readiness: state === "booted" ? "ready" : "offline",
        simulatorState: state === "booted" ? "booted" : "shutdown",
      };
    };
    adapters.verifyIdentity = async (device) => device;
    adapters.prepareSimulator = async (device) => {
      if (device.id === "two") await siblingIsUnidentified;
      return device;
    };
    adapters.simulator = async (device, action, beforeLaunch) => {
      if (action === "close") {
        states.set(device.id, "shutdown");
        return {
          deviceId: device.id,
          action,
          state: "shutdown" as const,
          changed: true,
        };
      }
      if (device.id === "two") {
        secondControlAttempts++;
        if (states.get("one") === "unidentified") {
          finishFirst?.();
          throw new DeckError(
            "emulator-identity-pending",
            "A sibling emulator identity is not available yet.",
            409,
          );
        }
      }
      await beforeLaunch?.();
      actualLaunches.push(device.id);
      if (device.id === "one") {
        states.set("one", "unidentified");
        firstSpawned?.();
        await firstMayIdentify;
      }
      states.set(device.id, "booted");
      return {
        deviceId: device.id,
        action,
        state: "booted" as const,
        changed: true,
      };
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/parallel-cold-avds",
      leaseToken: "p".repeat(43),
      owner: "CI",
      reason: "Parallel Android cold starts",
      requests: {
        phone: { selector: { device: "one" } },
        television: { selector: { device: "two" } },
      },
    });
    assert.equal(secondControlAttempts, 2);
    assert.deepEqual(actualLaunches.sort(), ["one", "two"]);
    assert.equal(reserved.devices.phone.startedByGroup, true);
    assert.equal(reserved.devices.television.startedByGroup, true);
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.deepEqual([...states.values()], ["shutdown", "shutdown"]);
  } finally {
    finishFirst?.();
    await cleanup();
  }
});

test("a cold start keeps ownership while its spawned AVD identity becomes readable", async () => {
  let state: "shutdown" | "identity-pending" | "booted" = "shutdown";
  const { deck, adapters, cleanup } = await setup(false, {
    // Test-only headroom: loaded Intel runners can spend over a second before
    // reaching the deterministic sleep hook that advances the mocked state.
    timeoutMs: 10_000,
    retryIntervalMs: 0,
    sleep: async () => {
      if (state === "identity-pending") state = "booted";
    },
  });
  let launches = 0;
  let closes = 0;
  try {
    await useAndroidAvd(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: state === "booted",
      locked: false,
      healthDetail: state === "booted" ? "Ready" : "Not ready",
      capabilities: [],
      readiness: state === "booted"
        ? "ready"
        : state === "identity-pending"
          ? "starting"
          : "offline",
      simulatorState: state === "booted"
        ? "booted"
        : state === "identity-pending"
          ? "starting"
          : "shutdown",
    });
    adapters.verifyIdentity = async (device) => device;
    adapters.simulator = async (device, action, beforeLaunch) => {
      if (action === "close") {
        closes++;
        state = "shutdown";
        return {
          deviceId: device.id,
          action,
          state: "shutdown" as const,
          changed: true,
        };
      }
      launches++;
      await beforeLaunch?.();
      state = "identity-pending";
      throw new DeckError(
        "emulator-identity-pending",
        "The new AVD identity is not readable yet.",
        409,
      );
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/post-launch-identity",
      leaseToken: "u".repeat(43),
      owner: "CI",
      reason: "Post-launch identity stabilization",
      requests: { television: { selector: { device: "one" } } },
    });
    assert.equal(launches, 1);
    assert.equal(reserved.devices.television.startedByGroup, true);
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.equal(closes, 1);
    assert.equal(state, "shutdown");
  } finally {
    await cleanup();
  }
});

test("failed group preparation restores an offline Android launch through its durable ownership marker", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 1_000,
    retryIntervalMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "Television_1080p",
    marker: "d".repeat(32),
  };
  let androidState: "shutdown" | "identity-pending" = "shutdown";
  let androidStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => (androidStarted = resolve));
  let cleanupOwnership: SimulatorLaunchOwnership | undefined;
  try {
    const current = structuredClone(deck.config.config);
    current.devices[0].connection = {
      type: "adb",
      serial: "emulator-5554",
      avdName: "Television_1080p",
      port: 5037,
    };
    current.devices[1].platform = "Apple";
    current.devices[1].connection = {
      type: "simulator",
      os: "tvos",
      udid: "7829DB75-6928-4E9C-982A-4AF899FA404D",
    };
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    adapters.inspect = async (device) => ({
      ...device,
      online: false,
      locked: false,
      healthDetail: device.id === "one" && androidState === "identity-pending"
        ? "AVD identity is not available yet"
        : "Stopped",
      capabilities: [],
      readiness: device.id === "one" && androidState === "identity-pending"
        ? "starting"
        : "offline",
      simulatorState: device.id === "one" && androidState === "identity-pending"
        ? "starting"
        : "shutdown",
    });
    adapters.prepareSimulator = async (device) => device;
    adapters.simulator = async (
      device,
      action,
      beforeLaunch,
      savedOwnership,
    ) => {
      if (action === "close") {
        if (device.id === "one") {
          cleanupOwnership = savedOwnership;
          androidState = "shutdown";
        }
        return {
          deviceId: device.id,
          action,
          state: "shutdown" as const,
          changed: true,
        };
      }
      if (device.id === "one") {
        await beforeLaunch?.(ownership);
        assert.deepEqual(
          deck.store.group("test/group/offline-avd-rollback").members[0]
            .simulatorLaunch,
          ownership,
          "the cleanup identity is durable before the emulator process starts",
        );
        androidState = "identity-pending";
        androidStarted?.();
        throw new DeckError(
          "emulator-identity-pending",
          "The launched AVD is offline and has no readable identity.",
          409,
        );
      }
      await started;
      throw new Error("tvOS simulator data is missing");
    };
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/offline-avd-rollback",
        leaseToken: "o".repeat(43),
        owner: "CI",
        reason: "Atomic native setup",
        requests: {
          androidTv: { selector: { device: "one" } },
          tvos: { selector: { device: "two" } },
        },
      }),
      /tvOS simulator data is missing/,
    );
    assert.deepEqual(cleanupOwnership, ownership);
    assert.equal(androidState, "shutdown");
    assert.equal(
      deck.store.group("test/group/offline-avd-rollback").state,
      "closed",
    );
    assert.equal(deck.store.lockReason("one"), undefined);
  } finally {
    androidStarted?.();
    await cleanup();
  }
});

test("group reservation retries transient identity verification after readiness", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 100,
    retryIntervalMs: 0,
  });
  let identityAttempts = 0;
  try {
    adapters.verifyIdentity = async (device) => {
      identityAttempts++;
      if (identityAttempts === 1)
        throw new DeckError(
          "emulator-identity-pending",
          "AVD identity is still becoming readable.",
          409,
        );
      return device;
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/transient-identity",
      leaseToken: "j".repeat(43),
      owner: "CI",
      reason: "Transient identity",
      requests: { target: { selector: { device: "one" } } },
    });
    assert.equal(identityAttempts, 2);
    assert.equal(reserved.devices.target.id, "one");
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
  } finally {
    await cleanup();
  }
});

test("group reservation rolls back immediately on a permanent identity mismatch", async () => {
  let sleeps = 0;
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 120_000,
    retryIntervalMs: 1_000,
    sleep: async () => {
      sleeps++;
    },
  });
  let identityAttempts = 0;
  try {
    adapters.verifyIdentity = async () => {
      identityAttempts++;
      throw new DeckError(
        "identity-mismatch",
        "The transport belongs to another device.",
        409,
      );
    };
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/permanent-identity",
        leaseToken: "m".repeat(43),
        owner: "CI",
        reason: "Permanent identity mismatch",
        requests: { target: { selector: { device: "one" } } },
      }),
      (error) => (error as any).code === "identity-mismatch",
    );
    assert.equal(identityAttempts, 1);
    assert.equal(sleeps, 0);
    assert.equal(
      deck.store.group("test/group/permanent-identity").state,
      "closed",
    );
  } finally {
    await cleanup();
  }
});

test("sibling cancellation preserves the first permanent preparation failure", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 1_000,
    retryIntervalMs: 0,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  try {
    adapters.inspect = async (device) => {
      const preparing = deck.store.groups().some(
        (group) => group.state === "preparing",
      );
      const waiting = preparing && device.id === "one";
      return {
        ...device,
        online: !waiting,
        locked: false,
        healthDetail: waiting ? "Still becoming ready" : "Ready",
        capabilities: [],
        readiness: waiting ? "starting" : "ready",
        ...(waiting ? { simulatorState: "starting" as const } : {}),
      };
    };
    adapters.verifyIdentity = async (device) => {
      if (device.id === "two")
        throw new DeckError(
          "identity-mismatch",
          "The second transport belongs to another device.",
          409,
        );
      return device;
    };
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/root-preparation-failure",
        leaseToken: "v".repeat(43),
        owner: "CI",
        reason: "Preserve root failure",
        requests: {
          waitingFirst: { selector: { device: "one" } },
          failingSecond: { selector: { device: "two" } },
        },
      }),
      (error) =>
        (error as any).code === "identity-mismatch" &&
        /second transport/.test((error as Error).message),
    );
    assert.equal(
      deck.store.group("test/group/root-preparation-failure").state,
      "closed",
    );
  } finally {
    await cleanup();
  }
});

test("a warm identity-pending emulator times out without being launched or closed", async () => {
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 0,
    retryIntervalMs: 0,
  });
  const actions: string[] = [];
  try {
    await useAndroidAvd(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: false,
      locked: false,
      healthDetail:
        "An emulator connection is present but its AVD identity is not available yet.",
      capabilities: [],
      readiness: "starting",
      simulatorState: "starting",
    });
    adapters.simulator = async (device, action) => {
      actions.push(action);
      return {
        deviceId: device.id,
        action,
        state: action === "launch" ? "booted" : "shutdown",
        changed: true,
      };
    };
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/warm-timeout",
        leaseToken: "k".repeat(43),
        owner: "CI",
        reason: "Warm identity timeout",
        requests: { television: { selector: { device: "one" } } },
      }),
      (error) => {
        assert.equal(
          (error as any).code,
          "group-device-readiness-timeout",
        );
        assert.deepEqual((error as any).details, {
          groupId: "test/group/warm-timeout",
          alias: "television",
          deviceId: "one",
          timeoutMs: 0,
          healthDetail:
            "An emulator connection is present but its AVD identity is not available yet.",
          identityError: undefined,
        });
        return true;
      },
    );
    assert.deepEqual(actions, []);
    assert.equal(deck.store.group("test/group/warm-timeout").state, "closed");
    assert.ok(
      deck.store.sessions().every((session) => session.state === "closed"),
    );
  } finally {
    await cleanup();
  }
});

test("release cancels an allocator readiness wait without launching a warm emulator", async () => {
  let continueRetry: (() => void) | undefined;
  let retryWaiting: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => (retryWaiting = resolve));
  const { deck, adapters, cleanup } = await setup(false, {
    timeoutMs: 120_000,
    retryIntervalMs: 1_000,
    sleep: async () => {
      retryWaiting?.();
      await new Promise<void>((resolve) => (continueRetry = resolve));
    },
  });
  const actions: string[] = [];
  try {
    await useAndroidAvd(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: false,
      locked: false,
      healthDetail: "AVD identity pending",
      capabilities: [],
      readiness: "starting",
      simulatorState: "starting",
    });
    adapters.simulator = async (device, action) => {
      actions.push(action);
      return {
        deviceId: device.id,
        action,
        state: action === "launch" ? "booted" : "shutdown",
        changed: true,
      };
    };
    const groupId = "test/group/release-readiness-wait";
    const leaseToken = "l".repeat(43);
    const reserving = deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId,
      leaseToken,
      owner: "CI",
      reason: "Cancel readiness wait",
      requests: { television: { selector: { device: "one" } } },
    });
    await waiting;
    const releasing = deck.execute("sessions.releaseGroup", {
      groupId,
      leaseToken,
    });
    while (deck.store.group(groupId).state !== "closing")
      await new Promise((resolve) => setImmediate(resolve));
    continueRetry?.();
    await assert.rejects(
      reserving,
      (error) => (error as any).code === "group-preparation-cancelled",
    );
    await releasing;
    assert.deepEqual(actions, []);
    assert.equal(deck.store.group(groupId).state, "closed");
  } finally {
    continueRetry?.();
    await cleanup();
  }
});

test("simultaneous group retries share admission and report preparation deterministically", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  let finishLaunch: (() => void) | undefined;
  let launchEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => (launchEntered = resolve));
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      if (action === "launch") {
        launchEntered?.();
        await new Promise<void>((resolve) => (finishLaunch = resolve));
        running = true;
      } else running = false;
      return {
        deviceId: device.id,
        action,
        state: running ? ("booted" as const) : ("shutdown" as const),
        changed: true,
      };
    };
    const request = {
      version: 1,
      groupId: "test/group/concurrent-retry",
      leaseToken: "y".repeat(43),
      owner: "CI",
      reason: "Concurrent retry",
      requests: { simulator: { selector: { device: "one" } } },
    } as const;
    const attempts = [
      deck.execute("sessions.reserveGroup", request),
      deck.execute("sessions.reserveGroup", request),
    ];
    await entered;
    const early = await Promise.race(
      attempts.map((attempt, index) =>
        attempt.then(
          (value) => ({ index, status: "fulfilled" as const, value }),
          (reason) => ({ index, status: "rejected" as const, reason }),
        ),
      ),
    );
    if (early.status !== "rejected")
      assert.fail("The retry completed before the first reservation was ready.");
    assert.equal((early.reason as any).code, "group-preparing");

    finishLaunch?.();
    const winning = await attempts[early.index === 0 ? 1 : 0] as any;
    const replayed: any = await deck.execute("sessions.reserveGroup", request);
    assert.equal(
      replayed.devices.simulator.sessionId,
      winning.devices.simulator.sessionId,
    );
    await deck.execute("sessions.releaseGroup", {
      groupId: winning.groupId,
      leaseToken: winning.leaseToken,
    });
  } finally {
    finishLaunch?.();
    await cleanup();
  }
});

test("group release reports a never-created group distinctly from a wrong credential", async () => {
  const { deck, cleanup } = await setup();
  try {
    await assert.rejects(
      deck.execute("sessions.releaseGroup", {
        groupId: "test/group/never-created",
        leaseToken: "z".repeat(43),
      }),
      (error) => (error as any).code === "group-not-found",
    );
  } finally {
    await cleanup();
  }
});

test("a launch race does not make the group own an already-started simulator", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  const actions: string[] = [];
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      actions.push(action);
      if (action === "launch") running = true;
      else running = false;
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        // Another actor completed startup after our inspection but before the
        // lifecycle admission check. Device Deck did not cold-start it.
        changed: false,
      };
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/launch-race",
      leaseToken: "r".repeat(43),
      owner: "CI",
      reason: "Launch race",
      requests: { simulator: { selector: { device: "one" } } },
    });
    assert.equal(reserved.devices.simulator.startedByGroup, false);
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.deepEqual(actions, ["launch"]);
    assert.equal(running, true);
  } finally {
    await cleanup();
  }
});

test("release during a launch race reloads ownership before restoring simulators", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  let finishLaunch: (() => void) | undefined;
  let launchEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => (launchEntered = resolve));
  const actions: string[] = [];
  const groupId = "test/group/release-launch-race";
  const leaseToken = "q".repeat(43);
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      actions.push(action);
      if (action === "launch") {
        launchEntered?.();
        await new Promise<void>((resolve) => (finishLaunch = resolve));
        running = true;
        return {
          deviceId: device.id,
          action,
          state: "booted" as const,
          changed: false,
        };
      }
      running = false;
      return {
        deviceId: device.id,
        action,
        state: "shutdown" as const,
        changed: true,
      };
    };
    const request = {
      version: 1,
      groupId,
      leaseToken,
      owner: "CI",
      reason: "Launch/release race",
      requests: { simulator: { selector: { device: "one" } } },
    } as const;
    const reserving = deck.execute("sessions.reserveGroup", request);
    await entered;
    await assert.rejects(
      deck.execute("sessions.reserveGroup", request),
      (error) => (error as any).code === "group-preparing",
    );
    const releasing = deck.execute("sessions.releaseGroup", {
      groupId,
      leaseToken,
    });
    while (deck.store.group(groupId).state !== "closing")
      await new Promise((resolve) => setImmediate(resolve));
    finishLaunch?.();
    await assert.rejects(reserving, /expired or was cancelled/);
    await releasing;
    assert.deepEqual(actions, ["launch"]);
    assert.equal(running, true);
    assert.equal(deck.store.group(groupId).state, "closed");
  } finally {
    finishLaunch?.();
    await cleanup();
  }
});

test("group reservation rolls back every claim and cold start when preparation fails", async () => {
  const { deck, adapters, cleanup } = await setup();
  const actions: string[] = [];
  const running = new Set<string>();
  try {
    const current = structuredClone(deck.config.config);
    for (const [index, device] of current.devices.entries()) {
      device.platform = "Apple";
      device.connection = {
        type: "simulator",
        os: "ios",
        udid: index
          ? "7829DB75-6928-4E9C-982A-4AF899FA404D"
          : "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
      };
    }
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    adapters.inspect = async (device) => ({
      ...device,
      online: running.has(device.id),
      locked: false,
      healthDetail: running.has(device.id) ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running.has(device.id) ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      actions.push(`${action}:${device.id}`);
      if (action === "launch" && device.id === "two")
        throw new Error("Fixture boot failed");
      if (action === "launch") running.add(device.id);
      else running.delete(device.id);
      return {
        deviceId: device.id,
        action,
        state: action === "launch" ? "booted" : "shutdown",
        changed: true,
      };
    };
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/rollback",
        leaseToken: "b".repeat(43),
        owner: "CI",
        reason: "Atomic setup",
        requests: {
          first: { selector: { device: "one" } },
          second: { selector: { device: "two" } },
        },
      }),
      /Fixture boot failed/,
    );
    assert.ok(deck.store.sessions().every((session) => session.state === "closed"));
    assert.equal(deck.store.group("test/group/rollback").state, "closed");
    assert.equal(deck.store.lockReason("one"), undefined);
    assert.equal(deck.store.lockReason("two"), undefined);
    assert.ok(actions.includes("close:one"));
    assert.ok(actions.includes("launch:two"));
    assert.equal(
      actions.includes("close:two"),
      false,
      "a launch that fails before claiming lifecycle ownership is not closed",
    );
  } finally {
    await cleanup();
  }
});

test("failed group cleanup protects config and maintenance state until retry succeeds", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  let closeAttempts = 0;
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      if (action === "launch") running = true;
      else if (++closeAttempts === 1) throw new Error("close failed once");
      else running = false;
      return {
        deviceId: device.id,
        action,
        state: running ? ("booted" as const) : ("shutdown" as const),
        changed: true,
      };
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/cleanup-retry",
      leaseToken: "c".repeat(43),
      owner: "CI",
      reason: "Cleanup retry",
      requests: { simulator: { selector: { device: "one" } } },
    });
    await assert.rejects(
      deck.execute("sessions.releaseGroup", {
        groupId: reserved.groupId,
        leaseToken: reserved.leaseToken,
      }),
      /close failed once/,
    );
    assert.equal(deck.store.group(reserved.groupId).state, "closing");
    assert.match(deck.store.lockReason("one") || "", /cleanup/);

    const changedDevice = structuredClone(deck.config.config);
    changedDevice.devices[0].name = "Changed while closing";
    await assert.rejects(
      deck.execute("config.save", {
        config: changedDevice,
        revision: deck.config.revision,
      }),
      /Release the affected session/,
    );
    const changedTools = structuredClone(deck.config.config);
    changedTools.tools.adb = "/different/adb";
    await assert.rejects(
      deck.execute("config.save", {
        config: changedTools,
        revision: deck.config.revision,
      }),
      /Release sessions/,
    );
    const maintenance: any = await deck.execute("devices.bulk", {
      ids: ["one"],
      action: "unlock",
      reason: "Operator override",
    });
    assert.equal(maintenance[0].ok, false);
    assert.match(maintenance[0].error, /Finish reservation group cleanup/);
    assert.match(deck.store.lockReason("one") || "", /cleanup/);

    const released: any = await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
    assert.equal(released.state, "closed");
    assert.equal(deck.store.lockReason("one"), undefined);
    assert.equal(running, false);
  } finally {
    await cleanup();
  }
});

test("group expiry closes every member and restores only virtuals cold-started by the group", async () => {
  const { deck, adapters, cleanup } = await setup();
  const running = new Set<string>(["two"]);
  const actions: string[] = [];
  try {
    const current = structuredClone(deck.config.config);
    for (const [index, device] of current.devices.entries()) {
      device.platform = "Apple";
      device.connection = {
        type: "simulator",
        os: "ios",
        udid: index
          ? "7829DB75-6928-4E9C-982A-4AF899FA404D"
          : "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1",
      };
    }
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    adapters.inspect = async (device) => ({
      ...device,
      online: running.has(device.id),
      locked: false,
      healthDetail: running.has(device.id) ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running.has(device.id) ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      actions.push(`${action}:${device.id}`);
      if (action === "launch") running.add(device.id);
      else running.delete(device.id);
      return {
        deviceId: device.id,
        action,
        state: action === "launch" ? "booted" : "shutdown",
        changed: true,
      };
    };
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/expiry",
      leaseToken: "e".repeat(43),
      owner: "CI",
      reason: "Expiry recovery",
      requests: {
        cold: { selector: { device: "one" } },
        warm: { selector: { device: "two" } },
      },
    });
    const group = deck.store.group(reserved.groupId);
    group.expiresAt = Date.now() - 1;
    deck.store.putGroup(group);
    await deck.expire();
    assert.equal(deck.store.group(reserved.groupId).state, "closed");
    assert.ok(
      deck.store
        .sessions()
        .filter((session) => session.groupId === reserved.groupId)
        .every((session) => session.state === "closed"),
    );
    assert.deepEqual(actions, ["launch:one", "close:one"]);
    assert.deepEqual([...running], ["two"]);
  } finally {
    await cleanup();
  }
});

test("expiry during group preparation cannot reactivate or return a cancelled group", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finishLaunch: (() => void) | undefined;
  let running = false;
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      if (action === "launch") {
        await new Promise<void>((resolve) => (finishLaunch = resolve));
        running = true;
      } else running = false;
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        changed: true,
      };
    };
    const reserving = deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/preparing-expiry",
      leaseToken: "f".repeat(43),
      owner: "CI",
      reason: "Slow startup",
      requests: { slow: { selector: { device: "one" } } },
    });
    while (!deck.store.groups().length || !finishLaunch)
      await new Promise((resolve) => setImmediate(resolve));
    const group = deck.store.group("test/group/preparing-expiry");
    group.expiresAt = Date.now() - 1;
    deck.store.putGroup(group);
    const expiring = deck.expire();
    while (deck.store.group(group.id).state !== "closing")
      await new Promise((resolve) => setImmediate(resolve));
    finishLaunch();
    await assert.rejects(reserving, /expired or was cancelled/);
    await expiring;
    assert.equal(deck.store.group(group.id).state, "closed");
    assert.equal(running, false);
  } finally {
    finishLaunch?.();
    await cleanup();
  }
});

test("restart recovery restores a cold-started group and clears its cleanup locks", async () => {
  const fixture = await setup();
  const { dir, deck, adapters, capture } = fixture;
  let running = false;
  let recovered: DeckService | undefined;
  try {
    await useSimulator(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.simulator = async (device, action) => {
      running = action === "launch";
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        changed: true,
      };
    };
    await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/restart",
      leaseToken: "g".repeat(43),
      owner: "CI",
      reason: "Crash recovery",
      requests: { simulator: { selector: { device: "one" } } },
    });
    assert.equal(running, true);
    clearInterval((deck as any).timer);
    deck.licensing.close();
    await Promise.all([deck.streams.close(), capture.close(), adapters.close()]);
    deck.store.close();

    const nextAdapters = new TestAdapters();
    nextAdapters.simulator = async (device, action) => {
      if (action === "close") running = false;
      return {
        deviceId: device.id,
        action,
        state: action === "close" ? "shutdown" : "booted",
        changed: true,
      };
    };
    const nextCapture = new TestCapture(nextAdapters);
    const licensed = await licensedManager(dir);
    recovered = new DeckService(
      dir,
      undefined,
      nextAdapters,
      nextCapture,
      licensed.manager,
    );
    await recovered.init();
    assert.equal(recovered.store.group("test/group/restart").state, "closed");
    assert.equal(recovered.store.lockReason("one"), undefined);
    assert.ok(
      recovered.store
        .sessions()
        .filter((session) => session.groupId === "test/group/restart")
        .every((session) => session.state === "closed"),
    );
    assert.equal(running, false);
  } finally {
    if (recovered) await recovered.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart recovery retains Android launch ownership for offline cleanup", async () => {
  const fixture = await setup();
  const { dir, deck, adapters, capture } = fixture;
  const ownership: SimulatorLaunchOwnership = {
    type: "android-emulator",
    avdName: "Television_1080p",
    marker: "e".repeat(32),
  };
  let running = false;
  let recovered: DeckService | undefined;
  let recoveredOwnership: SimulatorLaunchOwnership | undefined;
  try {
    await useAndroidAvd(deck);
    adapters.inspect = async (device) => ({
      ...device,
      online: running,
      locked: false,
      healthDetail: running ? "Ready" : "Stopped",
      capabilities: [],
      readiness: running ? "ready" : "offline",
      simulatorState: running ? "booted" : "shutdown",
    });
    adapters.verifyIdentity = async (device) => device;
    adapters.simulator = async (device, action, beforeLaunch) => {
      if (action === "launch") {
        await beforeLaunch?.(ownership);
        running = true;
      } else running = false;
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        changed: true,
      };
    };
    await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/android-restart",
      leaseToken: "h".repeat(43),
      owner: "CI",
      reason: "Crash recovery with offline ADB",
      requests: { television: { selector: { device: "one" } } },
    });
    assert.deepEqual(
      deck.store.group("test/group/android-restart").members[0]
        .simulatorLaunch,
      ownership,
    );
    clearInterval((deck as any).timer);
    deck.licensing.close();
    await Promise.all([deck.streams.close(), capture.close(), adapters.close()]);
    deck.store.close();

    const nextAdapters = new TestAdapters();
    nextAdapters.simulator = async (
      device,
      action,
      _beforeLaunch,
      savedOwnership,
    ) => {
      if (action === "close") {
        recoveredOwnership = savedOwnership;
        running = false;
      }
      return {
        deviceId: device.id,
        action,
        state: action === "close" ? "shutdown" : "booted",
        changed: true,
      };
    };
    const nextCapture = new TestCapture(nextAdapters);
    const licensed = await licensedManager(dir);
    recovered = new DeckService(
      dir,
      undefined,
      nextAdapters,
      nextCapture,
      licensed.manager,
    );
    await recovered.init();
    assert.deepEqual(recoveredOwnership, ownership);
    assert.equal(running, false);
    assert.equal(
      recovered.store.group("test/group/android-restart").state,
      "closed",
    );
  } finally {
    if (recovered) await recovered.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("group reservation returns the resolved online Android emulator serial", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  try {
    const current = structuredClone(deck.config.config);
    current.devices[0].connection = {
      type: "adb",
      serial: "emulator-5554",
      avdName: "Hosanna_Phone_API_36",
      port: 5037,
    };
    current.devices[0].inputMode = "touch";
    await deck.execute("config.save", {
      config: current,
      revision: deck.config.revision,
    });
    const inspect = adapters.inspect.bind(adapters);
    adapters.inspect = async (device) =>
      device.id === "one"
        ? {
            ...device,
            online: running,
            locked: false,
            healthDetail: running ? "Ready" : "Stopped",
            capabilities: [],
            simulatorState: running ? "booted" : "shutdown",
          }
        : inspect(device);
    adapters.simulator = async (device, action) => {
      running = action === "launch";
      return {
        deviceId: device.id,
        action,
        state: running ? "booted" : "shutdown",
        changed: true,
        ...(running ? { serial: "emulator-7777" } : {}),
      };
    };
    adapters.verifyIdentity = async (device) =>
      device.connection.type === "adb"
        ? {
            ...device,
            connection: { ...device.connection, serial: "emulator-7777" },
          }
        : device;
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/android",
      leaseToken: "c".repeat(43),
      owner: "CI",
      reason: "Android regression",
      requests: {
        phone: {
          selector: {
            platform: "Android",
            kind: "virtual",
            formFactor: "phone",
          },
        },
      },
    });
    assert.equal(reserved.devices.phone.connection.serial, "emulator-7777");
    await deck.execute("sessions.releaseGroup", {
      groupId: reserved.groupId,
      leaseToken: reserved.leaseToken,
    });
  } finally {
    await cleanup();
  }
});

test("an unsatisfiable group creates no partial sessions", async () => {
  const { deck, cleanup } = await setup();
  try {
    await assert.rejects(
      deck.execute("sessions.reserveGroup", {
        version: 1,
        groupId: "test/group/no-match",
        leaseToken: "d".repeat(43),
        owner: "CI",
        reason: "Too many devices",
        requests: {
          first: { selector: { platform: "Android" } },
          second: { selector: { platform: "Android" } },
          third: { selector: { platform: "Android" } },
        },
      }),
      /complete requested device set/,
    );
    assert.equal(deck.store.sessions().length, 0);
    assert.equal(deck.store.groups().length, 0);
  } finally {
    await cleanup();
  }
});

test("failed group renewal changes no member or group expiry", async () => {
  const { deck, cleanup } = await setup();
  try {
    const reserved: any = await deck.execute("sessions.reserveGroup", {
      version: 1,
      groupId: "test/group/renew-atomic",
      leaseToken: "n".repeat(43),
      owner: "Agent",
      reason: "Long-running work",
      requests: {
        first: { selector: { device: "one" } },
        second: { selector: { device: "two" } },
      },
    });
    const groupBefore = deck.store.group(reserved.groupId);
    const first = deck.store.session(groupBefore.members[0].sessionId);
    const second = deck.store.session(groupBefore.members[1].sessionId);
    const firstExpiry = first.expiresAt;
    const groupExpiry = groupBefore.expiresAt;
    second.state = "closed";
    second.endedAt = Date.now();
    deck.store.putSession(second);
    await assert.rejects(
      deck.execute("sessions.renewGroup", {
        groupId: reserved.groupId,
        leaseToken: reserved.leaseToken,
        ttlMinutes: 120,
      }),
      /no longer active/,
    );
    assert.equal(deck.store.session(first.id).expiresAt, firstExpiry);
    assert.equal(deck.store.group(reserved.groupId).expiresAt, groupExpiry);
  } finally {
    await cleanup();
  }
});
test("simulator lifecycle refuses occupied/recording devices and requires close confirmation", async () => {
  const { deck, adapters, capture, cleanup } = await setup();
  const actions: string[] = [];
  adapters.simulator = async (d, action) => {
    actions.push(action);
    return {
      deviceId: d.id,
      action,
      state: action === "close" ? "shutdown" : "booted",
      changed: true,
    };
  };
  try {
    await useSimulator(deck);
    await assert.rejects(
      deck.execute("devices.simulator", { deviceId: "one", action: "close" }),
      /Confirm before closing/,
    );
    await assert.rejects(
      deck.execute("devices.simulator", { deviceId: "two", action: "launch" }),
      /Apple iOS\/tvOS simulators/,
    );
    const reserved = await reserve(deck),
      lease = {
        sessionId: reserved.session.id,
        leaseToken: reserved.leaseToken,
      };
    await deck.execute("recordings.start", lease);
    await assert.rejects(
      deck.execute("devices.simulator", {
        deviceId: "one",
        action: "close",
        confirmed: true,
      }),
      /Reserved by same label/,
    );
    await assert.rejects(
      deck.execute("devices.simulator", { deviceId: "one", action: "launch" }),
      /Reserved by same label/,
    );
    assert.equal(capture.stops, 0);
    assert.deepEqual(actions, []);
    capture.resolveStop = () => {};
    await deck.execute("sessions.release", lease);
    assert.equal(capture.stops, 1);
    await deck.execute("devices.simulator", {
      deviceId: "one",
      action: "close",
      confirmed: true,
    });
    assert.deepEqual(actions, ["close"]);
    assert.equal(
      deck.store.events().filter((e) => e.action === "simulator-close").length,
      1,
    );
  } finally {
    await cleanup();
  }
});
test("launching a simulator provisions a missing feed once and preserves existing capture assignments", async () => {
  const { deck, adapters, cleanup } = await setup();
  adapters.simulator = async (d, action) => ({ deviceId: d.id, action, state: "booted", changed: true });
  try {
    await useSimulator(deck);
    const c = structuredClone(deck.config.config);
    c.devices[0].captureSourceId = null;
    c.sources = c.sources.filter((s) => s.deviceId !== "one");
    await deck.execute("config.save", { config: c, revision: deck.config.revision });
    const result = await deck.execute("devices.simulator", { deviceId: "one", action: "launch" });
    const sourceId = deck.config.config.devices[0].captureSourceId;
    assert.deepEqual(result, { deviceId: "one", action: "launch", state: "booted", changed: true, sourceId });
    assert.deepEqual(deck.config.config.sources.find((s) => s.id === sourceId), {
      id: "native-one", name: "one screen", kind: "native", deviceId: "one",
    });
    await deck.execute("devices.simulator", { deviceId: "one", action: "launch" });
    assert.equal(deck.config.config.sources.filter((s) => s.deviceId === "one").length, 1);
    const assigned = structuredClone(deck.config.config);
    assigned.sources.push({ id: "usb", name: "External capture", kind: "usb", uniqueId: "usb-camera" });
    assigned.devices[0].captureSourceId = "usb";
    await deck.execute("config.save", { config: assigned, revision: deck.config.revision });
    const existing = await deck.execute("devices.simulator", { deviceId: "one", action: "launch" });
    assert.deepEqual(existing, { deviceId: "one", action: "launch", state: "booted", changed: true, sourceId: "usb" });
  } finally { await cleanup(); }
});
test("simulator transitions keep inventory responsive, block reservation/config races and unlock after failure", async () => {
  const { deck, adapters, cleanup } = await setup();
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (finish = r));
  adapters.simulator = async () => {
    started();
    await gate;
    throw new Error("Boot failed");
  };
  try {
    await useSimulator(deck);
    const launching = deck.execute("devices.simulator", {
      deviceId: "one",
      action: "launch",
    });
    const rejected = assert.rejects(launching, /Boot failed/);
    await entered;
    const during = await deck.snapshot();
    assert.equal(during.devices[0].simulatorState, "starting");
    assert.equal(during.devices[0].readiness, "starting");
    assert.equal(during.devices[0].online, false);
    assert.deepEqual(during.devices[0].capabilities, []);
    assert.equal(during.devices[0].locked, true);
    await assert.rejects(reserve(deck), /booting/i);
    const c = structuredClone(deck.config.config);
    c.devices[0].name = "Changed while booting";
    await assert.rejects(
      deck.execute("config.save", {
        config: c,
        revision: deck.config.revision,
      }),
      /Wait for simulator/,
    );
    const changedTools = structuredClone(deck.config.config);
    changedTools.tools.emulator = "/different-sdk/emulator";
    await assert.rejects(
      deck.execute("config.save", {
        config: changedTools,
        revision: deck.config.revision,
      }),
      /wait for simulator.*adapter executables/,
    );
    finish();
    await rejected;
    assert.equal((await deck.snapshot()).devices[0].locked, false);
    await reserve(deck);
  } finally {
    finish();
    await cleanup();
  }
});
test("Android lifecycle persists a verified AVD identity without replacing its saved serial; reservations prevent even preflight", async () => {
  const { deck, adapters, cleanup } = await setup();
  const observed: DeviceConfig[] = [];
  let preflights = 0;
  adapters.verifyIdentity = async (d) => d;
  adapters.prepareSimulator = async (d) => {
    preflights++;
    assert.equal(d.connection.type, "adb");
    return {
      ...d,
      connection: {
        type: "adb",
        serial: preflights === 1 ? "emulator-5554" : "emulator-5560",
        port: 5037,
        avdName: "TV_35",
      },
    };
  };
  adapters.simulator = async (d, action) => {
    observed.push(d);
    assert.deepEqual(
      deck.config.config.devices[0].connection,
      d.connection,
      "Persistent identity precedes any emulator mutation",
    );
    return {
      deviceId: d.id,
      action,
      state: action === "close" ? "shutdown" : "booted",
      changed: true,
    };
  };
  try {
    const c = structuredClone(deck.config.config);
    c.devices[0].connection = {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
    };
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    const prior = deck.config.revision;
    await deck.execute("devices.simulator", {
      deviceId: "one",
      action: "launch",
    });
    assert.notEqual(deck.config.revision, prior);
    assert.equal(
      observed[0].connection.type === "adb" && observed[0].connection.avdName,
      "TV_35",
    );
    assert.equal(deck.config.config.devices[0].captureSourceId, "screen-one");
    assert.equal(deck.store.lockReason("one"), undefined);
    const reserved = await reserve(deck);
    await assert.rejects(
      deck.execute("devices.simulator", {
        deviceId: "one",
        action: "close",
        confirmed: true,
      }),
      /Reserved by/,
    );
    assert.equal(preflights, 1);
    await deck.execute("sessions.release", {
      sessionId: reserved.session.id,
      leaseToken: reserved.leaseToken,
    });
    await deck.execute("devices.simulator", {
      deviceId: "one",
      action: "close",
      confirmed: true,
    });
    assert.equal(
      observed[1].connection.type === "adb" && observed[1].connection.serial,
      "emulator-5554",
    );
  } finally {
    await cleanup();
  }
});

test("a cold-launched AVD can reserve and close without persisting a live port occupied by a legacy config row", async () => {
  const { deck, adapters, cleanup } = await setup();
  let running = false;
  const actions: string[] = [];
  adapters.prepareSimulator = async (d) => !running ? d : {
    ...d,
    connection: { type: "adb", serial: "emulator-5554", port: 5037, avdName: "Hosanna_Phone_API_35" },
  };
  adapters.verifyIdentity = async (d) => {
    assert(running);
    return { ...d, connection: { type: "adb", serial: "emulator-5554", port: 5037, avdName: "Hosanna_Phone_API_35" } };
  };
  adapters.simulator = async (d, action) => {
    assert.equal(d.connection.type === "adb" && d.connection.serial, "avd-phone-35");
    actions.push(action);
    running = action === "launch";
    return { deviceId: d.id, action, state: running ? "booted" : "shutdown", changed: true, serial: "emulator-5554" };
  };
  try {
    const c = structuredClone(deck.config.config);
    c.devices[0].connection = { type: "adb", serial: "avd-phone-35", port: 5037, avdName: "Hosanna_Phone_API_35" };
    c.devices[1].connection = { type: "adb", serial: "emulator-5554", port: 5037 };
    await deck.execute("config.save", { config: c, revision: deck.config.revision });
    const revision = deck.config.revision;
    await deck.execute("devices.simulator", { deviceId: "one", action: "launch" });
    const lease = await reserve(deck);
    await deck.execute("sessions.release", { sessionId: lease.session.id, leaseToken: lease.leaseToken });
    await deck.execute("devices.simulator", { deviceId: "one", action: "close", confirmed: true });
    assert.deepEqual(actions, ["launch", "close"]);
    assert.deepEqual(deck.config.config.devices.map((d) => d.connection), c.devices.map((d) => d.connection));
    assert.equal(deck.config.revision, revision, "Live port changes do not rewrite saved configuration");
    assert.equal(deck.store.lockReason("one"), undefined);
  } finally {
    await cleanup();
  }
});

test("Android reservations persist the verified AVD and reject registered aliases before issuing any second lease", async () => {
  const { deck, adapters, cleanup } = await setup();
  adapters.verifyIdentity = async (d) => ({
    ...d,
    connection: {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
      avdName: "TV_35",
    },
  });
  try {
    const c = structuredClone(deck.config.config);
    c.devices[0].connection = {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
    };
    c.devices[1].connection = {
      type: "adb",
      serial: "emulator-5556",
      port: 5037,
      avdName: "TV_35",
    };
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    await assert.rejects(reserve(deck, "one"), /hardware identity/);
    assert.equal(deck.store.sessions().length, 0);
    c.devices[1].connection = {
      type: "adb",
      serial: "another-device",
      port: 5037,
    };
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    const reserved = await reserve(deck, "one");
    assert.equal(
      deck.config.config.devices[0].connection.type === "adb" &&
        deck.config.config.devices[0].connection.avdName,
      "TV_35",
    );
    await deck.execute("sessions.release", {
      sessionId: reserved.session.id,
      leaseToken: reserved.leaseToken,
    });
  } finally {
    await cleanup();
  }
});

test("recorder recovery stores the capture engine's verified AVD target instead of its unresolved configuration", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    capture.verifiedDevice = {
      ...deck.config.config.devices[0],
      connection: {
        type: "adb",
        serial: "emulator-5560",
        avdName: "TV_35",
        port: 5037,
      },
    };
    const reserved = await reserve(deck);
    const lease = {
      sessionId: reserved.session.id,
      leaseToken: reserved.leaseToken,
    };
    await deck.execute("recordings.start", lease);
    assert.deepEqual(deck.store.workers()[0].device, capture.verifiedDevice);
    capture.resolveStop = () => {};
    await deck.execute("sessions.release", lease);
    assert.equal(deck.store.workers().length, 0);
  } finally {
    await cleanup();
  }
});

test("the explicit local development mock starts active and can reset without provider calls", async () => {
  const mock = new LocalDevelopmentLicense();
  await mock.init();
  assert.equal(mock.status().tier, "pro");
  assert.equal(mock.status().maxSessions, null);
  assert.match(mock.status().message, /activation mock/);
  assert.equal((await mock.deactivate()).tier, "free");
  assert.equal((await mock.refresh()).maxSessions, 1);
  assert.equal((await mock.activate("local")).tier, "pro");
  assert.equal(new LocalDevelopmentLicense().status().state, "active");
  mock.close();
});
test("Free admits at most one session when different-device requests race, preserving collisions and clean capture", async () => {
  const { deck, capture, cleanup } = await setup(true);
  try {
    const results = await Promise.allSettled([
      reserve(deck, "one"),
      reserve(deck, "two"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /Free supports one/,
    );
    const winner = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof reserve>>
      >
    ).value;
    const lease = {
      sessionId: winner.session.id,
      leaseToken: winner.leaseToken,
    };
    await assert.rejects(
      deck.execute("recordings.start", { ...lease, mode: "annotated" }),
      /require an active Pro/,
    );
    const config = structuredClone(deck.config.config);
    (config as any).license = { tier: "pro" };
    await assert.rejects(
      deck.execute("config.save", { config, revision: deck.config.revision }),
    );
    await deck.execute("recordings.start", { ...lease, mode: "clean" });
    assert.equal(capture.starts, 1);
    capture.resolveStop = () => {};
    await deck.execute("recordings.stop", lease);
    await deck.execute("sessions.release", lease);
    assert.equal(
      deck.store.sessions().filter((s) => s.state !== "closed").length,
      0,
    );
  } finally {
    await cleanup();
  }
});
test("loss of Pro preserves running work until its existing lease while denying paid admission and renewal", async () => {
  const { deck, capture, adapters, licenseProvider, cleanup } = await setup();
  try {
    const first = await reserve(deck, "one"),
      second = await reserve(deck, "two");
    const one = { sessionId: first.session.id, leaseToken: first.leaseToken },
      two = { sessionId: second.session.id, leaseToken: second.leaseToken };
    const original = deck.store
      .sessions()
      .map((s) => ({ id: s.id, expiresAt: s.expiresAt }));
    capture.annotate = async (_source, target) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(target, "unit-test recording");
    };
    await deck.execute("recordings.start", { ...one, mode: "annotated" });
    licenseProvider!.mode = "invalid";
    await deck.execute("license.refresh", {});
    await deck.expire();
    assert.equal(
      capture.stops,
      0,
      "License events must not stop a running recording",
    );
    assert.equal(
      deck.store.sessions().filter((s) => s.state === "active").length,
      2,
    );
    assert.deepEqual(
      deck.store.sessions().map((s) => ({ id: s.id, expiresAt: s.expiresAt })),
      original,
    );
    await deck.execute("remote.input", { ...one, key: "Home" });
    await deck.execute("remote.input", { ...two, key: "Home" });
    assert.deepEqual(adapters.inputs, ["one", "two"]);
    await assert.rejects(
      deck.execute("sessions.renew", one),
      /Pro access ended/,
    );
    await assert.rejects(
      deck.execute("recordings.start", { ...two, mode: "annotated" }),
      /require an active Pro/,
    );
    capture.resolveStop = () => {};
    const stopped = (await deck.execute("recordings.stop", one)) as any;
    assert.equal(stopped.status, "completed");
    await deck.execute("sessions.release", one);
    await deck.execute("sessions.release", two);
    assert.equal(
      ((await deck.execute("inventory", {})) as any).artifacts.length,
      1,
    );
  } finally {
    await cleanup();
  }
});
test("exclusive leases across independent SQLite connections reject stale credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-sqlite-"));
  const a = new Store(path.join(dir, "state.sqlite"));
  const b = new Store(path.join(dir, "state.sqlite"));
  try {
    const first = a.reserve(
      "one",
      "source",
      "usb:identity",
      "Same",
      "test",
      15,
    );
    assert.throws(
      () => b.reserve("one", null, null, "Same", "test", 15),
      /already reserved/,
    );
    assert.throws(
      () =>
        b.reserve("two", "source-alias", "usb:identity", "Same", "test", 15),
      /source is in use/,
    );
    assert.throws(() => a.validate(first.session.id, "wrong"), /does not own/);
    a.putSession({ ...first.session, state: "closed" });
    const second = a.reserve("one", null, null, "Same", "again", 15);
    assert.throws(
      () => a.validate(first.session.id, first.leaseToken),
      /expired or closed/,
    );
    assert.equal(
      a.validate(second.session.id, second.leaseToken).state,
      "active",
    );
  } finally {
    b.close();
    a.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("competing API reservations have one winner; closing invalidates queued input before capture cleanup", async () => {
  const { deck, capture, adapters, cleanup } = await setup();
  try {
    const attempts = await Promise.allSettled([reserve(deck), reserve(deck)]);
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
    const result = attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>;
    const lease = {
      sessionId: result.value.session.id,
      leaseToken: result.value.leaseToken,
    };
    await deck.execute("recordings.start", lease);
    const releasing = deck.execute("sessions.release", lease);
    await assert.rejects(
      deck.execute("remote.input", { ...lease, key: "Home" }),
      /expired or closed/,
    );
    await assert.rejects(reserve(deck), /already reserved/);
    while (!capture.resolveStop) await new Promise((r) => setTimeout(r, 1));
    capture.resolveStop();
    await releasing;
    assert.equal(capture.stops, 1);
    assert.deepEqual(adapters.inputs, []);
    await reserve(deck);
    assert.equal(
      ((await deck.execute("sessions.release", lease)) as any).state,
      "closed",
    );
  } finally {
    await cleanup();
  }
});
test("wake attempts offline devices without reserving or capturing them", async () => {
  const { deck, adapters, capture, cleanup } = await setup();
  try {
    const inspect = adapters.inspect.bind(adapters);
    adapters.inspect = async (device) => ({
      ...(await inspect(device)),
      online: false,
      capabilities: [],
    });
    assert.equal((await deck.devices(true))[0].online, false);
    assert.deepEqual(
      await deck.execute("devices.wake", { deviceId: "one" }, "Web"),
      { deviceId: "one", status: "attempted", method: "Fixture wake" },
    );
    assert.deepEqual(adapters.wakes, ["one"]);
    assert.deepEqual(deck.store.sessions(), []);
    assert.deepEqual(deck.store.artifacts(), []);
    assert.equal(capture.starts, 0);
    assert.equal(capture.stops, 0);
    const event = deck.store.events().find((event) => event.action === "wake")!;
    assert.equal(event.deviceId, "one");
    assert.equal(event.owner, "Web");
    assert.ok(!event.sessionId);
    assert.match(event.detail, /attempted.*Fixture wake/);
  } finally {
    await cleanup();
  }
});
test("wake requires explicit confirmation for reservations and preserves recordings", async () => {
  const { deck, adapters, capture, cleanup } = await setup();
  try {
    const reservation = await reserve(deck);
    const lease = { sessionId: reservation.session.id, leaseToken: reservation.leaseToken };
    const original = deck.store.session(lease.sessionId);
    await deck.execute("recordings.start", lease);
    capture.resolveStop = () => {};
    const recording = deck.store.artifacts()[0];
    for (const args of [
      { deviceId: "one" },
      { deviceId: "one", confirmed: true },
      { deviceId: "one", sessionId: lease.sessionId },
    ])
      await assert.rejects(deck.execute("devices.wake", args), { code: "device-reserved" });
    assert.deepEqual(adapters.wakes, []);
    assert.deepEqual(
      await deck.execute("devices.wake", {
        deviceId: "one", sessionId: lease.sessionId, confirmed: true,
      }, "Agent"),
      { deviceId: "one", status: "attempted", method: "Fixture wake", sessionId: lease.sessionId },
    );
    assert.deepEqual(adapters.wakes, ["one"]);
    assert.deepEqual(deck.store.session(lease.sessionId), original);
    assert.equal(deck.store.sessions().length, 1);
    assert.equal(deck.store.artifact(recording.id).status, "recording");
    assert.equal(capture.stops, 0);
    const event = deck.store.events().find((event) => event.action === "wake")!;
    assert.equal(event.owner, "Agent");
    assert.equal(event.sessionId, original.id);
    await deck.execute("remote.input", { ...lease, key: "Home" });
    assert.deepEqual(adapters.inputs, ["one"]);
  } finally {
    await cleanup();
  }
});
test("wake rejects stale confirmations, maintenance locks and unsupported connections", async () => {
  const { deck, adapters, cleanup } = await setup();
  try {
    const reservation = await reserve(deck);
    const wake = { deviceId: "one", sessionId: reservation.session.id, confirmed: true };
    for (const change of [{ sessionId: "missing" }, { deviceId: "two" }])
      await assert.rejects(deck.execute("devices.wake", { ...wake, ...change }), { code: "stale-wake" });
    deck.store.lock("one", "Maintenance");
    await assert.rejects(deck.execute("devices.wake", wake), { code: "device-locked" });
    deck.store.lock("one", null);
    const session = deck.store.session(reservation.session.id);
    deck.store.putSession({ ...session, expiresAt: Date.now() - 1 });
    await assert.rejects(deck.execute("devices.wake", wake), { code: "stale-wake" });
    await deck.execute("sessions.release", { sessionId: session.id, leaseToken: reservation.leaseToken });
    await assert.rejects(deck.execute("devices.wake", wake), { code: "stale-wake" });
    await reserve(deck);
    await assert.rejects(deck.execute("devices.wake", wake), { code: "stale-wake" });
    const c = structuredClone(deck.config.config);
    c.devices[1].platform = "Apple";
    c.devices[1].kind = "physical";
    c.devices[1].connection = { type: "apple-device", udid: "fixture-physical-ios" };
    c.devices[1].captureSourceId = null;
    c.sources = c.sources.filter((source) => source.deviceId !== "two");
    await deck.execute("config.save", { config: c, revision: deck.config.revision });
    await assert.rejects(deck.execute("devices.wake", { deviceId: "two" }), { code: "unsupported-capability" });
    assert.deepEqual(adapters.wakes, []);
  } finally {
    await cleanup();
  }
});
test("queued wake is rejected when the expected reservation begins closing", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finishInput: () => void = () => {};
  try {
    const reservation = await reserve(deck);
    const lease = { sessionId: reservation.session.id, leaseToken: reservation.leaseToken };
    let inputStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { inputStarted = resolve; });
    const pendingInput = new Promise<void>((resolve) => { finishInput = resolve; });
    adapters.input = async () => { inputStarted(); await pendingInput; };
    const input = deck.execute("remote.input", { ...lease, key: "Home" });
    await started;
    const rejectedWake = assert.rejects(
      deck.execute("devices.wake", { deviceId: "one", sessionId: lease.sessionId, confirmed: true }),
      { code: "stale-wake" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const releasing = deck.execute("sessions.release", lease);
    finishInput();
    await Promise.all([input, rejectedWake, releasing]);
    assert.deepEqual(adapters.wakes, []);
  } finally {
    finishInput();
    await cleanup();
  }
});
test("wake completes adapter work before admitting a new reservation", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finishWake: () => void = () => {};
  try {
    const order: string[] = [];
    let wakeStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { wakeStarted = resolve; });
    const pendingWake = new Promise<void>((resolve) => { finishWake = resolve; });
    adapters.wake = async (device) => {
      order.push("wake-started");
      wakeStarted();
      await pendingWake;
      assert.deepEqual(deck.store.sessions(), []);
      adapters.wakes.push(device.id);
      order.push("wake-dispatched");
      return { method: "Fixture wake" };
    };
    const waking = deck.execute("devices.wake", { deviceId: "one" });
    await started;
    const reserving = reserve(deck).then((result) => {
      order.push("reserved");
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(deck.store.sessions(), []);
    assert.deepEqual(order, ["wake-started"]);
    finishWake();
    await Promise.all([waking, reserving]);
    assert.deepEqual(order, ["wake-started", "wake-dispatched", "reserved"]);
    assert.deepEqual(adapters.wakes, ["one"]);
    assert.equal(deck.store.sessions()[0].state, "active");
  } finally {
    finishWake();
    await cleanup();
  }
});
test("queued wake rechecks maintenance locks before dispatch", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finishInput: () => void = () => {};
  try {
    const reservation = await reserve(deck);
    const lease = { sessionId: reservation.session.id, leaseToken: reservation.leaseToken };
    let inputStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { inputStarted = resolve; });
    const pendingInput = new Promise<void>((resolve) => { finishInput = resolve; });
    adapters.input = async () => { inputStarted(); await pendingInput; };
    const input = deck.execute("remote.input", { ...lease, key: "Home" });
    await started;
    const rejectedWake = assert.rejects(
      deck.execute("devices.wake", { deviceId: "one", sessionId: lease.sessionId, confirmed: true }),
      { code: "device-locked" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    deck.store.lock("one", "Maintenance");
    finishInput();
    await Promise.all([input, rejectedWake]);
    assert.deepEqual(adapters.wakes, []);
  } finally {
    finishInput();
    deck.store.lock("one", null);
    await cleanup();
  }
});
test("failed wake attempts are audited without claiming the device is awake", async () => {
  const { deck, adapters, cleanup } = await setup();
  try {
    adapters.wake = async () => { throw new Error("Device unreachable"); };
    await assert.rejects(deck.execute("devices.wake", { deviceId: "one" }, "CLI"), /Device unreachable/);
    assert.deepEqual(deck.store.sessions(), []);
    assert.equal(deck.store.events().filter((event) => event.action === "wake").length, 0);
    const event = deck.store.events().find((event) => event.action === "wake-failed")!;
    assert.equal(event.owner, "CLI");
    assert.match(event.detail, /Device unreachable/);
  } finally {
    await cleanup();
  }
});
test("explicit remote override sends keys and text while preserving the reservation and recording", async () => {
  const { deck, capture, adapters, cleanup } = await setup();
  try {
    const reservation = await reserve(deck);
    const lease = { sessionId: reservation.session.id, leaseToken: reservation.leaseToken };
    const original = deck.store.session(lease.sessionId);
    await deck.execute("recordings.start", lease);
    // Let cleanup stop the fixture recorder even if an assertion fails.
    capture.resolveStop = () => {};
    const recording = deck.store.artifacts()[0];
    const override = {
      deviceId: "one",
      sessionId: lease.sessionId,
      confirmed: true,
      owner: "Another user",
    };
    await assert.rejects(
      deck.execute("remote.override", { ...override, confirmed: false, key: "Home" }),
      /Invalid literal value/,
    );
    await assert.rejects(
      deck.execute("remote.input", { ...lease, leaseToken: "wrong", key: "Home" }),
      /does not own/,
    );
    const key = await deck.execute("remote.override", { ...override, key: "Home" }) as Input;
    const text = await deck.execute("remote.override", { ...override, text: "Search term" }) as Input;
    assert.deepEqual(adapters.inputs, ["one", "one"]);
    assert.equal(key.key, "Home");
    assert.equal(text.key, "Text: Search term");
    for (const input of [key, text]) {
      assert.equal(input.sessionId, original.id);
      assert.equal(input.recordingId, recording.id);
      assert.ok(input.elapsedMs !== null && input.elapsedMs >= 0);
    }
    assert.deepEqual(deck.store.session(original.id), original);
    assert.equal(deck.store.sessions().length, 1);
    assert.equal(deck.store.artifact(recording.id).status, "recording");
    assert.equal(capture.starts, 1);
    assert.equal(capture.stops, 0);
    assert.deepEqual(
      deck.store.events().filter((event) => event.action === "control-override").map((event) => ({
        owner: event.owner,
        sessionId: event.sessionId,
      })),
      [
        { owner: "Another user", sessionId: original.id },
        { owner: "Another user", sessionId: original.id },
      ],
    );
    for (const operation of ["captures.screenshot", "recordings.start", "recordings.stop"] as const)
      await assert.rejects(
        deck.execute(operation, { sessionId: original.id, leaseToken: "wrong" }),
        /does not own/,
      );
    await deck.execute("remote.input", { ...lease, key: "Back" });
    assert.deepEqual(adapters.inputs, ["one", "one", "one"]);
  } finally {
    await cleanup();
  }
});
test("remote override requires the expected active reservation and valid input", async () => {
  const { deck, adapters, cleanup } = await setup();
  try {
    const reservation = await reserve(deck);
    const override = {
      deviceId: "one",
      sessionId: reservation.session.id,
      confirmed: true,
      owner: "Another user",
      key: "Home",
    };
    for (const change of [{ sessionId: "missing" }, { deviceId: "two" }])
      await assert.rejects(
        deck.execute("remote.override", { ...override, ...change }),
        { code: "stale-override" },
      );
    await assert.rejects(
      deck.execute("remote.override", { ...override, text: "Also text" }),
      { code: "invalid-input" },
    );
    deck.store.lock("one", "Maintenance");
    await assert.rejects(deck.execute("remote.override", override), { code: "device-locked" });
    deck.store.lock("one", null);
    const session = deck.store.session(reservation.session.id);
    deck.store.putSession({ ...session, expiresAt: Date.now() - 1 });
    await assert.rejects(deck.execute("remote.override", override), { code: "stale-override" });
    assert.deepEqual(adapters.inputs, []);
  } finally {
    await cleanup();
  }
});
test("queued remote override is invalidated when its reservation closes or is replaced", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finishInput: () => void = () => {};
  try {
    const reservation = await reserve(deck);
    const lease = { sessionId: reservation.session.id, leaseToken: reservation.leaseToken };
    let inputStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { inputStarted = resolve; });
    const pendingInput = new Promise<void>((resolve) => { finishInput = resolve; });
    adapters.input = async (device) => {
      adapters.inputs.push(device.id);
      inputStarted();
      await pendingInput;
    };
    const ownedInput = deck.execute("remote.input", { ...lease, key: "Home" });
    await started;
    const override = {
      deviceId: "one",
      sessionId: lease.sessionId,
      confirmed: true,
      owner: "Another user",
      key: "Back",
    };
    const rejectedOverride = assert.rejects(
      deck.execute("remote.override", override),
      { code: "stale-override" },
    );
    const releasing = deck.execute("sessions.release", lease);
    finishInput();
    await ownedInput;
    await rejectedOverride;
    await releasing;
    await reserve(deck);
    await assert.rejects(deck.execute("remote.override", override), { code: "stale-override" });
    assert.deepEqual(adapters.inputs, ["one"]);
  } finally {
    finishInput();
    await cleanup();
  }
});
test("source failure closes session promptly and marks recording interrupted", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    const l = await reserve(deck);
    const lease = { sessionId: l.session.id, leaseToken: l.leaseToken };
    await deck.execute("recordings.start", lease);
    capture.disconnected!("USB disconnected");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(deck.store.session(l.session.id).state, "closing");
    while (!capture.resolveStop) await new Promise((r) => setTimeout(r, 1));
    capture.resolveStop();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deck.store.session(l.session.id).state, "closed");
    assert.equal(deck.store.artifacts()[0].status, "interrupted");
  } finally {
    await cleanup();
  }
});
test("authenticated HTTP and browser bootstrap reject origins, unknown hosts, missing tokens and replayed tickets", async () => {
  const { deck, cleanup } = await setup();
  const token = "a".repeat(64),
    server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + "/v1/health")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/health", {
          headers: { Authorization: `Bearer ${"é".repeat(token.length)}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/v1/health", {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://example.com",
          },
        })
      ).status,
      403,
    );
    const post = (route: string, body: unknown, auth = true) =>
      fetch(base + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const { ticket } = await post("/v1/browser-ticket", {}).then((r) =>
      r.json(),
    );
    const bootstrap = await post("/v1/bootstrap", { ticket }, false);
    assert.equal(bootstrap.status, 200);
    assert.match(
      bootstrap.headers.get("set-cookie")!,
      /HttpOnly; SameSite=Strict/,
    );
    assert.equal((await post("/v1/bootstrap", { ticket }, false)).status, 403);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await fetch(base + "/v1/operations/inventory", {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    const inventory = await post("/v1/operations/inventory", {}).then((r) =>
      r.json(),
    );
    assert.equal(inventory.mode, "local");
    assert.equal(inventory.devices.length, 2);
    assert.equal("leaseToken" in inventory.sessions, false);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      http
        .get(
          base + "/v1/health",
          { headers: { Host: "untrusted.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on("error", reject),
    );
    assert.equal(status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
});

test("direct USB previews share bound-device locks and need HTTP authentication", async () => {
  const { deck, capture, cleanup } = await setup(true);
  const config = structuredClone(deck.config.config);
  config.sources.push({
    id: "usb-free",
    name: "Unassigned",
    kind: "usb",
    uniqueId: "physical-free",
  });
  config.sources.push({
    id: "usb-bound",
    name: "Assigned",
    kind: "usb",
    uniqueId: "physical-bound",
  });
  config.devices[0].captureSourceId = "usb-bound";
  await deck.execute("config.save", { config, revision: deck.config.revision });
  const token = "b".repeat(64),
    server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal(
      (await fetch(base + "/v1/source-preview/usb-free")).status,
      401,
    );
    const response = await fetch(base + "/v1/source-preview/usb-free", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from([255, 216, 255, 217]),
    );
    await reserve(deck);
    await Promise.all([
      deck.previewSource("usb-bound"),
      deck.previewSource("usb-free"),
    ]);
    assert.ok(capture.previewed.includes("usb-bound"));
    await assert.rejects(deck.previewSource("screen-two"), /USB capture card/);
    await assert.rejects(
      deck.previewSource("not-configured"),
      /USB capture card/,
    );
    const session = deck.store.sessions().find((s) => s.deviceId === "one")!;
    session.state = "closing";
    deck.store.putSession(session);
    await assert.rejects(deck.previewSource("usb-bound"), /being released/);
    session.state = "closed";
    deck.store.putSession(session);
    await deck.execute("devices.bulk", {
      ids: ["one"],
      action: "lock",
      reason: "maintenance",
    });
    await assert.rejects(deck.previewSource("usb-bound"), /locked/);
    await deck.previewSource("usb-free");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
});

test("capture files support authenticated inline previews and named downloads; folder actions reject arbitrary paths", async () => {
  const { deck, cleanup } = await setup();
  const token = "c".repeat(64), server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const { writeFile } = await import("node:fs/promises");
    const file = path.join(deck.directory, "original.mp4"), clean = path.join(deck.directory, "clean.mp4"), log = `${file}.json`;
    await writeFile(file, "original-video");
    await writeFile(clean, "clean-video");
    await writeFile(log, "{}");
    deck.store.putArtifact({ id: "download", deviceId: "one", sessionId: "history", owner: "test", sourceId: "screen-one", name: "Café's demo", path: file, cleanPath: clean, logPath: log, kind: "recording", mode: "annotated", tags: [], createdAt: Date.now(), duration: 1, bytes: 14, status: "completed", origin: "API" });
    assert.equal((await fetch(`${base}/v1/artifacts/download/file?download=1`)).status, 401);
    const inline = await fetch(`${base}/v1/artifacts/download/file`, { headers });
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get("content-type"), "video/mp4");
    assert.match(inline.headers.get("content-disposition")!, /^inline; .*filename\*=UTF-8''Caf%C3%A9%27s%20demo.mp4$/);
    assert.equal(await inline.text(), "original-video");
    const download = await fetch(`${base}/v1/artifacts/download/clean?download=1`, { headers: { ...headers, Origin: base, Range: "bytes=0-4" } });
    assert.equal(download.status, 206);
    assert.equal(download.headers.get("content-range"), "bytes 0-4/11");
    assert.match(download.headers.get("content-disposition")!, /^attachment; .*demo-clean.mp4$/);
    assert.match(download.headers.get("access-control-expose-headers")!, /Content-Disposition/);
    assert.equal(await download.text(), "clean");
    const manifest = await fetch(`${base}/v1/artifacts/download/log?download=1`, { headers });
    assert.equal(manifest.headers.get("content-type"), "application/json");
    assert.match(manifest.headers.get("content-disposition")!, /^attachment; .*demo-metadata.json$/);
    assert.equal(await manifest.text(), "{}");
    assert.equal((await fetch(`${base}/v1/artifacts/download/arbitrary`, { headers })).status, 404);
    const folderAction = (auth: boolean) => fetch(`${base}/v1/operations/captures.openFolder`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? headers : {}) }, body: JSON.stringify({ path: "/tmp/not-configured" }) });
    assert.equal((await folderAction(false)).status, 401);
    assert.equal((await folderAction(true)).status, 400);
    deck.store.putArtifact({ ...deck.store.artifact("download"), deletedAt: Date.now() });
    assert.equal((await fetch(`${base}/v1/artifacts/download/file?download=1`, { headers })).status, 410);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
});

test("thumbnail HTTP routes require authentication and reject trashed, purged and active captures", async () => {
  const { deck, cleanup } = await setup();
  const token = "d".repeat(64), server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const artifact = { id: "thumb", deviceId: "one", sessionId: "history", owner: "test", sourceId: "screen-one", name: "Thumbnail", path: path.join(deck.directory, "thumbnail-source.png"), logPath: path.join(deck.directory, "thumbnail-source.json"), kind: "screenshot" as const, mode: "clean" as const, tags: [], createdAt: Date.now(), duration: 0, bytes: 0, status: "recording" as const, origin: "API" as const };
  try {
    deck.store.putArtifact(artifact);
    const url = `${base}/v1/artifacts/thumb/thumbnail`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://untrusted.test" } })).status, 403);
    assert.equal((await fetch(url, { headers })).status, 409);
    deck.store.putArtifact({ ...artifact, status: "finalizing" });
    assert.equal((await fetch(url, { headers })).status, 409);
    deck.store.putArtifact({ ...artifact, status: "completed", deletedAt: Date.now() });
    assert.equal((await fetch(url, { headers })).status, 410);
    deck.store.putArtifact({ ...artifact, status: "completed", purgedAt: Date.now() });
    assert.equal((await fetch(url, { headers })).status, 410);
    deck.store.putArtifact({ ...artifact, status: "completed" });
    assert.equal((await fetch(url, { headers })).status, 404, "Missing source files are not passed to ffmpeg");
    const { available, run } = await import("../../../packages/adapters/src/process");
    if (await available("ffmpeg")) {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", artifact.path]);
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(Number(response.headers.get("content-length")), data.length);
      assert.equal(data.readUInt16BE(0), 0xffd8);
      assert(data.length < 100_000);
      deck.store.putArtifact({ ...artifact, status: "completed", deletedAt: Date.now() });
      assert.equal((await fetch(url, { headers })).status, 410, "Cached thumbnails retain deletion checks");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test("renewal, expiry and takeover invalidate credentials while preserving ownership history", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  try {
    const first = await reserve(deck);
    const lease = { sessionId: first.session.id, leaseToken: first.leaseToken };
    const renewed = (await deck.execute("sessions.renew", {
      ...lease,
      ttlMinutes: 20,
    })) as any;
    assert.ok(renewed.expiresAt - Date.now() > 19 * 60000);
    const replacement = (await deck.execute("sessions.takeover", {
      deviceId: "one",
      owner: "same label",
      reason: "Explicit takeover",
      confirmed: true,
    })) as any;
    await assert.rejects(
      deck.execute("remote.input", { ...lease, key: "Home" }),
      /expired or closed/,
    );
    const current = deck.store.session(replacement.session.id);
    current.expiresAt = Date.now() - 1;
    deck.store.putSession(current);
    await deck.expire();
    await assert.rejects(
      deck.execute("remote.input", {
        sessionId: current.id,
        leaseToken: replacement.leaseToken,
        key: "Home",
      }),
      /expired or closed/,
    );
    assert.ok(deck.store.events().some((e) => e.action === "takeover"));
    assert.equal(deck.store.session(current.id).state, "closed");
  } finally {
    await cleanup();
  }
});
test("logging off stores no new text and capture trash/purge removes original and sidecars", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  try {
    const c = structuredClone(deck.config.config);
    c.settings.logging = false;
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    const l = await reserve(deck);
    await deck.execute("remote.input", {
      sessionId: l.session.id,
      leaseToken: l.leaseToken,
      text: "Do not persist this text",
    });
    assert.equal(deck.store.inputs().length, 0);
    const { writeFile, readFile, stat } = await import("node:fs/promises");
    const file = path.join(deck.directory, "capture.png"),
      log = file + ".json",
      clean = path.join(deck.directory, "clean.png");
    for (const p of [file, log, clean]) await writeFile(p, "test file");
    await writeFile(
      log,
      JSON.stringify({
        schemaVersion: 1,
        inputs: [{ key: "Home", elapsedMs: 500 }],
      }),
    );
    deck.store.putArtifact({
      id: "capture",
      deviceId: "one",
      sessionId: l.session.id,
      owner: "test",
      sourceId: "screen-one",
      name: "Test capture",
      path: file,
      cleanPath: clean,
      logPath: log,
      kind: "screenshot",
      mode: "annotated",
      tags: [],
      createdAt: Date.now(),
      duration: 0,
      bytes: 9,
      status: "completed",
      origin: "API",
    });
    await deck.execute("captures.edit", {
      id: "capture",
      name: "Renamed capture",
      tags: ["proof"],
    });
    const manifest = JSON.parse(await readFile(log, "utf8"));
    assert.equal(manifest.artifact.name, "Renamed capture");
    assert.deepEqual(manifest.inputs, [{ key: "Home", elapsedMs: 500 }]);
    await deck.execute("captures.remove", {
      ids: ["capture"],
      confirmed: true,
    });
    assert.ok(await stat(file));
    await deck.execute("captures.restore", { ids: ["capture"] });
    assert.equal(deck.store.artifact("capture").deletedAt, undefined);
    await deck.execute("captures.remove", {
      ids: ["capture"],
      confirmed: true,
    });
    const results = await Promise.allSettled([
      deck.execute("captures.purge", { ids: ["capture"], confirmed: true }),
      deck.execute("captures.edit", {
        id: "capture",
        name: "Concurrent edit",
        tags: [],
      }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.ok(deck.store.artifact("capture").purgedAt);
    for (const p of [file, log, clean])
      await assert.rejects(stat(p), { code: "ENOENT" });
    await assert.rejects(
      deck.execute("captures.restore", { ids: ["capture"] }),
      /cannot be restored/,
    );
  } finally {
    await cleanup();
  }
});
test("config edits close idle preview sources, and reject edits to reserved bindings", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  const closed: string[] = [];
  capture.closeSource = async (s: any) => {
    closed.push(s.id);
  };
  try {
    const c = structuredClone(deck.config.config);
    c.devices[0].captureSourceId = null;
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    assert.ok(closed.includes("screen-one"));
    const acquired = await reserve(deck);
    const changed = structuredClone(deck.config.config);
    changed.devices[0].name = "Cannot change reserved identity";
    await assert.rejects(
      deck.execute("config.save", {
        config: changed,
        revision: deck.config.revision,
      }),
      /Release the affected session/,
    );
    assert.equal(deck.config.config.devices[0].name, "one");
    await deck.execute("sessions.release", {
      sessionId: acquired.session.id,
      leaseToken: acquired.leaseToken,
    });
  } finally {
    await cleanup();
  }
});
test("Capture Cards assignment uses revision-checked config and rejects both sides of an active binding change", async () => {
  const { deck, cleanup } = await setup();
  try {
    const { assignCaptureCard } =
      await import("../../../packages/core/src/capture-cards");
    const card = {
      id: "usb-fixture",
      name: "Fixture HDMI",
      kind: "usb" as const,
      uniqueId: "usb-hardware-fixture",
    };
    let config = structuredClone(deck.config.config);
    config.devices.forEach((d) => (d.captureSourceId = null));
    config.sources.push(card);
    config.devices[0].captureSourceId = card.id;
    await deck.execute("config.save", {
      config,
      revision: deck.config.revision,
    });
    const owned = await reserve(deck);
    await assert.rejects(
      deck.execute("config.save", {
        config: assignCaptureCard(deck.config.config, card, "two"),
        revision: deck.config.revision,
      }),
      /Release the affected session/,
    );
    assert.equal(deck.config.config.devices[0].captureSourceId, card.id);
    await deck.execute("sessions.release", {
      sessionId: owned.session.id,
      leaseToken: owned.leaseToken,
    });
    const saved = await deck.execute("config.save", {
      config: assignCaptureCard(deck.config.config, card, "two"),
      revision: deck.config.revision,
    });
    const { ConfigStore } = await import("../../../packages/config/src");
    const reload = new ConfigStore(deck.config.file);
    await reload.load();
    assert.equal(reload.config.devices[1].captureSourceId, card.id);
    assert.equal(
      reload.config.sources.find((s) => s.id === card.id)?.uniqueId,
      card.uniqueId,
    );
    const target = await reserve(deck, "one");
    await assert.rejects(
      deck.execute("config.save", {
        config: assignCaptureCard(deck.config.config, card, "one"),
        revision: deck.config.revision,
      }),
      /Release the affected session/,
    );
    await deck.execute("sessions.release", {
      sessionId: target.session.id,
      leaseToken: target.leaseToken,
    });
  } finally {
    await cleanup();
  }
});

test("browser credentials coexist across local instances without overwriting another port's login", async () => {
  const { deck, cleanup } = await setup();
  const token = "c".repeat(64);
  const servers = [
    createService(deck, token, "/tmp/no-web"),
    createService(deck, token, "/tmp/no-web"),
  ];
  try {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
      ),
    );
    const bases = servers.map(
      (server) =>
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const cookies = await Promise.all(
      bases.map(async (base) => {
        const { ticket } = await fetch(base + "/v1/browser-ticket", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: "{}",
        }).then((r) => r.json());
        const response = await fetch(base + "/v1/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        return response.headers.get("set-cookie")!.split(";")[0];
      }),
    );
    assert.notEqual(cookies[0].split("=")[0], cookies[1].split("=")[0]);
    for (const [index, base] of bases.entries()) {
      assert.equal(
        (
          await fetch(base + "/v1/health", {
            headers: { Cookie: cookies.join("; ") },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(base + "/v1/health", {
            headers: { Cookie: cookies[1 - index] },
          })
        ).status,
        401,
      );
    }
  } finally {
    await Promise.all(
      servers.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((r) => server.close(() => r()));
      }),
    );
    await cleanup();
  }
});

test("phone hardware waits for iOS touch and revalidates credentials after the barrier", { timeout: 10000 }, async (t) => {
  for (const ending of ["active", "revoked", "expired", "aborted"] as const) await t.test(ending, async () => {
    const { deck, adapters, cleanup } = await setup();
    let finish!: () => void, start!: () => void, cancel!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    let running = false, authorized = true, gestures = 0;
    const source: InteractiveSource = {
      width: 100, height: 200, capabilities: ["tap", "swipe", "longPress"],
      onFrame: () => () => {}, onClose: () => () => {}, close: async () => {},
      pointer: async () => { cancel(); },
      gesture: async () => { gestures++; running = true; start(); await finished; running = false; },
    };
    adapters.startInteractive = async () => source;
    adapters.input = async (device) => {
      assert.equal(running, false, "Home cannot overlap an in-flight idb gesture");
      adapters.inputs.push(device.id);
    };
    let server: ReturnType<typeof createService> | undefined;
    let request: http.ClientRequest | undefined;
    try {
      const c = structuredClone(deck.config.config);
      c.devices[0].platform = "Apple";
      c.devices[0].connection = { type: "simulator", os: "ios", udid: "F4B9CA01-BA57-40A0-984D-38B7F91AB8A1" };
      await deck.execute("config.save", { config: c, revision: deck.config.revision });
      const reservation = await reserve(deck), sessionId = reservation.session.id;
      const lease = { sessionId, leaseToken: reservation.leaseToken };
      const controller = await deck.streams.script(sessionId, {
        device: deck.config.config.devices[0], validate() { deck.store.validate(sessionId, lease.leaseToken); },
      });
      const tap = { type: "gesture", gesture: { type: "tap", x: 20, y: 30, width: 100, height: 200 } };
      controller.control.send(tap); await started;
      controller.control.send(tap);
      let outcome: Promise<unknown>, abortRequest: (() => Promise<void>) | undefined;
      if (ending === "aborted") {
        server = createService(deck, "abort-test-token", deck.directory);
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const disconnected = new Promise<void>((resolve) => server!.once("request", (_req, res) => res.once("close", resolve)));
        const execute = deck.execute.bind(deck);
        let completed!: () => void;
        outcome = new Promise<void>((resolve) => { completed = resolve; });
        deck.execute = async (...args) => { try { return await execute(...args); } finally { if (args[0] === "remote.input") completed(); } };
        request = http.request({ hostname: "127.0.0.1", port, path: "/v1/operations/remote.input", method: "POST", headers: {
          Authorization: "Bearer abort-test-token", "Content-Type": "application/json",
        } });
        request.on("error", () => {});
        request.end(JSON.stringify({ ...lease, key: "Home" }));
        abortRequest = async () => { request!.destroy(); await disconnected; };
      } else {
        const pending = deck.execute("remote.input", { ...lease, key: "Home" }, "Web", async () => authorized);
        outcome = ending === "active" ? pending : assert.rejects(pending, ending === "revoked" ? /expired or was revoked/ : /expired/);
      }
      await cancelled;
      assert.deepEqual(adapters.inputs, []);
      if (ending === "revoked") authorized = false;
      if (ending === "expired") deck.store.putSession({ ...deck.store.session(sessionId), expiresAt: Date.now() - 1 });
      await abortRequest?.();
      controller.control.send(tap);
      finish(); await outcome;
      assert.equal(gestures, 1, "queued and intervening gestures are dropped");
      assert.deepEqual(adapters.inputs, ending === "active" ? ["one"] : []);
      if (ending === "active") {
        assert.equal(deck.store.validate(sessionId, lease.leaseToken).id, sessionId);
        controller.control.send(tap); await controller.control.settled();
        assert.equal(gestures, 2, "the same controller is available after Home");
      }
    } finally {
      finish(); request?.destroy();
      if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
      await cleanup();
    }
  });
});

test("capture-only USB devices can reserve and record while source bindings remain exclusive", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    const config = structuredClone(deck.config.config);
    config.sources.push({
      id: "usb-only",
      name: "Fire capture",
      kind: "usb",
      uniqueId: "usb-fire",
    });
    config.devices.push({
      id: "fire-feed",
      name: "Fire feed",
      platform: "Other",
      kind: "physical",
      model: "USB capture",
      visibility: "local",
      connection: { type: "capture" },
      captureSourceId: "usb-only",
    });
    await deck.execute("config.save", {
      config,
      revision: deck.config.revision,
    });
    const reserved = await reserve(deck, "fire-feed");
    const credentials = {
      sessionId: reserved.session.id,
      leaseToken: reserved.leaseToken,
    };
    await deck.execute("recordings.start", { ...credentials, mode: "clean" });
    assert.equal(capture.starts, 1);
    await assert.rejects(reserve(deck, "fire-feed"), /reserved/);
    const broken = structuredClone(config);
    broken.devices.find((d) => d.id === "fire-feed")!.captureSourceId = null;
    await assert.rejects(
      deck.execute("config.save", {
        config: broken,
        revision: deck.config.revision,
      }),
      /require a USB/,
    );
    capture.resolveStop = () => {};
    await deck.execute("sessions.release", credentials);
    assert.equal(capture.stops, 1);
  } finally {
    await cleanup();
  }
});

test("inventory returns configured rows while a shared health probe is blocked and publishes current locks", async () => {
  const { deck, adapters, cleanup } = await setup();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const inspect = adapters.inspect.bind(adapters);
  adapters.inspect = async (device) => { calls++; await gate; return inspect(device); };
  try {
    const snapshots = await Promise.all(Array.from({ length: 10 }, () => deck.snapshot()));
    assert.ok(snapshots.every((snapshot) => snapshot.devices.length === 2));
    assert.ok(snapshots.every((snapshot) => snapshot.inventoryObservation?.observedAt === null));
    assert.equal(calls, 2, "ten clients share one inspection per configured device");
    deck.store.lock("one", "Maintenance now");
    assert.equal((await deck.snapshot()).devices[0].locked, true);
    finish();
    await deck.devices();
    assert.ok((await deck.snapshot()).devices[0].online);
    assert.equal(calls, 2);
  } finally { finish(); await cleanup(); }
});

test("scoped inventory inspects only selected configured devices and capture sources", async () => {
  const { deck, adapters, cleanup } = await setup();
  const devices: string[] = [], sources: string[] = [];
  const inspect = adapters.inspect.bind(adapters);
  adapters.inspect = async (device) => { devices.push(device.id); return inspect(device); };
  adapters.inspectSources = async (configs = []) => { sources.push(...configs.map((source: { id: string }) => source.id)); return []; };
  try {
    const snapshot = await deck.snapshot(["one"]);
    assert.deepEqual(snapshot.devices.map((device) => device.id), ["one"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(devices, ["one"]);
    assert.deepEqual(sources, ["screen-one"]);
  } finally { await cleanup(); }
});

test("reservation rejects a capability selector that no longer matches fresh admission", async () => {
  const { deck, adapters, cleanup } = await setup();
  try {
    await deck.devices();
    const inspect = adapters.inspect.bind(adapters);
    adapters.inspect = async (device) => ({ ...await inspect(device), capabilities: [] });
    await assert.rejects(deck.execute("sessions.reserve", { selector: { device: "one", capabilities: ["key"] }, owner: "test", reason: "test" }), /no longer matches/);
    assert.equal(deck.store.sessions().length, 0);
  } finally { await cleanup(); }
});

test("wake and unrelated configuration changes retain known feed observations", async () => {
  const { deck, adapters, cleanup } = await setup();
  adapters.inspectSources = async (sources = []) => sources.map((source) => ({ ...source, status: "connected" }));
  try {
    await deck.devices();
    await deck.snapshot();
    await new Promise((resolve) => setImmediate(resolve));
    const before = await deck.snapshot();
    assert.equal(before.sources.find((source) => source.id === "screen-two")?.status, "connected");
    await deck.execute("devices.wake", { deviceId: "one" });
    const waking = await deck.snapshot();
    assert.equal(waking.devices.find((device) => device.id === "one")?.observation?.stale, true);
    assert.equal(waking.devices.find((device) => device.id === "two")?.online, true);
    assert.equal(waking.devices.find((device) => device.id === "two")?.observation?.stale, false);
    assert.equal(waking.sources.find((source) => source.id === "screen-two")?.status, "connected");
    const changed = structuredClone(deck.config.config);
    changed.devices[0].name = "Changed identity";
    await deck.execute("config.save", { config: changed, revision: deck.config.revision });
    const saved = await deck.snapshot();
    assert.equal(saved.devices.find((device) => device.id === "one")?.observation?.observedAt, null);
    assert.equal(saved.devices.find((device) => device.id === "two")?.online, true);
    assert.equal(saved.sources.find((source) => source.id === "screen-two")?.status, "connected");
  } finally { await cleanup(); }
});
