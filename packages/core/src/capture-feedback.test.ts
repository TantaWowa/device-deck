import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "./local/types";
import { CaptureCompletionTracker } from "./capture-feedback";

const artifact = (id: string, status: Artifact["status"] = "completed"): Artifact => ({
  id, status, deviceId: "one", sessionId: "session", owner: "QA", sourceId: "source",
  name: id, path: `/tmp/${id}.png`, logPath: `/tmp/${id}.json`, kind: "screenshot",
  mode: "clean", tags: [], createdAt: 1, duration: 0, bytes: 42, origin: "Web",
});

test("completion notifications baseline history and include new screenshots and auto-finalized recordings", () => {
  const tracker = new CaptureCompletionTracker();
  assert.deepEqual(tracker.update([artifact("old"), artifact("recording", "recording")]), []);
  assert.deepEqual(tracker.update([artifact("old"), artifact("recording", "finalizing")]), []);
  assert.deepEqual(tracker.update([artifact("old"), artifact("recording", "interrupted"), artifact("new")]).map(a => a.id), ["recording", "new"]);
  assert.deepEqual(tracker.update([artifact("recording", "interrupted"), artifact("new")]), []);
});

test("direct completion and polling cannot duplicate notifications; removed captures stay quiet", () => {
  const tracker = new CaptureCompletionTracker();
  tracker.update([]);
  assert.equal(tracker.completed(artifact("new"))?.id, "new");
  assert.deepEqual(tracker.update([artifact("new"), { ...artifact("deleted"), deletedAt: 2 }, { ...artifact("purged"), purgedAt: 2 }]), []);
  assert.equal(tracker.completed(artifact("new")), undefined);
  assert.deepEqual(tracker.update([artifact("failure", "failed")]).map(a => a.id), ["failure"]);
});
