import test from "node:test";
import assert from "node:assert/strict";
import { DemoModel } from "../../../apps/web/src/demo/model";

function availableModel() {
  const model = new DemoModel(() => 1000);
  model.inventory.leases = [];
  return model;
}

test("demo capture card bulk assignments support swaps and unassignment", () => {
  const model = availableModel();
  model.assignCards([
    { sourceId: "cam-link", deviceId: "android-tv" },
    { sourceId: "hd60", deviceId: "roku-desk" },
    { sourceId: "avermedia", deviceId: "apple-tv" },
  ]);
  assert.equal(model.device("android-tv").captureSourceId, "cam-link");
  assert.equal(model.device("roku-desk").captureSourceId, "hd60");
  assert.equal(model.device("apple-tv").captureSourceId, "avermedia");
  model.assignCards([
    { sourceId: "cam-link", deviceId: null },
    { sourceId: "hd60", deviceId: null },
  ]);
  assert.equal(model.device("android-tv").captureSourceId, "");
  assert.equal(model.device("roku-desk").captureSourceId, "");
  assert.equal(model.device("apple-tv").captureSourceId, "avermedia");
  assert.equal(model.device("apple-sim").captureSourceId, "native");
});

test("demo bulk assignment rejects invalid cards and target collisions atomically", () => {
  const invalidAssignments = [
    [{ sourceId: "hd60", deviceId: "missing-device" }],
    [{ sourceId: "hd60", deviceId: "apple-tv" }],
    [{ sourceId: "hd60", deviceId: "android-spare" }],
    [{ sourceId: "hd60", deviceId: "apple-sim" }],
    [{ sourceId: "missing-card", deviceId: null }],
    [{ sourceId: "native", deviceId: null }],
    [{ sourceId: "avermedia", deviceId: null }],
  ];
  for (const assignments of invalidAssignments) {
    const model = availableModel();
    const before = model.serialize();
    assert.throws(() => model.assignCards([
      { sourceId: "avermedia", deviceId: "apple-tv" },
      ...assignments,
    ]));
    assert.equal(model.serialize(), before);
  }
});

test("demo bulk card changes reject reserved current and destination devices before mutation", () => {
  for (const deviceId of ["roku-desk", "apple-tv"]) {
    const model = availableModel();
    model.reserve(deviceId, "Keep this binding");
    const before = model.serialize();
    assert.throws(() => model.assignCards([
      { sourceId: "avermedia", deviceId: "shield" },
      { sourceId: "cam-link", deviceId: "apple-tv" },
    ]), /reserved/);
    assert.equal(model.serialize(), before);
  }
  const model = availableModel();
  model.reserve("roku-desk", "Keep this card");
  const before = model.serialize();
  assert.throws(() => model.removeCards(["avermedia", "cam-link"]), /reserved/);
  assert.equal(model.serialize(), before);
});

test("demo card changes also reject recordings when a reservation has gone away", () => {
  const model = availableModel();
  model.reserve("roku-desk", "Record");
  model.toggleRecording("roku-desk");
  model.inventory.leases = [];
  const before = model.serialize();
  assert.throws(() => model.removeCards(["avermedia", "cam-link"]), /recording/);
  assert.equal(model.serialize(), before);
  assert.throws(() => model.assignCards([
    { sourceId: "avermedia", deviceId: "apple-tv" },
    { sourceId: "cam-link", deviceId: null },
  ]), /recording/);
  assert.equal(model.serialize(), before);
});

test("demo bulk changes reject an existing source conflict without clearing either binding", () => {
  const model = availableModel();
  model.device("apple-tv").captureSourceId = "cam-link";
  const before = model.serialize();
  assert.throws(() => model.assignCards([
    { sourceId: "avermedia", deviceId: "shield" },
    { sourceId: "cam-link", deviceId: null },
  ]), /source conflict/);
  assert.equal(model.serialize(), before);
  assert.throws(() => model.removeCards(["avermedia", "cam-link"]), /source conflict/);
  assert.equal(model.serialize(), before);
});

test("demo deleting cards persists their removal and retains capture records and device history", () => {
  const model = availableModel();
  const artifacts = structuredClone(model.artifacts);
  const history = structuredClone(model.history);
  const reportCaptures = structuredClone(model.reportCaptures);
  model.removeCards(["cam-link", "hd60"]);
  assert.equal(model.device("roku-desk").captureSourceId, "");
  assert.equal(model.device("android-tv").captureSourceId, "");
  assert.deepEqual(model.deletedCards.map((card) => card.id), ["cam-link", "hd60"]);
  assert.equal(model.inventory.sources.some((card) => card.id === "cam-link"), false);
  assert.equal(model.inventory.devices.length, 8);
  assert.deepEqual(model.artifacts, artifacts);
  assert.deepEqual(model.reportCaptures, reportCaptures);
  assert.deepEqual(model.history.slice(2), history);

  const restored = availableModel();
  assert.equal(restored.restore(model.serialize()), true);
  assert.deepEqual(restored.deletedCards, model.deletedCards);
  assert.deepEqual(restored.inventory.sources, model.inventory.sources);
  assert.equal(restored.device("roku-desk").captureSourceId, "");
  assert.deepEqual(restored.artifacts, artifacts);

  restored.restoreDeletedCards();
  assert.equal(restored.deletedCards.length, 0);
  assert.ok(restored.inventory.sources.some((card) => card.id === "cam-link"));
  assert.equal(restored.device("roku-desk").captureSourceId, "");
  assert.equal(restored.device("android-tv").captureSourceId, "");
  const once = restored.serialize();
  restored.restoreDeletedCards();
  assert.equal(restored.serialize(), once);
});

test("demo delete rejects unknown, native and duplicate cards atomically", () => {
  for (const sourceId of ["missing-card", "native", "avermedia"]) {
    const model = availableModel();
    const before = model.serialize();
    assert.throws(() => model.removeCards(["avermedia", sourceId]));
    assert.equal(model.serialize(), before);
  }
});

test("demo existing saved state restores without deleted-card data", () => {
  const model = availableModel();
  const state = JSON.parse(model.serialize());
  delete state.deletedCards;
  model.removeCards(["avermedia"]);
  assert.equal(model.restore(JSON.stringify(state)), true);
  assert.deepEqual(model.deletedCards, []);
  assert.ok(model.inventory.sources.some((card) => card.id === "avermedia"));
});
