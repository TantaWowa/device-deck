import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckService } from "./local/service";
import { Store } from "./local/store";
import { Adapters } from "../../../packages/adapters/src";
import { deviceSchema, type Device, type DeviceConfig } from "../../../packages/core/src/local/types";

test("device observations use the same lease, discover schemas, preserve provenance and recheck authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-gateway-"));
  const device = deviceSchema.parse({ id: "phone", name: "Phone", platform: "Apple", kind: "virtual", connection: { type: "simulator", os: "ios", udid: "00000000-0000-4000-8000-000000000001" } });
  let deck: DeckService, reads = 0, launches = 0, closes = 0, failClose = false, wait: Promise<void> | undefined;
  class FixtureAdapters extends Adapters {
    async diagnostics() { return []; }
    async inspect(d: DeviceConfig): Promise<Device> { return { ...d, online: true, locked: false, healthDetail: "Fixture", capabilities: ["touch"] }; }
    forDevice(d: DeviceConfig) {
      return { ...super.forDevice(d), ui: async () => { reads++; await wait; return { nodes: [], coordinateSpace: "points" as const, truncated: false }; },
        launch: async (appId: string) => { launches++; return { appId }; },
        close: async () => { closes++; if (failClose) throw new Error("Reconnect to finish owned cleanup"); } };
    }
  }
  const adapters = new FixtureAdapters(() => deck.config.config);
  deck = new DeckService(directory, undefined, adapters);
  try {
    await deck.init();
    await deck.execute("config.save", { config: { ...deck.config.config, devices: [device] }, revision: deck.config.revision });
    const api: any = await deck.execute("api.describe", {});
    for (const operation of ["devices.capabilities", "ui.read", "logs.read", "apps.state", "apps.launch"]) assert(api.operations[operation]);
    const held: any = await deck.execute("sessions.reserve", { selector: { device: device.id }, owner: "Test", reason: "Observation proof" });
    const lease = { sessionId: held.session.id, leaseToken: held.leaseToken };
    await assert.rejects(deck.execute("ui.read", { ...lease, leaseToken: "wrong" })); assert.equal(reads, 0);
    const observed: any = await deck.execute("ui.read", lease);
    assert.equal(observed.observation.deviceId, device.id); assert.equal(observed.observation.sessionId, lease.sessionId);
    assert.equal(observed.observation.backend, "idb");
    assert.equal(observed.observation.sha256, createHash("sha256").update(JSON.stringify(observed.result)).digest("hex"));
    assert(!JSON.stringify(observed).includes(held.leaseToken));
    const caps: any = await deck.execute("devices.capabilities", lease); assert.equal(caps.result.backend, "idb");
    const launched: any = await deck.execute("apps.launch", { ...lease, appId: "org.hope.app" });
    assert.equal(launched.result.appId, "org.hope.app"); assert.equal(launches, 1);
    await assert.rejects(deck.execute("apps.launch", { ...lease, appId: "org.hope.app; touch escaped" })); assert.equal(launches, 1);
    let finish!: () => void, authorized = true;
    wait = new Promise<void>((resolve) => { finish = resolve; });
    const read = deck.execute("ui.read", lease, "Agent", async () => authorized);
    while (reads < 2) await new Promise((resolve) => setImmediate(resolve));
    authorized = false; finish();
    await assert.rejects(read, /expired during observation/);
    await deck.execute("sessions.release", lease);
    await assert.rejects(deck.execute("ui.read", lease)); assert.equal(reads, 2);
    wait = undefined;
    for (const operation of ["apps.launch", "ui.read"] as const) {
      const next: any = await deck.execute("sessions.reserve", { selector: { device: device.id }, owner: "Test", reason: "Release during authorization" });
      const current = { sessionId: next.session.id, leaseToken: next.leaseToken };
      let entered!: () => void, resume!: () => void, checks = 0;
      const pendingAuth = new Promise<void>((resolve) => { entered = resolve; });
      const pending = deck.execute(operation, { ...current, ...(operation === "apps.launch" ? { appId: "org.hope.app" } : {}) }, "Agent", async () => {
        if (++checks === 2) { entered(); await new Promise<void>((resolve) => { resume = resolve; }); }
        return true;
      });
      await pendingAuth;
      const release = deck.execute("sessions.release", current);
      while (deck.store.session(current.sessionId).state !== "closing") await new Promise((resolve) => setImmediate(resolve));
      resume();
      await assert.rejects(pending, /closing|lease|active|expired/i);
      await release;
    }
    assert.equal(launches, 1, "Release while authorization waits must prevent launch");
    const last: any = await deck.execute("sessions.reserve", { selector: { device: device.id }, owner: "Test", reason: "Retry owned cleanup" });
    const finalLease = { sessionId: last.session.id, leaseToken: last.leaseToken };
    await deck.execute("devices.capabilities", finalLease);
    failClose = true; const before = closes;
    await assert.rejects(deck.execute("sessions.release", finalLease), /Reconnect/);
    assert.equal(deck.store.session(finalLease.sessionId).state, "closing");
    failClose = false; await deck.execute("sessions.release", finalLease);
    assert.equal(closes - before, 2);
  } finally { await deck.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restart retains failed WDA launch cleanup and releases only after the same owned session is cleaned", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-gateway-restart-"));
  const phone = deviceSchema.parse({ id: "physical", name: "Phone", platform: "Apple", kind: "physical", connection: { type: "apple-device", udid: "00008110-0012345678901234", webDriverAgent: {} } });
  let deck: DeckService, online = false, attempts = 0;
  class RecoveryAdapters extends Adapters {
    async diagnostics() { return []; }
    async inspect(d: DeviceConfig): Promise<Device> { return { ...d, online: true, locked: false, healthDetail: "Fixture", capabilities: ["touch"] }; }
    async closeOwnedWda(device: DeviceConfig, id: string) {
      assert.deepEqual(device, phone); assert.equal(id, "owned-wda-session"); attempts++;
      if (!online) throw new Error("Connect the same USB phone");
    }
  }
  const adapters = new RecoveryAdapters(() => deck.config.config);
  deck = new DeckService(directory, undefined, adapters);
  await deck.init();
  await deck.execute("config.save", { config: { ...deck.config.config, devices: [phone] }, revision: deck.config.revision });
  await deck.close();
  const persisted = new Store(path.join(directory, "state.sqlite"));
  const held = persisted.reserve(phone.id, null, null, "Agent", "Interrupted app launch", 15);
  persisted.putOwnedInteraction({ sessionId: held.session.id, device: phone, wdaSessionId: "owned-wda-session" });
  persisted.close();
  deck = new DeckService(directory, undefined, adapters);
  try {
    await deck.init();
    assert.equal(deck.store.session(held.session.id).state, "closing");
    assert.equal(deck.store.ownedInteractions().length, 1);
    await assert.rejects(deck.execute("sessions.reserve", { selector: { device: phone.id }, owner: "Other", reason: "Must remain occupied" }), /reserved/);
    online = true;
    await deck.execute("sessions.release", { sessionId: held.session.id, leaseToken: held.leaseToken });
    assert.equal(attempts, 2);
    assert.equal(deck.store.ownedInteractions().length, 0);
    assert.equal(deck.store.session(held.session.id).state, "closed");
  } finally { online = true; await deck.close(); await rm(directory, { recursive: true, force: true }); }
});
