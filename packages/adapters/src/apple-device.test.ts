import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Adapters, appleHardwareInputMode } from "./index";
import { deviceInputMode } from "../../core/src/remote";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import type { run } from "./process";

test("devicectl hardware metadata distinguishes Apple TV and iOS without relying on a user-assigned name", () => {
  for (const metadata of [{ platform: "tvOS" }, { deviceType: "appleTV" }, { productType: "AppleTV14,1" }, { marketingName: "Apple TV 4K (3rd generation)" }])
    assert.equal(appleHardwareInputMode(metadata), "remote");
  for (const metadata of [{ platform: "iOS" }, { deviceType: "iPhone" }, { deviceType: "iPad" }, { productType: "iPhone18,2" }, {}])
    assert.equal(appleHardwareInputMode(metadata), "touch");
});

test("physical Apple TV health refresh corrects old discovery and gives Companion guidance while phones remain touch-only", async () => {
  const device = deviceSchema.parse({ id: "apple", name: "Bedroom", model: "", platform: "Apple", kind: "physical", connection: { type: "apple-device", udid: "physical" } });
  let hardware = { platform: "tvOS", deviceType: "appleTV", productType: "AppleTV14,1", marketingName: "Apple TV 4K (3rd generation)" };
  let present = true;
  const execute: typeof run = async (command, args) => {
    assert.equal(command, "xcrun");
    assert.deepEqual(args.slice(0, 3), ["devicectl", "list", "devices"]);
    await writeFile(args[args.indexOf("--json-output") + 1], JSON.stringify({ result: { devices: present ? [{ identifier: "physical", hardwareProperties: hardware, connectionProperties: { tunnelState: "connected" } }] : [] } }));
    return { stdout: Buffer.alloc(0), stderr: "" };
  };
  const adapters = new Adapters(() => configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" } }), execute);
  const tv = await adapters.inspect({ ...device, model: "iPhone 17 Pro Max" });
  assert.equal(tv.online, true);
  assert.equal(tv.inputMode, "remote");
  assert.equal(tv.model, "Apple TV 4K (3rd generation)");
  assert.equal(deviceInputMode(tv), "remote");
  assert.match(tv.healthDetail, /Apple TV Companion/);
  assert.doesNotMatch(tv.healthDetail, /iPhone/);
  assert.deepEqual(tv.capabilities, []);
  present = false;
  const legacy = await adapters.inspect({ ...device, model: "Apple TV 4K (3rd generation)" });
  assert.equal(legacy.online, false);
  assert.equal(deviceInputMode(legacy), "remote");
  assert.match(legacy.healthDetail, /Apple TV Companion/);
  present = true;
  hardware = { platform: "iOS", deviceType: "iPhone", productType: "iPhone18,2", marketingName: "iPhone 17 Pro Max" };
  const phone = await adapters.inspect({ ...device, name: "Apple TV", model: "AppleTV14,1", inputMode: "remote" });
  assert.equal(deviceInputMode(phone), "touch");
  assert.equal(phone.model, "iPhone 17 Pro Max");
  assert.match(phone.healthDetail, /physical iPhones and iPads/);
  assert.deepEqual(phone.capabilities, []);
});
