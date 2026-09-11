import test from "node:test";
import assert from "node:assert/strict";
import { DemoModel } from "../../../apps/app/src/demo/model";
test("demo rejects an occupied device and control by another owner", () => {
  const m = new DemoModel();
  assert.throws(() => m.reserve("android-tv", "check"));
  assert.throws(() => m.capture("android-tv"));
});
test("expiry finalizes simulated recording before a new reservation", () => {
  let now = 0;
  const m = new DemoModel(() => now);
  m.toggleRecording("roku-desk");
  now = 901000;
  m.expire();
  assert.equal(m.recordings.size, 0);
  assert.equal(m.artifacts[0].kind, "recording");
  assert.throws(() => m.capture("roku-desk"));
  m.reserve("roku-desk", "New check");
  assert.equal(
    m.inventory.leases.filter((l) => l.deviceId === "roku-desk").length,
    1,
  );
});
