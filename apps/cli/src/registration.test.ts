import test from "node:test";
import assert from "node:assert/strict";
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
