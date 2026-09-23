import test from "node:test";
import assert from "node:assert/strict";
import { deviceFormFactor } from "./device-form-factor";
import type { DeviceConfig } from "./local/types";
import { deviceEditorMetadata } from "./device-editor";

test("editing tags preserves explicit input classification used by selectors", () => {
  const television: DeviceConfig = {
    id: "android-tv",
    name: "Android TV",
    platform: "Android",
    kind: "physical",
    model: "Custom target",
    inputMode: "remote",
    visibility: "local",
    connection: { type: "adb", serial: "physical", port: 5037 },
    captureSourceId: null,
  };
  const saved = {
    ...television,
    ...deviceEditorMetadata(television, "ci, nightly, ci"),
  };
  assert.equal(saved.inputMode, "remote");
  assert.equal(deviceFormFactor(saved), "tv");
  assert.deepEqual(saved.tags, ["ci", "nightly"]);
});
