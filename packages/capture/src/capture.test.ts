import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CaptureEngine } from "./index";
import { Adapters } from "../../adapters/src";
import { available, run, start, ready, stop } from "../../adapters/src/process";
import { validateConfig } from "../../config/src";
import type { DeviceConfig } from "../../core/src/local/types";
test("process stdout retains an Android PID emitted before readiness completes", async () => {
  const handle = start(process.execPath, [
    "-e",
    'process.stdout.write("DEVICE_DECK_PID:123\\n");setInterval(()=>{},1000)',
  ]);
  try {
    await ready(handle);
    assert.match(handle.output(), /DEVICE_DECK_PID:123/);
  } finally {
    await stop(handle);
  }
});
test("recording validation rejects audio and annotation strips it from historical input", async (t) => {
  if (!(await available("ffmpeg")) || !(await available("ffprobe"))) return t.skip("ffmpeg/ffprobe required");
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-video-only-"));
  const input = path.join(dir, "with-audio.mp4"), output = path.join(dir, "annotated.mp4");
  const config = validateConfig({ schemaVersion: 1, settings: { folder: dir } });
  const engine = new CaptureEngine(new Adapters(() => config));
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=15",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.4", "-c:v", "libx264", "-c:a", "aac", input]);
    await assert.rejects(engine.probe(input), /requires video-only/);
    await engine.annotate(input, output, [], "Fixture", "fixture-session", "recording");
    assert.ok((await engine.probe(output)).bytes > 0);
    const streams = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output])).stdout.toString()).streams;
    assert.deepEqual(streams.map((stream: { codec_type: string }) => stream.codec_type), ["video"]);
  } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
});
test("independent USB recorder streams coexist; source exit ends encoder and remains interrupted", async (t) => {
  if (!(await available("ffmpeg")) || !(await available("ffprobe"))) {
    t.skip("ffmpeg/ffprobe required for real encoder fixture");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-capture-"));
  const frame = path.join(dir, "frame.jpg"),
    helper = path.join(dir, "camera");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64",
    "-frames:v",
    "1",
    frame,
  ]);
  await writeFile(
    helper,
    `#!${process.execPath}\nconst fs=require('fs'),path=require('path');const frame=fs.readFileSync(${JSON.stringify(frame)});const marker=path.join(${JSON.stringify(dir)},'disconnect-'+process.argv[3]);process.stdout.on('error',()=>process.exit(0));setInterval(()=>{if(fs.existsSync(marker))process.exit(1);process.stdout.write(frame);},65);\n`,
    { mode: 0o700 },
  );
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: dir },
  });
  const engine = new CaptureEngine(new Adapters(() => config), helper);
  const device = (id: string): DeviceConfig => ({
    id,
    name: id,
    platform: "Roku",
    kind: "physical",
    model: "test fixture",
    visibility: "local",
    connection: { type: "roku", host: "192.0.2.1", serial: id },
    captureSourceId: id,
  });
  const source = (id: string) => ({
    id,
    name: id,
    kind: "usb" as const,
    uniqueId: id,
  });
  let one: Awaited<ReturnType<typeof engine.startRecording>> | undefined,
    two: typeof one;
  try {
    one = await engine.startRecording(
      "a",
      device("a"),
      source("a"),
      path.join(dir, "a.mp4"),
      1,
    );
    two = await engine.startRecording(
      "b",
      device("b"),
      source("b"),
      path.join(dir, "b.mp4"),
      1,
    );
    assert.notEqual(one.pid, two.pid);
    await engine.preview(device("a"), source("a"));
    await writeFile(path.join(dir, "disconnect-a"), "disconnect");
    const reason = await one.ended;
    assert.match(reason!, /disconnected/);
    const partial = await one.stop();
    assert.ok(partial.interruption);
    assert.ok(partial.duration > 0);
    let secondEnded = false;
    void two.ended.then(() => (secondEnded = true));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(secondEnded, false);
    const completed = await two.stop();
    assert.equal(completed.interruption, undefined);
    assert.ok(completed.duration > 0);
    assert.ok(completed.bytes > 0);
  } finally {
    await Promise.allSettled([one?.stop(), two?.stop()]);
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
