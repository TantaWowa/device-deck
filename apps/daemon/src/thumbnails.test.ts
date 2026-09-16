import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaptureThumbnails } from "./local/thumbnails";
import { available, run } from "../../../packages/adapters/src/process";
import type { Artifact } from "../../../packages/core/src/local/types";

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
const capacity = { concurrency: 2, queued: 24, entries: 128, bytes: 16 * 1024 * 1024, thumbnailBytes: 512 * 1024 };
async function fixture(execute: typeof run, custom = capacity) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-thumbnails-"));
  const artifacts = new Map<string, Artifact>();
  for (const id of ["a", "b", "c", "d"]) {
    const file = path.join(directory, `${id}.png`);
    await writeFile(file, `source ${id}`);
    artifacts.set(id, { id, path: file, logPath: `${file}.json`, name: id, deviceId: "qa", sessionId: "qa", sourceId: "qa", owner: "QA", kind: "screenshot", mode: "clean", tags: [], createdAt: 1, duration: 0, bytes: 8, status: "completed", origin: "API" });
  }
  const thumbnails = new CaptureThumbnails((id) => {
    const artifact = artifacts.get(id); assert(artifact); return artifact;
  }, () => "/configured/ffmpeg", execute, custom);
  return { directory, artifacts, thumbnails, async close() { await thumbnails.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function eventually(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(condition(), "Expected asynchronous worker state was reached");
}

test("thumbnail generation deduplicates requests, bounds concurrency and queue admission, and reuses cached bytes", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let active = 0, peak = 0, calls = 0;
  const f = await fixture(async (command, args, timeout) => {
    assert.equal(command, "/configured/ffmpeg");
    assert.equal(timeout, 10_000);
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
    assert.equal(args.at(-1), "pipe:1");
    active++; calls++; peak = Math.max(active, peak);
    await gate; active--;
    return { stdout: jpeg, stderr: "" };
  }, { ...capacity, queued: 1 });
  try {
    const first = f.thumbnails.get("a"), duplicate = f.thumbnails.get("a");
    const second = f.thumbnails.get("b");
    await eventually(() => calls === 2);
    const queued = f.thumbnails.get("c");
    // Wait for the asynchronous file identity check before testing queue capacity.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await assert.rejects(f.thumbnails.get("d"), /generation is busy/);
    finish();
    const data = await Promise.all([first, duplicate, second, queued]);
    assert(data.every((value) => value.equals(jpeg)));
    assert.equal(calls, 3); assert.equal(peak, 2);
    assert.equal(await f.thumbnails.get("a"), data[0]);
    assert.equal(calls, 3);
  } finally { finish(); await f.close(); }
});

test("thumbnail cache is bounded by bytes and entries and regenerates when source files change", async () => {
  for (const bound of [{ entries: 2, bytes: 100 }, { entries: 10, bytes: 16 }]) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return { stdout: jpeg, stderr: "" }; }, { ...capacity, ...bound });
    try {
      await f.thumbnails.get("a"); await f.thumbnails.get("b");
      await f.thumbnails.get("a"); // Recent a survives; b is evicted next.
      await f.thumbnails.get("c"); await f.thumbnails.get("a");
      assert.equal(calls, 3);
      await f.thumbnails.get("b"); assert.equal(calls, 4);
      await writeFile(f.artifacts.get("b")!.path, "replacement with a different size");
      await f.thumbnails.get("b"); assert.equal(calls, 5);
    } finally { await f.close(); }
  }
});

test("trash, purge and active captures are rejected even on cache hits or while an encoder is running", async () => {
  let calls = 0, finish: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const f = await fixture(async () => { calls++; await gate; return { stdout: jpeg, stderr: "" }; });
  try {
    await f.thumbnails.get("a");
    const a = f.artifacts.get("a")!;
    for (const status of ["recording", "finalizing"] as const) {
      a.status = status;
      await assert.rejects(f.thumbnails.get("a"), (error: any) => error.status === 409);
    }
    a.status = "completed"; a.deletedAt = 1;
    await assert.rejects(f.thumbnails.get("a"), (error: any) => error.status === 410);
    a.deletedAt = undefined; a.purgedAt = 1;
    await assert.rejects(f.thumbnails.get("a"), (error: any) => error.status === 410);
    assert.equal(calls, 1);
    a.purgedAt = undefined;
    gate = new Promise((resolve) => { finish = resolve; });
    const pending = f.thumbnails.get("a");
    const rejected = assert.rejects(pending, (error: any) => error.status === 410);
    await eventually(() => calls === 2);
    a.deletedAt = 1; finish!(); await rejected;
    a.deletedAt = undefined; gate = undefined;
    await f.thumbnails.get("a"); assert.equal(calls, 3, "Removed generation is not cached");
  } finally { finish?.(); await f.close(); }
});

test("failed encodes are not cached and shutdown drains work without admitting late results", async () => {
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const f = await fixture(async () => {
    calls++;
    if (calls === 1) return { stdout: Buffer.from("not jpeg"), stderr: "" };
    await gate; return { stdout: jpeg, stderr: "" };
  }, { ...capacity, concurrency: 1 });
  try {
    await assert.rejects(f.thumbnails.get("a"), /valid small JPEG/);
    const active = assert.rejects(f.thumbnails.get("a"), /stopping/);
    await eventually(() => calls === 2);
    const queued = assert.rejects(f.thumbnails.get("b"), /stopping/);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const closing = f.thumbnails.close(); finish();
    await Promise.all([active, queued, closing]);
    assert.equal(calls, 2);
    await assert.rejects(f.thumbnails.get("c"), /stopping/);
  } finally { finish(); await f.close(); }
});

test("real screenshots and MP4 recordings produce decodable JPEG thumbnails within 480 by 270", async (context) => {
  if (!await available("ffmpeg") || !await available("ffprobe")) { context.skip("ffmpeg/ffprobe not installed"); return; }
  const f = await fixture((_, args, timeout) => run("ffmpeg", args, timeout));
  try {
    const screenshot = f.artifacts.get("a")!, recording = f.artifacts.get("b")!;
    recording.kind = "recording"; recording.path = path.join(f.directory, "video.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=1", "-frames:v", "1", screenshot.path]);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=2", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", recording.path]);
    for (const [artifact, dimensions] of [[screenshot, [152, 270]], [recording, [480, 270]]] as const) {
      const data = await f.thumbnails.get(artifact.id), file = path.join(f.directory, `${artifact.id}-proof.jpg`);
      await writeFile(file, data);
      const info = JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_name", "-of", "json", file])).stdout.toString()).streams[0];
      assert.equal(info.codec_name, "mjpeg");
      assert.deepEqual([info.width, info.height], dimensions);
      assert(data.length < 100_000);
    }
  } finally { await f.close(); }
});
