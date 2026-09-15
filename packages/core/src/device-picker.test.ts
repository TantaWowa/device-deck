import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceClass,
  filterPickerDevices,
  type DeviceClass,
  type DevicePickerItem,
} from "./device-picker";

function item(values: Partial<DevicePickerItem> = {}): DevicePickerItem {
  return {
    id: "device",
    name: "Unidentified target",
    platform: "Other",
    kind: "physical",
    ...values,
  };
}

test("picker classes use known TV connections and explicit names without assuming every Android is a phone", () => {
  const cases: [DevicePickerItem, DeviceClass][] = [
    [item({ platform: "Roku" }), "tv"],
    [item({ connection: { type: "roku" } }), "tv"],
    [item({ connection: { type: "apple-tv" } }), "tv"],
    [item({ connection: { type: "simulator", os: "tvos" } }), "tv"],
    [item({ name: "Android TV emulator", platform: "Android" }), "tv"],
    [item({ name: "Fire TV", platform: "Android" }), "tv"],
    [item({ model: "Chromecast with Google TV" }), "tv"],
    [item({ model: "NVIDIA SHIELD_TV" }), "tv"],
    [item({ name: "Living room television" }), "tv"],
    [item({ name: "iPhone 16 Pro simulator", platform: "Apple" }), "phone"],
    [item({ model: "Pixel_9_Pro", platform: "Android" }), "phone"],
    [item({ name: "Pixel emulator", platform: "Android" }), "phone"],
    [item({ name: "iPad Pro", platform: "Apple" }), "tablet"],
    [item({ model: "Pixel Tablet", platform: "Android" }), "tablet"],
    [item({ name: "Lab tablet" }), "tablet"],
    [item({ name: "Mac mini", connection: { type: "capture" } }), "computer"],
    [item({ model: "MacBook Pro" }), "computer"],
    [item({ name: "Studio desktop" }), "computer"],
    [item({ model: "Windows laptop" }), "computer"],
    [item({ name: "Capture computer" }), "computer"],
    [item({ platform: "Android", connection: { type: "adb" } }), "other"],
    [item({ platform: "Apple", connection: { type: "apple-device" } }), "other"],
    [item({ connection: { type: "simulator", os: "ios" } }), "other"],
    [item({ model: "HDMI capture card" }), "other"],
    [item({ model: "Pixel Watch", platform: "Android" }), "other"],
    [item({ name: "myiphonebackup" }), "other"],
  ];
  for (const [device, expected] of cases)
    assert.equal(deviceClass(device), expected, JSON.stringify(device));
});

test("picker filters combine family, class, kind and case-insensitive name/model search while preserving generic fields and order", () => {
  const devices = [
    {
      ...item({ id: "tv", name: "Lounge TV", platform: "Android" }),
      online: true,
    },
    {
      ...item({
        id: "one", name: "QA target", model: "Pixel 9",
        platform: "Android", kind: "virtual",
      }),
      online: false,
    },
    {
      ...item({
        id: "two", name: "PIXEL 8 test",
        platform: "Android", kind: "virtual",
      }),
      online: true,
    },
    {
      ...item({ id: "physical", name: "Pixel phone", platform: "Android" }),
      online: true,
    },
    {
      ...item({
        id: "apple", name: "iPhone", platform: "Apple", kind: "virtual",
      }),
      online: true,
    },
  ];
  const before = structuredClone(devices);
  const selected = filterPickerDevices(devices, {
    family: "Android",
    deviceClass: "phone",
    kind: "virtual",
    search: " PiXeL ",
  });
  assert.deepEqual(selected.map((device) => device.id), ["one", "two"]);
  assert.deepEqual(selected.map((device) => device.online), [false, true]);
  assert.equal(selected[0], devices[1]);
  assert.equal(selected[1], devices[2]);
  assert.deepEqual(devices, before);
  assert.deepEqual(
    filterPickerDevices(devices, {
      family: "", deviceClass: "", kind: "", search: "",
    }),
    devices,
  );
});

test("unknown devices remain available under Other and unmatched filters return no items", () => {
  const unknown = item({ platform: "Android" });
  const filters = { family: "", deviceClass: "other", kind: "", search: "" };
  assert.deepEqual(filterPickerDevices([unknown], filters), [unknown]);
  assert.deepEqual(
    filterPickerDevices([unknown], { ...filters, deviceClass: "phone" }), [],
  );
  assert.deepEqual(
    filterPickerDevices([unknown], { ...filters, family: "Other" }), [],
  );
  assert.deepEqual(
    filterPickerDevices([unknown], { ...filters, search: "missing" }), [],
  );
  assert.deepEqual(filterPickerDevices([], filters), []);
});
