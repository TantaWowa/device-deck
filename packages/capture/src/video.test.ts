import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { CaptureEngine } from "./index";
import { Adapters } from "../../adapters/src";
import { available, run } from "../../adapters/src/process";
import { validateConfig } from "../../config/src";
import type { H264Frame, LiveVideoSource } from "../../core/src/live";
import { h264Nals } from "./h264";
import { encodeLiveImages } from "./video";

function keyframe(source: LiveVideoSource, afterTimestamp = -1n) {
  return videoFrames(source, 1, afterTimestamp).then(([frame]) => frame);
}

function videoFrames(source: LiveVideoSource, count: number, afterTimestamp = -1n) {
  return new Promise<H264Frame[]>((resolve, reject) => {
    const frames: H264Frame[] = [];
    let off = () => {}, closed = () => {}, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); off(); closed();
      if (error) reject(error); else resolve(frames);
    };
    const timer = setTimeout(() => finish(new Error("Not enough live frames received")), 8000);
    off = source.onFrame((frame) => {
      if (settled || frame.timestampUs <= afterTimestamp || !frames.length && !frame.keyframe) return;
      frames.push(frame);
      if (frames.length < count) return;
      finish();
    });
    if (settled) { off(); return; }
    closed = source.onClose((reason) => finish(new Error(reason)));
    if (settled) closed();
  });
}

