import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CaptureCardThumbnails } from "./local/capture-card-thumbnails";
import { DeckService } from "./local/service";
import { createService } from "./server";
import { Adapters } from "../../../packages/adapters/src";
import { CaptureEngine } from "../../../packages/capture/src";
import { validateConfig } from "../../../packages/config/src";
import { deleteCaptureCards } from "../../../packages/core/src/capture-cards";
import { LocalDevelopmentLicense } from "../../../scripts/local-license";
import type { DeviceConfig, SourceConfig } from "../../../packages/core/src/local/types";

const jpeg = Buffer.from([255, 216, 255, 217]);
const capacity = { concurrency: 1, queued: 2, entries: 2, bytes: 8, frameBytes: 8, ttl: 30_000 };

test("card thumbnails coalesce requests and cache successes and failures without timers", async () => {
  let now = 0, calls = 0;
  const thumbnails = new CaptureCardThumbnails(() => now, capacity);
  const work = async () => { calls++; return jpeg; };
  try {
    const result = await Promise.all(Array.from({ length: 20 }, () => thumbnails.get("one", work)));
    assert.ok(result.every((image) => image === jpeg));
    assert.equal(calls, 1);
    now = 29_999;
    await thumbnails.get("one", work);
    assert.equal(calls, 1);
    now = 30_000;
    await thumbnails.get("one", work);
    assert.equal(calls, 2);
    let failures = 0;
    const failure = async () => { failures++; throw new Error("No HDMI signal"); };
    await assert.rejects(thumbnails.get("bad", failure), /No HDMI signal/);
    await assert.rejects(thumbnails.get("bad", failure), /No HDMI signal/);
    assert.equal(failures, 1);
    now += 30_000;
    await assert.rejects(thumbnails.get("bad", failure), /No HDMI signal/);
    assert.equal(failures, 2);
  } finally { await thumbnails.close(); }
});

test("card thumbnails bound concurrent helpers and waiting work", async () => {
  const thumbnails = new CaptureCardThumbnails(Date.now, capacity);
  let release!: () => void, running = 0, peak = 0;
  const work = async () => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>((resolve) => { release = resolve; });
    running--; return jpeg;
  };
  const first = thumbnails.get("one", work);
  const second = thumbnails.get("two", work);
  const third = thumbnails.get("three", work);
  await assert.rejects(thumbnails.get("four", work), /previews are busy/);
  release(); await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(); await second;
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(); await third;
  assert.equal(peak, 1);
  await thumbnails.close();
  await assert.rejects(thumbnails.get("one", work), /stopping/);
});

test("card thumbnail memory is bounded and malformed frames are rejected", async () => {
  const thumbnails = new CaptureCardThumbnails(Date.now, capacity);
  let calls = 0;
  const work = async () => { calls++; return jpeg; };
  try {
    for (const id of ["one", "two", "three", "one"]) await thumbnails.get(id, work);
    assert.equal(calls, 4, "the oldest cached frame was evicted");
    await assert.rejects(thumbnails.get("bad", async () => Buffer.from("not JPEG")), /valid preview/);
    await assert.rejects(thumbnails.get("big", async () => Buffer.from([255, 216, 0, 0, 0, 0, 0, 0, 255, 217])), /valid preview/);
  } finally { await thumbnails.close(); }
});

