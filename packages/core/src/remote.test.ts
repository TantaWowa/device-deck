import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../../config/src";
import { deviceInputMode, phoneHardwareButtons, remoteProfile, supportsRemoteKey, supportsWake } from "./remote";
import type { DeviceConfig } from "./local/types";
const device: DeviceConfig = {
  id: "fire",
  name: "USB Video · Fire TV",
  platform: "Other",
  kind: "physical",
  model: "USB capture",
  visibility: "local",
  connection: { type: "capture" },
  captureSourceId: "usb",
};
test("input class does not depend on names, online state or installed gesture helpers", () => {
  assert.equal(deviceInputMode(device), "none");
  assert.equal(deviceInputMode({ ...device, inputMode: "remote" }), "remote");
  assert.equal(deviceInputMode({ ...device, connection: { type: "adb", serial: "emulator-5554", port: 5037 } }), "touch");
  assert.equal(deviceInputMode({ ...device, inputMode: "remote", connection: { type: "adb", serial: "emulator-5554", port: 5037 } }), "remote");
  assert.equal(deviceInputMode({ ...device, inputMode: "remote", connection: { type: "simulator", os: "ios", udid: "phone" } }), "touch");
  assert.equal(deviceInputMode({ ...device, connection: { type: "simulator", os: "tvos", udid: "tv" } }), "remote");
  assert.equal(deviceInputMode({ ...device, connection: { type: "apple-device", udid: "iphone" } }), "touch");
});
test("phone hardware controls follow supported transports and preserve distinct iOS navigation", () => {
  const android: DeviceConfig = { ...device, inputMode: "touch", connection: { type: "adb", serial: "phone", port: 5037 } };
  const ios: DeviceConfig = { ...device, kind: "virtual", connection: { type: "simulator", os: "ios", udid: "ios-phone" } };
  assert.deepEqual(phoneHardwareButtons(android), [
    { key: "Back", label: "Back" }, { key: "Home", label: "Home" },
    { key: "Recents", label: "Recents" }, { key: "VolumeDown", label: "Volume down" },
    { key: "VolumeUp", label: "Volume up" }, { key: "Power", label: "Power" },
  ]);
  assert.deepEqual(phoneHardwareButtons(ios), [
    { key: "Home", label: "Home" }, { key: "Lock", label: "Lock" }, { key: "SideButton", label: "Side button" },
  ]);
  for (const phone of [android, ios]) for (const button of phoneHardwareButtons(phone))
    assert.equal(supportsRemoteKey(phone, button.key), true, `${phone.connection.type} supports ${button.key}`);
  for (const key of ["Back", "Recents", "VolumeUp", "VolumeDown", "Power"])
    assert.equal(supportsRemoteKey(ios, key), false, `iOS does not advertise Android's ${key}`);
  for (const unsupported of [
    device,
    { ...android, inputMode: "remote" as const },
    { ...ios, connection: { type: "simulator" as const, os: "tvos" as const, udid: "tv" } },
    { ...ios, connection: { type: "apple-device" as const, udid: "physical-phone" } },
    { ...device, inputMode: "touch" as const, name: "iPhone 17 Pro" },
  ]) assert.deepEqual(phoneHardwareButtons(unsupported), []);
});
test("devicectl Apple TVs retain remote classification from metadata or a legacy hardware model without reclassifying phones", () => {
  const apple = { ...device, name: "Bedroom", platform: "Apple" as const, connection: { type: "apple-device" as const, udid: "physical" } };
  const namedLikeTv = { ...apple, name: "Apple TV" };
  assert.equal(deviceInputMode({ ...apple, model: "", inputMode: "remote" }), "remote");
  for (const model of ["Apple TV 4K (3rd generation)", "AppleTV14,1"])
    assert.equal(deviceInputMode({ ...apple, model }), "remote");
  for (const model of ["iPhone 17 Pro Max", "iPhone18,2", "iPad Pro", "iPad16,3"])
    assert.equal(deviceInputMode({ ...namedLikeTv, model, inputMode: "remote" }), "touch");
  assert.equal(deviceInputMode({ ...namedLikeTv, model: "" }), "touch");
  assert.equal(supportsRemoteKey({ ...apple, inputMode: "remote" }, "Home"), false, "device class does not grant a missing Companion input transport");
});
test("remote appearance never grants input to a capture-only connection", () => {
  assert.equal(remoteProfile(device), "Fire TV");
  assert.equal(supportsRemoteKey(device, "Home"), false);
  assert.equal(
    supportsRemoteKey(
      {
        ...device,
        connection: { type: "roku", host: "192.0.2.1", serial: "test" },
      },
      "Replay",
    ),
    true,
  );
  assert.equal(
    supportsRemoteKey(
      {
        ...device,
        connection: {
          type: "simulator",
          udid: "9acf7253-911e-4d9d-ae94-4e6b7d38b079",
          os: "tvos",
        },
      },
      "Replay",
    ),
    false,
  );
});
test("wake availability follows the configured transport even for an offline device", () => {
  const connections: DeviceConfig["connection"][] = [
    { type: "roku", host: "192.0.2.1", serial: "test" },
    { type: "adb", serial: "android-test", port: 5038 },
    { type: "apple-tv", host: "192.0.2.2", identifier: "apple-test" },
    { type: "simulator", udid: "test-simulator", os: "ios" },
  ];
  for (const connection of connections)
    assert.equal(supportsWake({ ...device, connection }), true);
  assert.equal(supportsWake(device), false);
  assert.equal(
    supportsWake({
      ...device,
      connection: { type: "apple-device", udid: "test-iphone" },
    }),
    false,
  );
});
test("capture-only configuration requires one unique physical USB binding", () => {
  const config = {
    schemaVersion: 1,
    settings: { folder: "/tmp/captures" },
    devices: [device],
    sources: [{ id: "usb", name: "USB", kind: "usb", uniqueId: "physical" }],
  };
  assert.equal(validateConfig(config).devices[0].connection.type, "capture");
  assert.throws(
    () => validateConfig({ ...config, sources: [] }),
    /require a USB/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        devices: [device, { ...device, id: "copy", name: "Copy" }],
      }),
    /identity cannot be registered twice/,
  );
});
