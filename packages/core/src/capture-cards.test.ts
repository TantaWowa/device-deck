import test from "node:test";
import assert from "node:assert/strict";
import {
  assignCaptureCard,
  assignCustomCaptureCard,
  mergeCaptureCards,
} from "./capture-cards";
import { validateConfig } from "../../config/src";
import { DemoModel } from "../../../apps/web/src/demo/model";
const cards = [
  {
    id: "saved-alias",
    name: "Desk HDMI",
    kind: "usb" as const,
    uniqueId: "hardware-1",
  },
  {
    id: "missing",
    name: "Disconnected HDMI",
    kind: "usb" as const,
    uniqueId: "hardware-2",
  },
  { id: "screen", name: "Native", kind: "native" as const, deviceId: "one" },
];
test("card discovery merges hardware identity, keeps disconnected cards and excludes native screens", () => {
  const found = [
    { name: "Renamed by driver", uniqueId: "hardware-1" },
    { name: "New HDMI", uniqueId: "hardware-3" },
  ];
  const one = mergeCaptureCards(cards, found, (id) => "detected-" + id);
  const reordered = mergeCaptureCards(
    cards,
    [...found].reverse(),
    (id) => "detected-" + id,
  );
  assert.deepEqual(one, reordered);
  assert.equal(one.length, 3);
  assert.equal(one.find((c) => c.uniqueId === "hardware-1")?.id, "saved-alias");
  assert.equal(one.find((c) => c.id === "missing")?.status, "missing");
  assert.equal(
    one.some((c) => c.kind === "native"),
    false,
  );
});
test("card reassignment preserves existing hardware aliases and refuses replacing another input", () => {
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: "/tmp/captures" },
    sources: cards,
    devices: ["one", "two"].map((id) => ({
      id,
      name: id,
      platform: "Android",
      kind: "virtual",
      connection: { type: "adb", serial: id },
      captureSourceId: id === "one" ? "saved-alias" : null,
    })),
  });
  const moved = assignCaptureCard(
    config,
    { ...cards[0], id: "discovered-alias" },
    "two",
  );
  assert.equal(moved.sources.length, 3);
  assert.equal(moved.devices[0].captureSourceId, null);
  assert.equal(moved.devices[1].captureSourceId, "saved-alias");
  assert.equal(config.devices[0].captureSourceId, "saved-alias");
  assert.throws(() => assignCaptureCard(moved, cards[1], "two"), /already has/);
  assert.equal(
    assignCaptureCard(moved, cards[0], null).devices[1].captureSourceId,
    null,
  );
});
test("demo card assignments are atomic, reject reservations and persist through reload", () => {
  const model = new DemoModel();
  assert.throws(() => model.assignCard("cam-link", "shield"), /reserved/);
  model.release("roku-desk");
  model.assignCard("cam-link", "shield");
  assert.equal(model.device("roku-desk").captureSourceId, "");
  assert.equal(model.device("shield").captureSourceId, "cam-link");
  assert.throws(() => model.assignCard("avermedia", "shield"), /already has/);
  assert.equal(model.device("shield").captureSourceId, "cam-link");
  const restored = new DemoModel();
  assert.ok(restored.restore(model.serialize()));
  assert.equal(restored.device("shield").captureSourceId, "cam-link");
  restored.assignCard("cam-link", null);
  assert.equal(restored.device("shield").captureSourceId, "");
});

const emptyConfig = () =>
  validateConfig({
    schemaVersion: 1,
    settings: { folder: "/tmp/captures" },
  });

test("custom capture assignments register a new card and trimmed physical target without retaining discovery fields or input references", () => {
  const config = emptyConfig();
  const card = { ...cards[0], status: "connected", detail: "Detected" };
  const original = structuredClone({ config, card });
  const next = assignCustomCaptureCard(config, card, {
    id: "mac-mini",
    name: "  Mac mini  ",
  });
  assert.deepEqual(next.devices, [
    {
      id: "mac-mini",
      name: "Mac mini",
      platform: "Other",
      kind: "physical",
      model: "USB capture",
      visibility: "local",
      connection: { type: "capture" },
      captureSourceId: "saved-alias",
    },
  ]);
  assert.deepEqual(next.sources, [cards[0]]);
  validateConfig(next);
  assert.deepEqual({ config, card }, original);
  next.sources[0].name = "Changed output";
  next.settings.owner = "Changed output";
  assert.deepEqual({ config, card }, original);
});

