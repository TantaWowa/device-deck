import test from "node:test";
import assert from "node:assert/strict";
import type { DeviceConfig } from "./local/types";
import { deviceFormFactor } from "./device-form-factor";

const device: DeviceConfig = {
  id: "device", name: "Apple TV", platform: "Other", kind: "physical", model: "USB capture",
  visibility: "local", connection: { type: "capture" }, captureSourceId: "source",
};

test("TV and phone form factors are independent of simulator environment and connection readiness", () => {
  const android = { ...device, platform: "Android" as const, connection: { type: "adb" as const, serial: "android", port: 5037 } };
  for (const kind of ["physical", "virtual"] as const) for (const online of [true, false]) {
    const phone = { ...android, kind, online, inputMode: "touch" as const };
    const tv = { ...android, kind, online, inputMode: "remote" as const };
    assert.equal(deviceFormFactor(phone), "phone");
    assert.equal(deviceFormFactor(tv), "tv");
  }
  const misleadingName = { ...android, name: "Google TV" };
  assert.equal(deviceFormFactor(misleadingName), "phone", "a friendly name cannot override Android input metadata");
  assert.equal(deviceFormFactor({ ...device, inputMode: "remote", connection: { type: "simulator", udid: "ios", os: "ios" } }), "phone");
  assert.equal(deviceFormFactor({ ...device, inputMode: "touch", connection: { type: "simulator", udid: "tvos", os: "tvos" } }), "tv");
  assert.equal(deviceFormFactor({ ...device, connection: { type: "roku", serial: "roku", host: "192.0.2.1" } }), "tv");
  assert.equal(deviceFormFactor({ ...device, connection: { type: "apple-tv", identifier: "atv", host: "192.0.2.2" } }), "tv");
});

test("Apple hardware models distinguish phone/tablet and TV even when stale input metadata disagrees", () => {
  const apple = { ...device, platform: "Apple" as const, connection: { type: "apple-device" as const, udid: "apple" } };
  for (const model of ["iPhone 17 Pro", "iPhone18,2", "iPad Pro", "iPad16,3", "iPod touch"])
    assert.equal(deviceFormFactor({ ...apple, model, inputMode: "remote" }), "phone");
  for (const model of ["Apple TV 4K", "AppleTV14,1"])
    assert.equal(deviceFormFactor({ ...apple, model, inputMode: "touch" }), "tv");
});

test("capture-only and partial historical metadata retain an Other category instead of guessing from names", () => {
  assert.equal(deviceFormFactor(device), "other");
  assert.equal(deviceFormFactor({ ...device, inputMode: "remote" }), "tv");
  assert.equal(deviceFormFactor({ ...device, inputMode: "touch" }), "phone");
  assert.equal(deviceFormFactor(), "other");
  assert.equal(deviceFormFactor({ platform: "Apple" }), "other");
  assert.equal(deviceFormFactor({ platform: "Android" }), "other");
  assert.equal(deviceFormFactor({ platform: "Roku" }), "tv");
  assert.equal(deviceFormFactor({ platform: "Apple", model: "AppleTV14,1" }), "tv");
  assert.equal(deviceFormFactor({ platform: "Apple", model: "iPad16,3" }), "phone");
  assert.equal(deviceFormFactor({ inputMode: "touch" }), "phone");
});
