import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceConfig } from "../../core/src/local/types";
import { videoProfiles, type H264Frame, type LiveVideoSource, type VideoProfile } from "../../core/src/live";
import { available, run } from "../../adapters/src/process";
import { h264Nals } from "./h264";
import { h264Size, startIosSimulatorVideo } from "./ios-video";

const udid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const device: DeviceConfig = {
  id: "ios-fixture", name: "iOS fixture", platform: "Apple", kind: "virtual", model: "iPhone",
  visibility: "local", connection: { type: "simulator", os: "ios", udid }, captureSourceId: null,
};
const description = { udid, target_type: "simulator", state: "Booted", screen_dimensions: { width: 720, height: 1280 } };
const describe = (target = description): typeof run => async () => ({ stdout: Buffer.from(JSON.stringify(target)), stderr: "" });

async function fixture(mode = "stream") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-native-ios-"));
  const helper = path.join(dir, "idb"), audit = path.join(dir, "audit.jsonl");
  await writeFile(helper, `#!${process.execPath}
const fs = require('fs'), {spawn} = require('child_process');
const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1];
const record=value=>fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify(value)+'\\n');
record({event:'start',pid:process.pid,args,unbuffered:process.env.PYTHONUNBUFFERED});
if(args[0]!=='video-stream') throw new Error('Only native video-stream is permitted');
const factor=Number(value('--scale-factor')), fps=Number(value('--fps'));
let child, timer;
function stream(rotated=false) {
 const width=Math.floor((rotated?1280:720)*factor/2)*2, height=Math.floor((rotated?720:1280)*factor/2)*2;
 child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc2=s='+width+'x'+height+':r='+fps,
 '-an','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-profile:v','high','-level:v','3.1',
 '-g',String(fps),'-x264-params','repeat-headers=1:scenecut=0','-f','h264','pipe:1']);
 record({event:'encoder',pid:child.pid}); child.stdout.pipe(process.stdout,{end:false}); child.stderr.resume();
 child.once('close',()=>{record({event:'encoder-stopped',pid:child.pid});});
}
const mode=${JSON.stringify(mode)};
if(mode!=='silent')stream();
if(mode==='rotate') timer=setTimeout(()=>{const old=child;old.once('close',()=>stream(true));old.kill('SIGTERM');},1400);
let closing=false;
function stop(){if(closing)return;closing=true;clearTimeout(timer);if(child){child.once('close',()=>process.exit());child.kill('SIGTERM');}else process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.stdout.on('error',stop);
setInterval(()=>{},1000);
`, { mode: 0o700 });
  return { dir, helper, audit, remove: () => rm(dir, { recursive: true, force: true }) };
}

function frames(source: LiveVideoSource, count: number) {
  return new Promise<H264Frame[]>((resolve, reject) => {
    const result: H264Frame[] = [];
    let off = () => {}, closed = () => {}, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); off(); closed();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error("Native video fixture stalled")), 5000);
    off = source.onFrame((frame) => {
      if (settled || frame.timestampUs === 0n || !result.length && !frame.keyframe) return;
      result.push(frame);
      if (result.length === count) finish();
    });
    if (settled) { off(); return; }
    closed = source.onClose((reason) => finish(new Error(reason)));
  });
}

async function assertStopped(audit: string) {
  const events = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const event of events.filter((entry) => ["start", "encoder"].includes(entry.event)))
    assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" }, `owned ${event.event} process ${event.pid} must stop`);
  return events;
}

test("native iOS video rejects wrong targets, offline simulators and missing helpers before capture", async () => {
  const launch = (target = description) => startIosSimulatorVideo(device, "fixture-idb", "ffmpeg", "balanced", describe(target), async () => true);
  await assert.rejects(launch({ ...description, udid: "wrong" }), /different simulator identity/);
  await assert.rejects(launch({ ...description, target_type: "device" }), /different simulator identity/);
  await assert.rejects(launch({ ...description, state: "Shutdown" }), /Boot the iOS simulator/);
  await assert.rejects(launch({ ...description, screen_dimensions: { width: 0, height: 1280 } }), /screen dimensions/);
  await assert.rejects(startIosSimulatorVideo(device, "idb", "ffmpeg", "balanced", describe(), async () => false), /idb, idb_companion and ffmpeg/);
  await assert.rejects(startIosSimulatorVideo({ ...device, connection: { type: "simulator", os: "tvos", udid } }, "idb", "ffmpeg", "balanced"), /requires an iOS simulator/);
});

