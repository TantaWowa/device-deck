import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../../config/src";
import { remoteProfile, supportsRemoteKey } from "./remote";
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
