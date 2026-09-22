import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckService } from "./local/service";
import { Adapters } from "../../../packages/adapters/src";
import { CaptureEngine, type RecordingHandle } from "../../../packages/capture/src";
import { ConfigStore, validateConfig } from "../../../packages/config/src";
import { assignCaptureCards, deleteCaptureCards } from "../../../packages/core/src/capture-cards";
import type { DeviceConfig, SourceConfig } from "../../../packages/core/src/local/types";
import { LocalDevelopmentLicense } from "../../../scripts/local-license";

const cards: SourceConfig[] = [
  { id: "card-one", name: "Card one", kind: "usb", uniqueId: "usb-one" },
  { id: "card-two", name: "Card two", kind: "usb", uniqueId: "usb-two" },
];
class CardAdapters extends Adapters {
  error: string | null = null;
  calls = 0;
  pause?: () => Promise<void>;
  constructor() {
    super(() => validateConfig({ schemaVersion: 1, settings: { folder: "./captures" } }));
  }
  async diagnostics() { return []; }
  async captureCards() {
    this.calls++;
    await this.pause?.();
    const observation = { observedAt: 100, refreshing: false, stale: Boolean(this.error), error: this.error, nextRefreshAt: 200 };
    return {
      sources: cards.map((card) => ({ ...card, status: "connected" as const, observation })),
      diagnostics: this.error ? [this.error] : [],
      observation,
    };
  }
}
class CardCapture extends CaptureEngine {
  closedSources: string[] = [];
  async preview() { return Buffer.from("preview fixture"); }
  async closeSource(source: SourceConfig) { this.closedSources.push(source.id); }
  async close() {}
  async startRecording(id: string, device: DeviceConfig, _source: SourceConfig, file: string): Promise<RecordingHandle> {
    await writeFile(file, "recording fixture");
    let finish!: (reason: string | undefined) => void;
    const ended = new Promise<string | undefined>((resolve) => { finish = resolve; });
    return {
      id, deviceId: device.id, path: file, startedAt: Date.now(), startedMono: performance.now(), ended,
      stop: async () => { finish(undefined); return { duration: 1, bytes: 17 }; },
    };
  }
}
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-card-operations-"));
  const adapters = new CardAdapters(), capture = new CardCapture(adapters);
  const deck = new DeckService(directory, undefined, adapters, capture, new LocalDevelopmentLicense());
  await deck.init();
  const config = validateConfig({
    ...deck.config.config,
    settings: { ...deck.config.config.settings, folder: path.join(directory, "captures") },
    sources: cards,
    devices: [
      { id: "one", name: "One", platform: "Android", kind: "physical", connection: { type: "adb", serial: "one" }, captureSourceId: cards[0].id },
      { id: "two", name: "Two", platform: "Other", kind: "physical", connection: { type: "capture" }, captureSourceId: cards[1].id },
    ],
  });
  await deck.execute("config.save", { config, revision: deck.config.revision });
  capture.closedSources = [];
  return { deck, adapters, capture, cleanup: async () => { await deck.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("deleted capture cards remain suppressed across cached discovery failures and config reloads", async () => {
  const { deck, adapters, capture, cleanup } = await setup();
  try {
    await deck.previewSource(cards[0].id);
    await deck.execute("config.save", { config: deleteCaptureCards(deck.config.config, [cards[0]]), revision: deck.config.revision });
    assert.ok(capture.closedSources.includes(cards[0].id), "saving deletion closes its idle preview worker");
    for (const error of [null, "Cached USB observation after timeout"]) {
      adapters.error = error;
      const result = await deck.execute("capture-cards.list", { refresh: true }) as Awaited<ReturnType<CardAdapters["captureCards"]>>;
      assert.deepEqual(result.sources.map((card) => card.uniqueId), ["usb-two"]);
      assert.equal(result.observation.error, error);
      assert.deepEqual(result.diagnostics, error ? [error] : []);
    }
    assert.equal(adapters.calls, 2, "filtering does not add discovery work");
    const persisted = new ConfigStore(deck.config.file);
    await persisted.load();
    assert.deepEqual(persisted.config.ignoredCaptureCardIds, ["usb-one"]);
    assert.equal(persisted.config.devices[0].captureSourceId, null);
    await assert.rejects(deck.previewSource(cards[0].id), /Register this USB capture card/);
  } finally { await cleanup(); }
});

test("discovery finishing after deletion cannot resurrect the removed card", async () => {
  const { deck, adapters, cleanup } = await setup();
  try {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    adapters.pause = () => new Promise<void>((resolve) => { finish = resolve; entered(); });
    const listing = deck.execute("capture-cards.list", {});
    await started;
    await deck.execute("config.save", { config: deleteCaptureCards(deck.config.config, [cards[0]]), revision: deck.config.revision });
    finish();
    const result = await listing as Awaited<ReturnType<CardAdapters["captureCards"]>>;
    assert.deepEqual(result.sources.map((card) => card.id), [cards[1].id]);
  } finally { await cleanup(); }
});

test("bulk card edits reject active sessions and recordings atomically, while completed capture history survives deletion", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    const { session, leaseToken } = deck.store.reserve("two", cards[1].id, "usb:usb-two", "Fixture", "Card test", 15);
    const config = structuredClone(deck.config.config), revision = deck.config.revision;
    const disk = await readFile(deck.config.file, "utf8");
    const deletion = deleteCaptureCards(config, cards);
    const swap = assignCaptureCards(config, [{ card: cards[0], deviceId: "two" }, { card: cards[1], deviceId: "one" }]);
    for (const next of [deletion, swap])
      await assert.rejects(deck.execute("config.save", { config: next, revision }), /Release the affected session/);
    assert.deepEqual(deck.config.config, config);
    assert.equal(await readFile(deck.config.file, "utf8"), disk);
    assert.equal(capture.closedSources.length, 0, "rejected atomic operations do not close unaffected previews");
    await deck.execute("recordings.start", { sessionId: session.id, leaseToken, mode: "clean" });
    await assert.rejects(deck.execute("config.save", { config: deletion, revision }), /Release the affected session/);
    assert.equal(deck.store.artifacts()[0].status, "recording");
    await deck.execute("recordings.stop", { sessionId: session.id, leaseToken });
    await deck.execute("sessions.release", { sessionId: session.id, leaseToken });
    const artifact = structuredClone(deck.store.artifacts()[0]);
    const history = structuredClone(deck.store.sessions());
    const events = deck.store.events();
    await deck.execute("config.save", { config: deletion, revision });
    assert.equal(deck.config.config.sources.length, 0);
    assert.deepEqual(deck.config.config.devices.map((device) => device.id), ["one"]);
    assert.deepEqual(deck.store.artifacts(), [artifact]);
    assert.deepEqual(deck.store.sessions(), history);
    assert.ok(events.every((event) => deck.store.events().some((current) => current.id === event.id)));
    assert.equal(await readFile(artifact.path, "utf8"), "recording fixture");
    assert.ok((await readFile(artifact.logPath, "utf8")).includes(artifact.id));
  } finally { await cleanup(); }
});

test("a stale revision rejects bulk deletion before closing previews or saving a partial change", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    const revision = deck.config.revision, deletion = deleteCaptureCards(deck.config.config, cards);
    const updated = structuredClone(deck.config.config);
    updated.settings.owner = "Changed elsewhere";
    await deck.execute("config.save", { config: updated, revision });
    capture.closedSources = [];
    const disk = await readFile(deck.config.file, "utf8");
    await assert.rejects(deck.execute("config.save", { config: deletion, revision }), /Configuration changed on disk/);
    assert.deepEqual(deck.config.config, updated);
    assert.equal(await readFile(deck.config.file, "utf8"), disk);
    assert.equal(capture.closedSources.length, 0);
  } finally { await cleanup(); }
});
