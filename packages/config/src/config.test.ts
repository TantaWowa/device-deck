import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore, validateConfig } from "./index";
test("physical iOS native capture requires WebDriverAgent configuration and validates its device port", () => {
  const device = { id: "iphone", name: "iPhone", platform: "Apple", kind: "physical", connection: { type: "apple-device", udid: "core-device-id" }, captureSourceId: "screen" };
  const base = { schemaVersion: 1, settings: { folder: "./captures" }, devices: [device], sources: [{ id: "screen", name: "iPhone screen", kind: "native", deviceId: "iphone" }] };
  assert.throws(() => validateConfig(base), /no native capture adapter/);
  const configured = { ...base, devices: [{ ...device, connection: { ...device.connection, webDriverAgent: {} } }] };
  const parsed = validateConfig(configured).devices[0].connection;
  assert.equal(parsed.type, "apple-device");
  assert(parsed.type === "apple-device");
  assert.equal(parsed.webDriverAgent?.port, 8100);
  for (const port of [0, 65536, 1.5]) assert.throws(() => validateConfig({ ...base,
    devices: [{ ...device, connection: { ...device.connection, webDriverAgent: { port } } }],
  }));
  const legacy = validateConfig({ ...base, devices: [{ ...device, captureSourceId: null }], sources: [] });
  assert(legacy.devices[0].connection.type === "apple-device");
  assert.equal(legacy.devices[0].connection.webDriverAgent, undefined);
});
test("two concurrent saves with one revision have exactly one winner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-config-"));
  const store = new ConfigStore(path.join(dir, "config.json"));
  await store.load();
  try {
    const revision = store.revision;
    const a = structuredClone(store.config),
      b = structuredClone(store.config);
    a.settings.owner = "A";
    b.settings.owner = "B";
    const result = await Promise.allSettled([
      store.save(a, revision),
      store.save(b, revision),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(result.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      JSON.parse(await readFile(store.file, "utf8")).settings.owner,
      store.config.settings.owner,
    );
    await writeFile(store.file, "broken");
    assert.equal(await store.refresh(), false);
    assert.ok(store.error);
    assert.equal(store.config.settings.owner, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("device tags are optional for existing configs and validated when present", () => {
  const base = {
    schemaVersion: 1,
    settings: { folder: "./captures" },
    devices: [
      {
        id: "legacy",
        name: "Legacy phone",
        platform: "Android",
        kind: "virtual",
        connection: {
          type: "adb",
          serial: "emulator-5554",
          avdName: "Legacy_Phone",
          port: 5037,
        },
      },
    ],
  };
  assert.equal(validateConfig(base).devices[0].tags, undefined);
  assert.deepEqual(
    validateConfig({
      ...base,
      devices: [{ ...base.devices[0], tags: ["ci", "nightly"] }],
    }).devices[0].tags,
    ["ci", "nightly"],
  );
  assert.throws(
    () =>
      validateConfig({
        ...base,
        devices: [{ ...base.devices[0], tags: ["ci", "ci"] }],
      }),
    /tags must be unique/i,
  );
});
test("duplicate USB identities and physical devices across hosts or ADB ports are rejected", () => {
  const c = validateConfig({
    schemaVersion: 1,
    settings: { folder: "./captures" },
  });
  assert.throws(
    () =>
      validateConfig({
        ...c,
        sources: [
          { id: "one", name: "One", kind: "usb", uniqueId: "physical" },
          { id: "two", name: "Two", kind: "usb", uniqueId: "physical" },
        ],
      }),
    /cannot be registered twice/,
  );
  const d = {
    id: "a",
    name: "A",
    platform: "Android",
    kind: "physical",
    connection: { type: "adb", serial: "serial", port: 5037 },
  };
  assert.throws(
    () =>
      validateConfig({
        ...c,
        devices: [
          d,
          {
            ...d,
            id: "b",
            name: "B",
            connection: { ...d.connection, port: 5038 },
          },
        ],
      }),
    /hardware identity/,
  );
});

test("AVD names are persistent virtual identities; physical targets and duplicate AVD or legacy transports are rejected", () => {
  const c = validateConfig({
    schemaVersion: 1,
    settings: { folder: "./captures" },
  });
  const d = {
    id: "a",
    name: "A",
    platform: "Android",
    kind: "virtual",
    connection: {
      type: "adb",
      serial: "emulator-5554",
      port: 5037,
      avdName: "TV_35",
    },
  };
  assert.throws(
    () => validateConfig({ ...c, devices: [{ ...d, kind: "physical" }] }),
    /only valid for Android virtual/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...c,
        devices: [
          { ...d, connection: { ...d.connection, hardwareId: "physical" } },
        ],
      }),
    /only valid for Android virtual/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...c,
        devices: [
          d,
          {
            ...d,
            id: "b",
            name: "B",
            connection: {
              ...d.connection,
              serial: "emulator-5556",
              port: 5038,
            },
          },
        ],
      }),
    /hardware identity/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...c,
        devices: [
          d,
          {
            ...d,
            id: "b",
            name: "B",
            connection: { type: "adb", serial: "emulator-5554", port: 5037 },
          },
        ],
      }),
    /ADB transport cannot be registered twice/,
  );
  assert.throws(() =>
    validateConfig({
      ...c,
      devices: [
        { ...d, connection: { ...d.connection, avdName: "-wipe-data" } },
      ],
    }),
  );
  assert.equal(
    validateConfig({
      ...c,
      tools: { emulator: "/sdk/emulator/emulator" },
      devices: [
        d,
        {
          ...d,
          id: "b",
          name: "B",
          connection: { ...d.connection, avdName: "Pixel_35" },
        },
      ],
    }).devices.length,
    2,
    "Distinct AVDs may reuse a previous transport serial",
  );
});
