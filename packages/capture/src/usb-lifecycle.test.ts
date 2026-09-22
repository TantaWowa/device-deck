import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Adapters } from "../../adapters/src";
import { validateConfig } from "../../config/src";
import { CaptureEngine } from "./index";

const source = (id = "ready") => ({ id, kind: "usb" as const, name: id, uniqueId: id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "fixture child did not settle");
    await sleep(10);
  }
}
type Event = { event: string; pid: number; id: string };
async function fixture(options: { idleGraceMs?: number; startupTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-usb-lifecycle-"));
  const events = path.join(dir, "events"), helper = path.join(dir, "camera");
  await writeFile(events, "");
  await writeFile(helper, `#!${process.execPath}
const fs = require('fs');
const id = process.argv[3];
const event = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event, pid:process.pid, id})+'\\n');
event('start');
process.stdout.on('error', () => process.exit());
process.on('SIGINT', () => { event('closing'); setTimeout(() => { event('stop'); process.exit(); }, 100); });
if (id === 'denied') { process.stderr.write('Camera permission denied'); process.exit(1); }
setInterval(() => { if (id !== 'slow') process.stdout.write(Buffer.from([255,216,255,217])); }, 20);
`, { mode: 0o700 });
  const config = validateConfig({ schemaVersion: 1, settings: { folder: dir } });
  const adapters = new Adapters(() => config);
  const engine = new CaptureEngine(adapters, helper, { idleGraceMs: 100, startupTimeoutMs: 5000, ...options });
  return {
    adapters, engine, config, dir,
    events: async (): Promise<Event[]> => (await readFile(events, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    async close() { await engine.close(); await adapters.cameras.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("snapshot-only USB workers share their grace and stop without engine teardown", async () => {
  const f = await fixture({ idleGraceMs: 150 });
  try {
    await f.engine.preview(null, source(), 0);
    await sleep(60);
    await f.engine.preview(null, source(), 0);
    const started = (await f.events()).filter((event) => event.event === "start");
    assert.equal(started.length, 1);
    assert.ok(alive(started[0].pid));
    await until(async () => !alive(started[0].pid));
    assert.equal((await f.events()).filter((event) => event.event === "stop").length, 1);
  } finally { await f.close(); }
});

test("one-shot card thumbnails close their unused worker before returning", async () => {
  const f = await fixture({ idleGraceMs: 60_000 });
  try {
    await f.engine.preview(null, source(), 30_000, true);
    const events = await f.events();
    assert.deepEqual(events.map((event) => event.event), ["start", "closing", "stop"]);
    assert.equal(alive(events[0].pid), false);
    await f.engine.preview(null, source(), 30_000, true);
    assert.equal((await f.events()).length, 3, "a cached frame does not reopen the camera");
  } finally { await f.close(); }
});

test("a retain after idle close starts waits for the old child to exit", async () => {
  const f = await fixture({ idleGraceMs: 30 });
  try {
    await f.engine.preview(null, source(), 0);
    await until(async () => (await f.events()).some((event) => event.event === "closing"));
    await Promise.all([f.engine.preview(null, source(), 0), f.engine.preview(null, source(), 0)]);
    const events = await f.events();
    assert.deepEqual(events.slice(0, 4).map((event) => event.event), ["start", "closing", "stop", "start"]);
    assert.equal(events.filter((event) => event.event === "start").length, 2);
  } finally { await f.close(); }
});

test("permission failure and startup timeout leave no USB child before returning", async () => {
  const f = await fixture({ startupTimeoutMs: 2000 });
  try {
    for (const id of ["denied", "slow"]) {
      await assert.rejects(f.engine.preview(null, source(id), 0), /permission|did not produce/i);
      const starts = (await f.events()).filter((event) => event.event === "start" && event.id === id);
      assert.equal(starts.length, 1);
      assert.equal(alive(starts[0].pid), false);
    }
  } finally { await f.close(); }
});

test("closing queued USB startup cancels it without spawning behind another initialization", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = f.adapters.cameras.initialize(() => new Promise<void>((resolve) => { release = resolve; }));
  await until(async () => Boolean(release));
  try {
    const preview = f.engine.preview(null, source(), 0);
    const rejected = assert.rejects(preview);
    await f.engine.closeSource(source());
    await rejected;
    release();
    await gate;
    assert.equal((await f.events()).length, 0);
  } finally { release(); await gate; await f.close(); }
});

test("failed USB startup releases initialization only after its child exits", async () => {
  const f = await fixture({ startupTimeoutMs: 2000 });
  try {
    const failure = assert.rejects(f.engine.preview(null, source("slow"), 0));
    await until(async () => (await f.events()).some((event) => event.id === "slow"));
    await f.engine.preview(null, source(), 0);
    await failure;
    const events = await f.events();
    assert.ok(events.findIndex((event) => event.id === "slow" && event.event === "stop") < events.findIndex((event) => event.id === "ready" && event.event === "start"));
  } finally { await f.close(); }
});

test("recorder startup failure also closes its unused USB worker immediately", async () => {
  const f = await fixture({ idleGraceMs: 60_000 });
  try {
    const encoder = path.join(f.dir, "failed-encoder");
    await writeFile(encoder, `#!${process.execPath}\nprocess.stderr.write('Fixture encoder unavailable');process.exit(1);\n`, { mode: 0o700 });
    f.config.tools.ffmpeg = encoder;
    await assert.rejects(f.engine.startRecording("recording", {
      id: "fixture", name: "Fixture", kind: "physical", platform: "Other", model: "Fixture", visibility: "local",
      connection: { type: "capture" }, captureSourceId: "ready",
    }, source(), path.join(f.dir, "recording.mp4"), 1), /encoder unavailable/);
    const starts = (await f.events()).filter((event) => event.event === "start");
    assert.equal(starts.length, 1);
    assert.equal(alive(starts[0].pid), false);
  } finally { await f.close(); }
});