test("custom assignment uses the stable configured card alias and preserves a remote-capable previous owner", () => {
  const config = validateConfig({
    ...emptyConfig(),
    sources: [cards[0]],
    devices: [
      {
        id: "roku",
        name: "Desk Roku",
        platform: "Roku",
        kind: "physical",
        model: "Ultra",
        visibility: "shared",
        connection: { type: "roku", host: "roku.example.test", serial: "R1" },
        captureSourceId: "saved-alias",
      },
    ],
  });
  const before = structuredClone(config);
  const next = assignCustomCaptureCard(
    config,
    { ...cards[0], id: "new-driver-alias", name: "Driver name" },
    { id: "mac-mini", name: "Mac mini" },
  );
  assert.deepEqual(next.sources, before.sources);
  assert.deepEqual(next.devices[0], {
    ...before.devices[0],
    captureSourceId: null,
  });
  assert.equal(next.devices[1].captureSourceId, "saved-alias");
  assert.equal(next.devices.length, 2);
  validateConfig(next);
  assert.deepEqual(config, before);
});

test("renaming a custom card target preserves its ID and all other configuration for existing history", () => {
  const config = assignCustomCaptureCard(emptyConfig(), cards[0], {
    id: "existing-capture-target",
    name: "Original label",
  });
  config.devices[0].model = "Previously configured model";
  config.devices[0].visibility = "shared";
  const before = structuredClone(config);
  const next = assignCustomCaptureCard(
    config,
    { ...cards[0], id: "new-driver-alias" },
    { id: "newly-generated-id", name: "  Mac mini  " },
  );
  assert.deepEqual(next, {
    ...before,
    devices: [{ ...before.devices[0], name: "Mac mini" }],
  });
  const repeated = assignCustomCaptureCard(next, cards[0], {
    id: "another-generated-id",
    name: " MAC MINI ",
  });
  assert.equal(repeated.devices.length, 1);
  assert.equal(repeated.devices[0].id, "existing-capture-target");
  assert.equal(repeated.devices[0].name, "MAC MINI");
  validateConfig(repeated);
  assert.deepEqual(config, before);
});

test("custom assignments reject invalid names, duplicate identities and source collisions without mutating inputs", () => {
  const config = assignCustomCaptureCard(emptyConfig(), cards[0], {
    id: "one",
    name: "Mac mini",
  });
  const before = structuredClone(config);
  for (const name of ["", " \t\n ", "a".repeat(65)])
    assert.throws(
      () => assignCustomCaptureCard(config, cards[1], { id: "two", name }),
      /name between 1 and 64/,
    );
  for (const name of ["Mac mini", " MAC MINI "])
    assert.throws(
      () => assignCustomCaptureCard(config, cards[1], { id: "two", name }),
      /name already exists/,
    );
  for (const id of ["", "has spaces", "../target", "a".repeat(129)])
    assert.throws(
      () => assignCustomCaptureCard(config, cards[1], { id, name: "New" }),
      /valid device ID/,
    );
  assert.throws(
    () => assignCustomCaptureCard(config, cards[1], { id: "ONE", name: "New" }),
    /device ID is already in use/,
  );
  assert.throws(
    () =>
      assignCustomCaptureCard(
        config,
        { ...cards[1], id: "saved-alias" },
        { id: "two", name: "New" },
      ),
    /capture source ID is already used/,
  );
  for (const card of [
    cards[2],
    { ...cards[1], uniqueId: undefined },
    { ...cards[1], uniqueId: "  " },
    { ...cards[1], id: "" },
    { ...cards[1], id: "x".repeat(161) },
    { ...cards[1], name: "" },
  ])
    assert.throws(() =>
      assignCustomCaptureCard(config, card, { id: "two", name: "New" }),
    );
  const maximumName = assignCustomCaptureCard(config, cards[1], {
    id: "two",
    name: ` ${"a".repeat(64)} `,
  });
  assert.equal(maximumName.devices[1].name.length, 64);
  const both = assignCustomCaptureCard(config, cards[1], {
    id: "two",
    name: "Second target",
  });
  assert.throws(
    () =>
      assignCustomCaptureCard(both, cards[0], {
        id: "ignored",
        name: "SECOND TARGET",
      }),
    /name already exists/,
  );
  assert.deepEqual(config, before);
});
