import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deckFixture } from "../../../tests/decks";
import { discoverRegistration } from "./registration";
import type { DiscoveredDevices } from "../../../packages/core/src/discovery";

const found: DiscoveredDevices = { diagnostics: [], sources: [], devices: [
  { id: "new-avd", name: "New AVD", model: "pixel_9", platform: "Android", kind: "virtual", visibility: "local", captureSourceId: null,
    connection: { type: "adb", avdName: "new_avd", serial: "avd-new", port: 5038 } },
  { id: "new-sim", name: "New simulator", model: "iPhone-17-Pro", platform: "Apple", kind: "virtual", visibility: "local", captureSourceId: null,
    connection: { type: "simulator", udid: "ABC-123", os: "ios" } },
] };

test("registration retries a scan started before device creation, then uses the refreshed sources", async () => {
  for (const wanted of [{ avd: "new_avd" }, { udid: "abc-123" }, { serial: "avd-new" }]) {
    let calls = 0;
    const result = await discoverRegistration(wanted, async () => ++calls === 1 ? { devices: [], sources: [], diagnostics: [] } : found);
    assert.equal(calls, 2);
    assert.equal(result.found, found);
    assert.equal(result.match.id, wanted.udid ? "new-sim" : "new-avd");
  }
});

test("registration makes one request for a present device and bounds missing-device retries", async () => {
  let calls = 0;
  await discoverRegistration({ avd: "new_avd" }, async () => { calls++; return found; });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(discoverRegistration({ avd: "absent" }, async () => {
    calls++;
    return { ...found, diagnostics: ["Simulators: unavailable"] };
  }), (error: unknown) => error instanceof Error && error.message === "Discovery found no device with that identifier.");
  assert.equal(calls, 2);
});

test("CLI register reports the saved fleet memory tag and accepts an explicit full AVD", async (t) => {
  const f = await deckFixture("Registration"); t.after(f.close);
  const config = structuredClone(f.deck.config.config);
  config.settings.defaultAndroidAvdMemoryProfile = "low-ram";
  await f.deck.execute("config.save", { config, revision: f.deck.config.revision });
  f.deck.adapters.discover = async () => ({ ...found, devices: [found.devices[0]] });
  const env = { ...process.env, DEVICE_DECK_HOME: f.directory, DEVICE_DECK_TARGET: "local" };
  const run = (...tags: string[]) => promisify(execFile)(process.execPath,
    ["--import", "tsx", "apps/cli/src/index.ts", "register", "--avd", "new_avd", ...tags, "--json"], { env });
  const created = JSON.parse((await run()).stdout);
  assert.equal(created.created, true);
  assert.deepEqual(created.registered.tags, ["android-low-ram"]);
  const updated = JSON.parse((await run("--tags", "android-full-ram")).stdout);
  assert.equal(updated.created, false);
  assert.deepEqual(updated.registered.tags, ["android-full-ram"]);
  assert.deepEqual(f.deck.config.config.devices.find(d => d.id === "new-avd")?.tags, updated.registered.tags);
});
