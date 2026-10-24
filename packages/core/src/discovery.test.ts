import test from "node:test";
import assert from "node:assert/strict";
import {
  registerDiscoveredDevices,
  staleVirtualDevices,
  isDeviceConfigured,
  registrationIssue,
} from "./discovery";
import { validateConfig } from "../../config/src";
import { deviceIdentity } from "./local/identity";
import type { DeviceConfig } from "./local/types";

const device = (id: string, name = "TV"): DeviceConfig => ({
  id,
  name,
  platform: "Android",
  kind: "virtual",
  model: "Test",
  visibility: "local",
  connection: { type: "adb", serial: id, port: 5037 },
  captureSourceId: `native-${id}`,
});
const empty = () =>
  validateConfig({ schemaVersion: 1, settings: { folder: "/tmp/deck-test" } });
const discovery = (devices: DeviceConfig[]) => ({
  devices,
  sources: [],
  diagnostics: [],
});

test("AVD identity survives ADB serial changes and deduplicates legacy rows without merging different AVDs", () => {
  const current = empty();
  const configured: DeviceConfig = {
    ...device("my-tv", "My TV"),
    captureSourceId: null,
    connection: {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
      avdName: "TV_35",
    },
  };
  current.devices = [configured];
  const rebound: DeviceConfig = {
    ...device("found-tv"),
    connection: {
      type: "adb",
      serial: "emulator-5560",
      port: 5038,
      avdName: "TV_35",
    },
  };
  assert.equal(deviceIdentity(configured), deviceIdentity(rebound));
  assert.equal(isDeviceConfigured(current, rebound), true);
  const different: DeviceConfig = {
    ...rebound,
    connection: {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
      avdName: "Pixel_35",
    },
  };
  assert.equal(
    isDeviceConfigured(current, different),
    false,
    "An old serial may now belong to a different AVD",
  );
  current.devices = [
    {
      ...configured,
      connection: { type: "adb", serial: "emulator-5554", port: 5037 },
    },
  ];
  assert.equal(
    isDeviceConfigured(current, different),
    true,
    "A serial-only legacy row is not duplicated during discovery",
  );
  const offline: DeviceConfig = {
    ...rebound,
    connection: {
      type: "adb",
      serial: "avd-found-tv",
      port: 5037,
      avdName: "TV_35",
    },
  };
  const registered = registerDiscoveredDevices(empty(), discovery([offline]), [
    offline.id,
  ]);
  validateConfig(registered.config);
  assert.equal(
    registered.config.devices[0].connection.type === "adb" &&
      registered.config.devices[0].connection.avdName,
    "TV_35",
  );
});

test("bulk registration adds only selected devices, creates native screens, and resolves duplicate names", () => {
  const current = empty();
  const found = discovery([device("one"), device("two"), device("three")]);
  const result = registerDiscoveredDevices(current, found, [
    "one",
    "two",
    "one",
  ]);
  assert.deepEqual(
    result.added.map((d) => d.name),
    ["TV", "TV (2)"],
  );
  assert.deepEqual(
    result.config.sources.map((s) => s.deviceId),
    ["one", "two"],
  );
  assert.equal(
    result.config.devices[1].captureSourceId,
    result.config.sources[1].id,
  );
  assert.equal(current.devices.length, 0);
  assert.equal(found.devices[1].name, "TV");
  validateConfig(result.config);
  const all = registerDiscoveredDevices(
    result.config,
    found,
    found.devices.map((d) => d.id),
  );
  assert.deepEqual(
    all.added.map((d) => d.id),
    ["three"],
  );
  assert.equal(all.added[0].name, "TV (3)");
  validateConfig(all.config);
});

test("rediscovery preserves configured identities, aliases and USB bindings without guessing new USB pairings", () => {
  const configured: DeviceConfig = {
    ...device("my-roku", "Desk Roku"),
    tags: ["ci", "living-room"],
    platform: "Roku",
    kind: "physical",
    connection: { type: "roku", serial: "serial-one", host: "192.0.2.1" },
    captureSourceId: "my-card",
  };
  const current = empty();
  current.devices.push(configured);
  current.sources.push({
    id: "my-card",
    name: "Desk HDMI",
    kind: "usb",
    uniqueId: "hardware-one",
  });
  const found = discovery([
    {
      ...configured,
      id: "discovered-roku",
      name: "Roku Ultra",
      captureSourceId: null,
    },
    {
      ...configured,
      id: "another-roku",
      connection: { type: "roku", serial: "serial-two", host: "192.0.2.2" },
    },
  ]);
  assert.equal(isDeviceConfigured(current, found.devices[0]), true);
  const result = registerDiscoveredDevices(
    current,
    found,
    found.devices.map((d) => d.id),
  );
  assert.deepEqual(result.config.devices[0], configured);
  assert.deepEqual(result.config.devices[0].tags, ["ci", "living-room"]);
  assert.deepEqual(result.config.sources, current.sources);
  assert.equal(result.added[0].captureSourceId, null);
  validateConfig(result.config);
});

test("bulk registration reuses native aliases and fits numbered names within config limits", () => {
  const current = empty();
  const longName = "x".repeat(64);
  current.devices.push({
    ...device("existing", longName),
    captureSourceId: null,
  });
  current.sources.push({
    id: "native-alias",
    name: "My screen",
    kind: "native",
    deviceId: "one",
  });
  const result = registerDiscoveredDevices(
    current,
    discovery([device("one", longName), device("two", longName)]),
    ["one", "two"],
  );
  assert.equal(result.added[0].captureSourceId, "native-alias");
  assert.equal(result.added[0].name.length, 64);
  assert.notEqual(result.added[0].name, result.added[1].name);
  assert.equal(result.config.sources[0].name, "My screen");
  validateConfig(result.config);
});

test("unverified wireless ADB and stale selections cannot produce a partial config change", () => {
  const current = empty();
  const wireless = {
    ...device("wireless"),
    connection: { type: "adb" as const, serial: "192.0.2.1:5555", port: 5037 },
  };
  assert.match(registrationIssue(wireless)!, /Authorize ADB/);
  assert.throws(
    () =>
      registerDiscoveredDevices(current, discovery([device("one"), wireless]), [
        "one",
        "wireless",
      ]),
    /hardware serial/,
  );
  assert.throws(
    () =>
      registerDiscoveredDevices(current, discovery([device("one")]), [
        "one",
        "gone",
      ]),
    /no longer in discovery/,
  );
  assert.equal(current.devices.length, 0);
});

test("stale cleanup tolerates unrelated discovery errors only when no removal is needed", () => {
  const current = empty();
  current.devices = [device("present")];
  const found = { ...discovery([device("present")]), diagnostics: ["Apple TV: No module named pyatv"] };
  assert.deepEqual(staleVirtualDevices(current, found), []);
  current.devices.push(device("missing"));
  assert.throws(() => staleVirtualDevices(current, found), /Cannot unregister stale/);
  assert.deepEqual(staleVirtualDevices(current, { ...found, diagnostics: [] }).map((device) => device.id), ["missing"]);
  assert.equal(current.devices.length, 2);
});
