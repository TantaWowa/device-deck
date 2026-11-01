import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckService } from "./local/service";
import { Adapters } from "../../../packages/adapters/src";
import { deviceSchema, type Device, type DeviceConfig } from "../../../packages/core/src/local/types";

test("device observations use the same lease, discover schemas, preserve provenance and recheck authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-gateway-"));
  const device = deviceSchema.parse({ id: "phone", name: "Phone", platform: "Apple", kind: "virtual", connection: { type: "simulator", os: "ios", udid: "00000000-0000-4000-8000-000000000001" } });
  let deck: DeckService, reads = 0, launches = 0, wait: Promise<void> | undefined;
  class FixtureAdapters extends Adapters {
    async diagnostics() { return []; }
    async inspect(d: DeviceConfig): Promise<Device> { return { ...d, online: true, locked: false, healthDetail: "Fixture", capabilities: ["touch"] }; }
    forDevice(d: DeviceConfig) {
      return { ...super.forDevice(d), ui: async () => { reads++; await wait; return { nodes: [], coordinateSpace: "points" as const, truncated: false }; },
        launch: async (appId: string) => { launches++; return { appId }; } };
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
  } finally { await deck.close(); await rm(directory, { recursive: true, force: true }); }
});