test("successive PNG screenshots retain their colours, as do USB JPEG frames", async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the real encoder fixture");
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-live-colours-"));
  const width = 96, height = 64, patchWidth = 24;
  // Partial channel values expose erroneous accumulation between PNG frames;
  // saturated red/green/blue alone can wrap almost invisibly from 255 to 254.
  const colours = [[176, 48, 32], [40, 168, 56], [32, 72, 184], [96, 112, 128]];
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set(colours[Math.floor(x / patchWidth)], (y * width + x) * 3);
  }
  const ppm = path.join(dir, "colours.ppm");
  await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  try {
    for (const format of ["rgb24", "rgba", "jpeg"]) await t.test(format, async () => {
      const image = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", ppm,
        "-frames:v", "1", "-pix_fmt", format === "jpeg" ? "yuvj420p" : format,
        "-c:v", format === "jpeg" ? "mjpeg" : "png", "-f", "image2pipe", "pipe:1"])).stdout;
      const events = new EventEmitter();
      const timer = setInterval(() => events.emit("frame", image), 200);
      let live: LiveVideoSource | undefined;
      try {
        live = await encodeLiveImages("ffmpeg", {
          first: image, fps: 5,
          onFrame: (listener) => { events.on("frame", listener); return () => { events.off("frame", listener); }; },
          onClose: (listener) => { events.on("closed", listener); return () => { events.off("closed", listener); }; },
          close: async () => { clearInterval(timer); },
        }, "high");
        const frames = await videoFrames(live, 4);
        const encoded = path.join(dir, `${format}.h264`);
        await writeFile(encoded, Buffer.concat(frames.map((frame) => frame.data)));
        const decoded = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", encoded,
          "-frames:v", String(frames.length), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])).stdout;
        const frameBytes = width * height * 3;
        assert.equal(decoded.length, frames.length * frameBytes);
        for (let frame = 0; frame < frames.length; frame++) colours.forEach((expected, patch) => {
          const offset = frame * frameBytes + (Math.floor(height / 2) * width + patch * patchWidth + patchWidth / 2) * 3;
          const actual = [...decoded.subarray(offset, offset + 3)];
          assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 12),
            `${format} frame ${frame}, patch ${patch}: expected ${expected}, got ${actual}`);
        });
      } finally { clearInterval(timer); await live?.close(); }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("shared USB live encoders provide a decodable first IDR, preserve snapshots, and release the last viewer", async (t) => {
  if (!(await available("ffmpeg")) || !(await available("ffprobe"))) return t.skip("ffmpeg/ffprobe required for the real encoder fixture");
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-live-"));
  const jpeg = path.join(dir, "frame.jpg"), helper = path.join(dir, "camera");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", jpeg]);
  await writeFile(helper, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(dir, "starts"))},'started\\n');const frame=fs.readFileSync(${JSON.stringify(jpeg)});process.stdout.on('error',()=>process.exit(0));setInterval(()=>process.stdout.write(frame),65);\n`, { mode: 0o700 });
  const config = validateConfig({ schemaVersion: 1, settings: { folder: dir } });
  const engine = new CaptureEngine(new Adapters(() => config), helper);
  const source = { id: "fixture", kind: "usb" as const, name: "Fixture", uniqueId: "fixture" };
  let one: LiveVideoSource | undefined, two: LiveVideoSource | undefined;
  let recording: Awaited<ReturnType<typeof engine.startRecording>> | undefined;
  try {
    [one, two] = await Promise.all([engine.live(null, source), engine.live(null, source)]);
    assert.equal(one.width, 64); assert.equal(one.height, 64); assert.equal(one.fps, 15);
    const [a, b] = await Promise.all([keyframe(one), keyframe(two)]);
    assert.equal(a.timestampUs, b.timestampUs);
    assert.deepEqual(a.data, b.data);
    assert.ok(h264Nals(a.data).some((n) => (n[0] & 31) === 7));
    assert.ok(h264Nals(a.data).some((n) => (n[0] & 31) === 8));
    const h264 = path.join(dir, "frame.h264");
    await writeFile(h264, a.data);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", h264, "-frames:v", "1", "-f", "null", "-"]);
    assert.deepEqual(await engine.preview(null, source, 0), await readFile(jpeg));
    assert.equal(await readFile(path.join(dir, "starts"), "utf8"), "started\n");
    recording = await engine.startRecording("live-recording", {
      id: "fixture", name: "Fixture", platform: "Other", kind: "physical",
      model: "Fixture", visibility: "local", connection: { type: "capture" }, captureSourceId: source.id,
    }, source, path.join(dir, "recording.mp4"), 1);
    let recordingEnded = false;
    void recording.ended.then(() => { recordingEnded = true; });
    await one.close();
    const stillLive = await keyframe(two, b.timestampUs);
    assert.ok(stillLive.timestampUs > b.timestampUs);
    await two.close();
    assert.equal(recordingEnded, false, "closing the last live viewer must preserve an active recording");
    const recorded = await recording.stop();
    assert.equal(recorded.interruption, undefined);
    assert.ok(recorded.bytes > 0);
    // Reopening after the final release must create a new capture pipeline.
    one = await engine.live(null, source);
    assert.equal(await readFile(path.join(dir, "starts"), "utf8"), "started\nstarted\n");
    const disconnected = new Promise<string>((resolve) => one!.onClose(resolve));
    await engine.closeSource(source);
    assert.match(await disconnected, /closed/i);
  } finally {
    await Promise.allSettled([one?.close(), two?.close(), recording?.stop()]);
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native PNG screenshot fallback encodes promptly with its actual sampling limit", async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the real encoder fixture");
  const image = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x128", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"])).stdout;
  const events = new EventEmitter();
  let released = 0, live: LiveVideoSource | undefined;
  const timer = setInterval(() => events.emit("frame", image), 500);
  try {
    live = await encodeLiveImages("ffmpeg", {
      first: image, fps: 2,
      onFrame: (listener) => { events.on("frame", listener); return () => { events.off("frame", listener); }; },
      onClose: (listener) => { events.on("closed", listener); return () => { events.off("closed", listener); }; },
      close: async () => { released++; clearInterval(timer); },
    }, "high");
    assert.equal(live.fps, 2); assert.equal(live.width, 64); assert.equal(live.height, 128);
    assert.ok((await keyframe(live)).data.length > 0);
    const rotated = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=128x64", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"])).stdout;
    const ended = new Promise<string>((resolve) => live!.onClose(resolve));
    clearInterval(timer);
    const rotateTimer = setInterval(() => events.emit("frame", rotated), 100);
    try { assert.match(await ended, /dimensions changed/); }
    finally { clearInterval(rotateTimer); }
    await live.close(); await live.close();
    assert.equal(released, 1);
    assert.equal(events.listenerCount("frame"), 0);
  } finally { clearInterval(timer); await live?.close(); }
});

test("PNG startup needs only its first screenshot and stops repeating once ready", { timeout: 20000 }, async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the real encoder fixture");
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-live-cold-"));
  const png = async (colour: string) => (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=64x128`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"])).stdout;
  const first = await png("red"), next = await png("blue"), events = new EventEmitter();
  let live: LiveVideoSource | undefined, timer: ReturnType<typeof setInterval> | undefined, released = 0;
  try {
    // No subsequent capture is available until startup completes. A slow native
    // screenshot must not be mistaken for a stalled encoder after five seconds.
    live = await encodeLiveImages("ffmpeg", {
      first, fps: 2,
      onFrame: (listener) => { events.on("frame", listener); return () => { events.off("frame", listener); }; },
      onClose: (listener) => { events.on("closed", listener); return () => { events.off("closed", listener); }; },
      close: async () => { released++; clearInterval(timer); },
    }, "balanced");
    assert.equal(live.fps, 2);
    const bootstrap: H264Frame[] = [];
    live.onFrame((frame) => bootstrap.push(frame))();
    assert.ok(bootstrap.some((frame) => frame.keyframe), "late viewers receive the initial IDR without another capture");
    const initial = path.join(dir, "initial.h264");
    await writeFile(initial, Buffer.concat(bootstrap.map((frame) => frame.data)));
    const initialPixels = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", initial, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])).stdout;
    const initialColour = [...initialPixels.subarray(0, 3)];
    assert.ok(initialColour[0] > 240 && initialColour[1] < 12 && initialColour[2] < 12, `initial screenshot should decode red, got ${initialColour}`);
    let frames = 0;
    const detach = live.onFrame(() => { frames++; });
    // Let already buffered output settle, then ensure priming is not an ongoing
    // synthetic video source while fresh screenshots remain unavailable.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const settledFrames = frames;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(frames, settledFrames, "startup repetition must stop when the encoder is ready");
    detach();
    const received = videoFrames(live, 6);
    timer = setInterval(() => events.emit("frame", next), 500);
    const encoded = path.join(dir, "continued.h264");
    await writeFile(encoded, Buffer.concat((await received).map((frame) => frame.data)));
    const decoded = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", encoded, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])).stdout;
    const colour = [...decoded.subarray(decoded.length - 3)];
    assert.ok(colour[0] < 12 && colour[1] < 12 && colour[2] > 240, `fresh screenshot should replace initial red frame, got ${colour}`);
    await live.close();
    assert.equal(released, 1);
    assert.equal(events.listenerCount("frame"), 0);
  } finally { clearInterval(timer); await live?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a PNG source closing during startup cannot be revived by cached frames", { timeout: 10000 }, async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the real encoder fixture");
  const first = (await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x128", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"])).stdout;
  const events = new EventEmitter();
  let released = 0, live: LiveVideoSource | undefined;
  const timer = setTimeout(() => events.emit("closed", "Native capture disconnected"), 100);
  try {
    await assert.rejects(async () => {
      live = await encodeLiveImages("ffmpeg", {
        first, fps: 2,
        onFrame: (listener) => { events.on("frame", listener); return () => { events.off("frame", listener); }; },
        onClose: (listener) => { events.on("closed", listener); return () => { events.off("closed", listener); }; },
        close: async () => { released++; },
      }, "balanced");
    }, /Native capture disconnected/);
    assert.equal(released, 1);
    assert.equal(events.listenerCount("frame"), 0);
    assert.equal(events.listenerCount("closed"), 0);
  } finally { clearTimeout(timer); await live?.close(); }
});
