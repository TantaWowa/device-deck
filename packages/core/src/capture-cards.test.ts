import test from "node:test";
import assert from "node:assert/strict";
import { assignCaptureCard, mergeCaptureCards } from "./capture-cards";
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