test("native iOS H264 stays live at each quality profile and supplies decodable GOPs to late viewers", { timeout: 30000 }, async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the real native video fixture");
  for (const profile of ["low", "balanced", "high"] satisfies VideoProfile[]) await t.test(profile, async () => {
    const f = await fixture();
    let source: LiveVideoSource | undefined;
    try {
      source = await startIosSimulatorVideo(device, f.helper, "ffmpeg", profile, describe(), async () => true);
      const settings = videoProfiles[profile];
      assert.equal(source.fps, settings.fps);
      assert.equal(source.width, profile === "low" ? 360 : 720);
      assert.equal(source.height, settings.width);
      const initial = await frames(source, 4);
      for (let i = 1; i < initial.length; i++) {
        const interval = Number(initial[i].timestampUs - initial[i - 1].timestampUs);
        assert.ok(Math.abs(interval - 1_000_000 / settings.fps) < 2);
      }
      const sps = h264Nals(initial[0].data).find((nal) => (nal[0] & 31) === 7)!;
      assert.equal(sps[1], 66, "High-profile native input must normalize to browser Baseline");
      assert.equal(sps[3], 31);
      assert.deepEqual(h264Size(sps), { width: source.width, height: source.height });
      const late: H264Frame[] = [];
      source.onFrame((frame) => late.push(frame))();
      assert.ok(late.filter((frame) => frame.timestampUs > 0n).length >= 4, "late viewer receives the complete current GOP");
      const file = path.join(f.dir, "late.h264");
      await writeFile(file, Buffer.concat(late.map((frame) => frame.data)));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"]);
      await source.close(); await source.close();
      const audit = await assertStopped(f.audit);
      const command = audit.find((entry) => entry.event === "start");
      assert.equal(command.unbuffered, "1", "Python stdout buffering must not add seconds of latency");
      assert.deepEqual(command.args.slice(0, 5), ["video-stream", "--format", "h264", "--fps", String(settings.fps)]);
      assert.equal(command.args.at(-1), udid);
    } finally { await source?.close(); await f.remove(); }
  });
});

test("native simulator rotation closes the stream rather than silently stretching new geometry", { timeout: 15000 }, async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the native video fixture");
  const f = await fixture("rotate");
  let source: LiveVideoSource | undefined;
  try {
    source = await startIosSimulatorVideo(device, f.helper, "ffmpeg", "low", describe(), async () => true);
    const reason = await new Promise<string>((resolve) => source!.onClose(resolve));
    assert.match(reason, /dimensions changed.*Reconnect/);
    await source.close();
    await assertStopped(f.audit);
  } finally { await source?.close(); await f.remove(); }
});

test("native encoder startup failure releases its capture process", { timeout: 15000 }, async () => {
  const f = await fixture("silent");
  try {
    const failedEncoder = path.join(f.dir, "failed-encoder");
    await writeFile(failedEncoder, `#!${process.execPath}\nsetTimeout(()=>process.exit(1),100);\n`, { mode: 0o700 });
    await assert.rejects(startIosSimulatorVideo(device, f.helper, failedEncoder, "low", describe(), async () => true), /encoder stopped/);
    // A fast failed encoder can stop idb before its script executes at all.
    const exists = await readFile(f.audit).then(() => true, () => false);
    if (exists) await assertStopped(f.audit);
  } finally { await f.remove(); }
});

test("native capture startup timeout cleans up both waiting processes", { timeout: 15000 }, async (t) => {
  if (!(await available("ffmpeg"))) return t.skip("ffmpeg required for the native video fixture");
  const f = await fixture("silent");
  try {
    await assert.rejects(startIosSimulatorVideo(device, f.helper, "ffmpeg", "low", describe(), async () => true), /did not produce a keyframe within 10 seconds/);
    await assertStopped(f.audit);
  } finally { await f.remove(); }
});

test("H264 geometry rejects malformed or unbounded parameter sets", () => {
  assert.throws(() => h264Size(Buffer.from([0x68, 0xff])), /Expected/);
  assert.throws(() => h264Size(Buffer.from([0x67, 66, 0, 31])), /Truncated/);
  assert.throws(() => h264Size(Buffer.from([0x67, 66, 0, 31, 0, 0, 0, 0])), /Invalid/);
});
