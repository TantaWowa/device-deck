import test from "node:test";
import assert from "node:assert/strict";
import type { Artifact } from "./local/types";
import { captureBatches, captureDownloadName, captureStorage, formatCaptureBytes, visibleCaptures, visibleCaptureSelection, type CaptureFilters, type CaptureSortColumn } from "./capture-library";

const capture = (id: string, overrides: Partial<Artifact> = {}): Artifact => ({
  id, deviceId: "roku", sessionId: "session", owner: "QA", sourceId: "source", name: id,
  path: `/captures/${id}.png`, logPath: `/captures/${id}.json`, kind: "screenshot", mode: "clean",
  tags: [], createdAt: 100, duration: 0, bytes: 100, status: "completed", origin: "Web", ...overrides,
});
const devices = [{ id: "roku", name: "Roku 10", platform: "Roku" as const }, { id: "android", name: "Phone 2", platform: "Android" as const }];
const filters: CaptureFilters = { search: "", platform: "", deviceId: "", kind: "", trash: false };
const sort = { column: "createdAt" as const, direction: "descending" as const };

test("capture search intersects device, platform, kind and trash filters while excluding purged files", () => {
  const items = [capture("one", { name: "Login screen", tags: ["Release"], deviceId: "android" }), capture("two", { name: "Login run", kind: "recording" }), capture("three", { name: "Login trash", deletedAt: 100 }), capture("four", { name: "Login gone", deletedAt: 100, purgedAt: 200 })];
  const find = (changes: Partial<CaptureFilters>) => visibleCaptures(items, devices, { ...filters, ...changes }, sort).map((a) => a.id);
  assert.deepEqual(find({ search: " release " }), ["one"]);
  assert.deepEqual(find({ search: "phone 2", platform: "Android", kind: "screenshot", deviceId: "android" }), ["one"]);
  assert.deepEqual(find({ search: "login", platform: "Roku", kind: "screenshot" }), []);
  assert.deepEqual(find({ search: "login", trash: true }), ["three"]);
  assert.deepEqual(find({ search: "Android" }), ["one"]);
  assert.deepEqual(find({ deviceId: "roku", kind: "recording" }), ["two"]);
});

test("all table columns sort naturally in both directions without mutating artifacts", () => {
  const items = [capture("ten", { name: "Capture 10", createdAt: 20, bytes: 200, status: "interrupted" }), capture("two", { name: "Capture 2", deviceId: "android", kind: "recording", createdAt: 10, bytes: 100 })];
  const expected: Record<CaptureSortColumn, string[]> = {
    name: ["two", "ten"], device: ["two", "ten"], kind: ["two", "ten"], createdAt: ["two", "ten"], bytes: ["two", "ten"], status: ["two", "ten"],
  };
  for (const column of Object.keys(expected) as CaptureSortColumn[]) {
    assert.deepEqual(visibleCaptures(items, devices, filters, { column, direction: "ascending" }).map((a) => a.id), expected[column]);
    assert.deepEqual(visibleCaptures(items, devices, filters, { column, direction: "descending" }).map((a) => a.id), [...expected[column]].reverse());
  }
  assert.deepEqual(items.map((a) => a.id), ["ten", "two"]);
  assert.deepEqual(visibleCaptures([capture("first"), capture("second")], devices, filters, sort).map((a) => a.id), ["first", "second"]);
});

test("selection drops filtered-out and active captures and request batches never exceed the API limit", () => {
  assert.deepEqual(visibleCaptureSelection(["hidden", "done", "recording", "finalizing", "done"], [capture("done"), capture("recording", { status: "recording" }), capture("finalizing", { status: "finalizing" })]), ["done"]);
  const ids = Array.from({ length: 205 }, (_, i) => String(i));
  const batches = captureBatches([...ids, "1"]);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(batches.flat(), ids);
  assert.deepEqual(captureBatches([]), []);
});

test("fallback storage excludes purged captures and separates trash from the library", () => {
  assert.deepEqual(captureStorage([capture("one", { bytes: 200 }), capture("trash", { bytes: 50, deletedAt: 100 }), capture("purged", { bytes: 900, deletedAt: 100, purgedAt: 200 })]), { library: { count: 1, bytes: 200 }, trash: { count: 1, bytes: 50 } });
  assert.equal(formatCaptureBytes(1536), "1.5 KB");
  assert.equal(formatCaptureBytes(0), "0 B");
});

test("downloads retain the real file extension and distinguish clean originals and metadata", () => {
  const artifact = capture("one", { name: "Login / phone.PNG", path: "/captures/one.PNG", cleanPath: "/captures/one-clean.png" });
  assert.equal(captureDownloadName(artifact), "Login _ phone.PNG");
  assert.equal(captureDownloadName(artifact, "clean"), "Login _ phone-clean.png");
  assert.equal(captureDownloadName(capture("video", { name: "Demo", kind: "recording", path: "/clips/run.webm" })), "Demo.webm");
  assert.equal(captureDownloadName(capture("one", { name: "Login" }), "log"), "Login-metadata.json");
});