class ThumbnailAdapters extends Adapters {
  constructor() {
    super(() => validateConfig({ schemaVersion: 1, settings: { folder: "./captures" } }), async () => ({
      stdout: Buffer.from(JSON.stringify([{ uniqueId: "hardware-one", name: "HDMI one" }, { uniqueId: "hardware-two", name: "HDMI two" }])), stderr: "",
    }));
  }
  async diagnostics() { return []; }
}
class ThumbnailCapture extends CaptureEngine {
  calls: { device: string | null; source: SourceConfig; interval: number; immediate: boolean }[] = [];
  pause?: () => Promise<void>;
  async preview(device: DeviceConfig | null, source: SourceConfig, interval = 750, immediate = false) {
    this.calls.push({ device: device?.id ?? null, source, interval, immediate });
    await this.pause?.();
    return jpeg;
  }
  async closeSource() {}
  async close() {}
}
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-card-thumbnails-"));
  const adapters = new ThumbnailAdapters(), capture = new ThumbnailCapture(adapters);
  const deck = new DeckService(directory, undefined, adapters, capture, new LocalDevelopmentLicense());
  await deck.init();
  const configured = { id: "registered", kind: "usb" as const, name: "Registered", uniqueId: "hardware-one" };
  const config = validateConfig({ ...deck.config.config, sources: [configured], devices: [
    { id: "one", name: "One", platform: "Other", kind: "physical", connection: { type: "capture" }, captureSourceId: configured.id },
  ] });
  await deck.execute("config.save", { config, revision: deck.config.revision });
  const listing = await adapters.captureCards(config.sources);
  const discovered = listing.sources.find((source) => source.uniqueId === "hardware-two")!;
  return { deck, adapters, capture, configured, discovered, cleanup: async () => { await deck.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("authenticated card thumbnails include discovered USB cards without discovery or configuration writes", async () => {
  const { deck, adapters, capture, discovered, cleanup } = await setup();
  const token = "a".repeat(64), server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/capture-card-thumbnail/${encodeURIComponent(discovered.id)}`;
  try {
    const disk = await readFile(deck.config.file, "utf8"), revision = deck.config.revision;
    const requests = adapters.cameras.stats().requests;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    await Promise.all([deck.captureCardThumbnail(discovered.id), deck.captureCardThumbnail(discovered.id)]);
    assert.equal(capture.calls.length, 1);
    assert.deepEqual(capture.calls[0], { device: null, source: { id: discovered.id, name: discovered.name, kind: "usb", uniqueId: discovered.uniqueId }, interval: 30_000, immediate: true });
    assert.equal(adapters.cameras.stats().requests, requests, "thumbnail requests never enumerate cameras");
    assert.equal(deck.config.revision, revision);
    assert.equal(await readFile(deck.config.file, "utf8"), disk);
    await assert.rejects(deck.captureCardThumbnail("arbitrary-hardware-id"), /no longer available/);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test("cached card thumbnails still enforce bound-device locks, release, and deleted-card rules", async () => {
  const { deck, capture, configured, discovered, cleanup } = await setup();
  try {
    await deck.captureCardThumbnail(configured.id);
    await deck.captureCardThumbnail(discovered.id);
    await deck.execute("devices.bulk", { ids: ["one"], action: "lock", reason: "maintenance" });
    await assert.rejects(deck.captureCardThumbnail(configured.id), /locked/);
    await deck.execute("devices.bulk", { ids: ["one"], action: "unlock", reason: "maintenance complete" });
    const { session } = deck.store.reserve("one", configured.id, "usb:hardware-one", "Fixture", "Thumbnail test", 15);
    session.state = "closing"; deck.store.putSession(session);
    await assert.rejects(deck.captureCardThumbnail(configured.id), /being released/);
    session.state = "closed"; deck.store.putSession(session);
    await deck.execute("config.save", { config: deleteCaptureCards(deck.config.config, [configured, discovered]), revision: deck.config.revision });
    await assert.rejects(deck.captureCardThumbnail(configured.id), /no longer available/);
    await assert.rejects(deck.captureCardThumbnail(discovered.id), /no longer available/);
    assert.equal(capture.calls.length, 2);
  } finally { await cleanup(); }
});

test("deleting a discovered card while its thumbnail is loading rejects the completed frame", async () => {
  const { deck, capture, discovered, cleanup } = await setup();
  try {
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    capture.pause = () => new Promise<void>((resolve) => { release = resolve; started(); });
    const thumbnail = deck.captureCardThumbnail(discovered.id);
    const rejected = assert.rejects(thumbnail, /no longer available/);
    await entered;
    await deck.execute("config.save", { config: deleteCaptureCards(deck.config.config, [discovered]), revision: deck.config.revision });
    release(); await rejected;
  } finally { await cleanup(); }
});
