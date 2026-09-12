import test from "node:test";
import assert from "node:assert/strict";
import {
  DemoModel,
  filterDevices,
  emptyFilters,
  cliCommand,
} from "../../../apps/web/src/demo/model";

test("combined filters distinguish offline, maintenance, reservations, types and visibility", () => {
  const m = new DemoModel(() => 0);
  const filter = (f: Partial<typeof emptyFilters>) =>
    filterDevices(m.inventory.devices, m.inventory.leases, {
      ...emptyFilters,
      ...f,
    }).map((d) => d.id);
  assert.deepEqual(
    filter({
      platform: "Android",
      kind: "virtual",
      reserved: "free",
      visibility: "local",
      health: "online",
      locked: "unlocked",
      search: "Pixel",
    }),
    ["pixel-emulator"],
  );
  assert.deepEqual(filter({ health: "offline", reserved: "free" }), [
    "roku-stick",
  ]);
  assert.deepEqual(
    filter({ locked: "locked", health: "online", reserved: "free" }),
    ["shield"],
  );
  assert.deepEqual(filter({ platform: "Roku", reserved: "reserved" }), [
    "roku-desk",
  ]);
  assert.deepEqual(filter({ platform: "Apple", search: "Roku" }), []);
});
test("occupied devices, unknown devices, offline devices and maintenance locks reject reservation or control", () => {
  const m = new DemoModel();
  for (const id of ["android-tv", "roku-stick", "shield", "missing"])
    assert.throws(() => m.reserve(id, "Check"));
  assert.throws(() => m.input("android-tv", "Home"));
  assert.throws(() => m.capture("android-tv"));
  assert.throws(() => m.reserve("apple-sim", ""));
  m.reserve("apple-sim", "Review", "CLI · local");
  assert.equal(m.lease("apple-sim")?.owner, "CLI · local");
});
test("expiry finalizes only the expired recording and rejects stale control", () => {
  let now = 0;
  const m = new DemoModel(() => now);
  m.toggleRecording("roku-desk");
  now = 1500;
  m.input("roku-desk", "Right");
  now = 901000;
  m.expire();
  assert.equal(m.recordings.size, 0);
  assert.equal(m.artifacts[0].kind, "recording");
  assert.equal(m.artifacts[0].sessionId, "session-desk");
  assert.equal(m.artifacts[0].log[0].elapsedMs, 1500);
  assert.throws(() => m.capture("roku-desk"));
  m.reserve("roku-desk", "New check");
  assert.equal(
    m.inventory.leases.filter((l) => l.deviceId === "roku-desk").length,
    1,
  );
});
test("bulk operations have per-device eligibility and unlock never releases a session", () => {
  const m = new DemoModel();
  const results = m.bulk(
    ["roku-desk", "roku-stick", "shield", "apple-sim", "apple-tv"],
    "restart",
  );
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, false, true, false],
  );
  const locks = m.bulk(["roku-desk", "apple-sim"], "lock");
  assert.deepEqual(
    locks.map((r) => r.ok),
    [false, true],
  );
  assert.equal(m.device("apple-sim").locked, true);
  assert.throws(() => m.reserve("apple-sim", "Check"));
  m.bulk(["shield", "roku-desk"], "unlock");
  assert.equal(m.device("shield").locked, false);
  assert.ok(m.lease("roku-desk"));
  m.release("roku-desk");
  assert.equal(m.lease("roku-desk"), undefined);
});
test("device add/edit validates unique friendly names and preserves the previous binding on conflict", () => {
  const m = new DemoModel();
  assert.throws(() => m.saveDevice({ ...m.device("apple-sim"), name: "  " }));
  assert.throws(() =>
    m.saveDevice({ ...m.device("apple-sim"), name: "DESK ROKU" }),
  );
  assert.throws(() => m.bindSource("roku-desk", "hd60"), /Source conflict/);
  assert.equal(m.device("roku-desk").captureSourceId, "cam-link");
  assert.throws(() => m.bindSource("roku-desk", "native"), /Native capture/);
  assert.throws(() => m.bindSource("roku-desk", "avermedia"), /reserved/);
  m.release("roku-desk");
  m.bindSource("roku-desk", "avermedia");
  assert.equal(m.device("roku-desk").captureSourceId, "avermedia");
  assert.throws(() => m.bindSource("android-tv", "cam-link"), /other owner/);
  m.reserve("roku-desk", "Recording test");
  m.toggleRecording("roku-desk");
  assert.throws(() => m.bindSource("roku-desk", ""), /Stop recording/);
  m.saveDevice({
    ...m.device("apple-sim"),
    id: "new-sim",
    name: "Second simulator",
  });
  assert.equal(m.inventory.devices.length, 9);
});
test("device input targets exactly one device and records elapsed time and session identity", () => {
  let now = 0;
  const m = new DemoModel(() => now);
  m.reserve("apple-sim", "Side by side");
  m.toggleRecording("roku-desk");
  now = 1250;
  const a = m.input("roku-desk", "Right");
  assert.equal(a.deviceId, "roku-desk");
  assert.equal(a.sessionId, "session-desk");
  assert.equal(a.elapsedMs, 1250);
  assert.equal(a.screenIndex, 1);
  const b = m.input("apple-sim", "Home");
  assert.equal(b.elapsedMs, null);
  assert.equal(b.recordingId, null);
  now = 3000;
  m.toggleRecording("roku-desk");
  const video = m.artifacts[0];
  assert.equal(video.duration, 3);
  assert.equal(video.log.length, 1);
  assert.equal(video.log[0].deviceId, "roku-desk");
  m.settings.logging = false;
  const count = m.inputs.length;
  m.input("roku-desk", "Left");
  assert.equal(m.inputs.length, count);
});
test("missing sources block capture while unsupported input does not claim control support", () => {
  const m = new DemoModel();
  m.reserve("android-spare", "Check card");
  assert.throws(() => m.capture("android-spare"), /disconnected/);
  assert.throws(() => m.toggleRecording("android-spare"), /disconnected/);
  m.reserve("apple-tv", "Inspect");
  assert.throws(() => m.input("apple-tv", "Home"), /unavailable/);
  assert.throws(() => m.capture("apple-tv"), /No capture/);
});
test("capture metadata editing, selection removal and undo retain identity", () => {
  const m = new DemoModel();
  const a = m.artifacts[0];
  const count = m.artifacts.length;
  assert.throws(() => m.editCapture(a.id, "bad/name", ""), /slashes/);
  m.editCapture(a.id, "review.png", "review, regression, review");
  assert.deepEqual(a.tags, ["review", "regression"]);
  const removed = m.removeCaptures([a.id, m.artifacts[1].id]);
  assert.equal(m.artifacts.length, count - 2);
  m.undoRemove(removed);
  m.undoRemove(removed);
  assert.equal(m.artifacts.length, count);
  assert.equal(m.artifacts.find((x) => x.id === a.id)?.name, "review.png");
});
test("settings, saved views and edited state survive restore; recordings become explicit interruptions", () => {
  let now = 0;
  const m = new DemoModel(() => now);
  m.saveSettings({
    ...m.settings,
    folder: "~/Movies/Regression",
    captureMode: "annotated",
    owner: "George",
    ttl: 20,
  });
  m.savedViews.push({
    name: "Roku",
    filters: { ...emptyFilters, platform: "Roku" },
  });
  m.toggleRecording("roku-desk");
  now = 1000;
  const restored = new DemoModel(() => now);
  assert.equal(restored.restore(m.serialize()), true);
  assert.equal(restored.settings.folder, "~/Movies/Regression");
  assert.equal(restored.savedViews[0].filters.platform, "Roku");
  assert.equal(restored.recordings.size, 0);
  assert.equal(restored.history[0].action, "Recording interrupted");
  assert.equal(restored.restore("{bad"), false);
  assert.equal(restored.restore("{}"), false);
  assert.throws(() =>
    restored.saveSettings({ ...restored.settings, folder: "relative/folder" }),
  );
  assert.throws(() =>
    restored.saveSettings({ ...restored.settings, naming: "duplicate-name" }),
  );
});
test("a recording keeps its initial output folder, mode and session when defaults change", () => {
  const m = new DemoModel(() => 0);
  m.toggleRecording("roku-desk");
  m.settings.folder = "~/Different";
  m.settings.captureMode = "annotated";
  m.release("roku-desk");
  assert.equal(m.artifacts[0].folder, "~/Movies/Device Deck");
  assert.equal(m.artifacts[0].mode, "clean");
  assert.equal(m.artifacts[0].sessionId, "session-desk");
});
test("copy CLI command shell-quotes a friendly name with an apostrophe", () => {
  const m = new DemoModel();
  assert.equal(
    cliCommand({ ...m.device("roku-desk"), name: "George's Roku" }),
    "devdeck remote --device 'George'\\''s Roku'",
  );
});

test("rapid captures get unique file names and history retains the actual session owner", () => {
  const m = new DemoModel(() => 0);
  m.release("roku-desk");
  m.reserve("roku-desk", "Review navigation", "George");
  assert.equal(m.history[0].owner, "George");
  const first = m.capture("roku-desk");
  const second = m.capture("roku-desk");
  assert.notEqual(first.name, second.name);
  m.release("roku-desk");
  assert.equal(m.history[0].owner, "George");
});
