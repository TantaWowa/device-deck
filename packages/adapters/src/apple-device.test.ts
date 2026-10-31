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

test("discovery excludes devicectl simulator rows while retaining physical devices in both metadata formats", async () => {
  const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" },
    tools: { adb: "/usr/bin/true", emulator: "/usr/bin/true", python: "/usr/bin/true" } });
  const rows = [
    { identifier: "sim-modern", properties: { hardware: { reality: "simulated" } } },
    { identifier: "sim-legacy", hardwareProperties: { reality: "simulated" } },
    { identifier: "sim-visibility", visibilityClass: "simulators" },
    { identifier: "phone", properties: { hardware: { reality: "physical", marketingName: "iPhone", platform: "iOS" }, state: { name: "My phone" } } },
    { identifier: "tv", hardwareProperties: { reality: "physical", marketingName: "Apple TV", platform: "tvOS" }, deviceProperties: { name: "My TV" } },
  ];
  const execute: typeof run = async (_command, args) => {
    let output = "[]";
    if (args[0] === "-P") output = "List of devices attached\n";
    else if (args[0] === "-list-avds") output = "";
    else if (args[0] === "simctl") output = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
      { udid: "sim-modern", name: "Simulator", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
    ] } });
    else if (args[0] === "devicectl") {
      await writeFile(args[args.indexOf("--json-output") + 1], JSON.stringify({ result: { devices: rows } }));
      output = "";
    }
    return { stdout: Buffer.from(output), stderr: "" };
  };
  const adapters = new Adapters(() => config, execute);
  Object.defineProperty(adapters, "scanRoku", { value: async () => [] });
  try {
    const found = await adapters.discover(true);
    assert.deepEqual(found.diagnostics, []);
    const physical = found.devices.filter((device) => device.connection.type === "apple-device");
    assert.deepEqual(physical.map((device) => [device.name, device.model, device.inputMode]), [["My phone", "iPhone", "touch"], ["My TV", "Apple TV", "remote"]]);
    assert.equal(found.devices.filter((device) => "udid" in device.connection && device.connection.udid === "sim-modern").length, 1);
    assert.equal(found.devices.find((device) => "udid" in device.connection && device.connection.udid === "sim-modern")?.kind, "virtual");
  } finally { await adapters.close(); }
});
