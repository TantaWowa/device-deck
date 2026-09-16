// node --import tsx scripts/qa-ios-native-video.mjs
// Defaults to an isolated H.264-producing idb fixture. To inspect an already
// booted, unreserved simulator without sending input, set QA_IOS_NATIVE_UDID.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { Adapters } from "../packages/adapters/src/index.ts";
import { startIdbInteractive } from "../packages/adapters/src/interactive.ts";
import { CaptureEngine } from "../packages/capture/src/index.ts";
import { LiveStreams } from "../apps/daemon/src/live.ts";
import { run } from "../packages/adapters/src/process.ts";

const realUdid = process.env.QA_IOS_NATIVE_UDID;
const output = path.resolve(process.env.QA_IOS_NATIVE_OUTPUT || `outputs/ios-native-video-${realUdid ? "actual" : "synthetic"}`);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "deck-ios-video-qa-"));
const auditFile = path.join(temporary, "commands.jsonl");
const ffmpeg = (await run("/usr/bin/which", [process.env.QA_FFMPEG || "ffmpeg"])).stdout.toString().trim();
const idb = realUdid ? (await run("/usr/bin/which", [process.env.QA_IDB || "idb"])).stdout.toString().trim() : undefined;
const udid = realUdid || "11111111-2222-3333-4444-555555555555";

async function assertUnreservedSimulator() {
  const booted = JSON.parse((await run("xcrun", ["simctl", "list", "devices", "booted", "--json"])).stdout.toString());
  assert.ok(Object.values(booted.devices).flat().some((d) => d.udid === udid && d.state === "Booted"), "Actual QA never boots a simulator.");
  const endpoint = JSON.parse(await readFile("work/local-deck/endpoint.json", "utf8"));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/operations/inventory`, {
    method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200, "Read-only reservation preflight must succeed.");
  const inventory = await response.json();
  const target = inventory.devices.find((d) => d.connection.type === "simulator" && d.connection.udid === udid);
  assert.ok(target, "Actual QA requires a simulator already known to the live deck.");
  assert.ok(!inventory.sessions.some((s) => s.deviceId === target.id && s.state !== "closed"), "Do not inspect a reserved simulator.");
  assert.ok(!inventory.artifacts.some((a) => a.deviceId === target.id && ["recording", "finalizing"].includes(a.status)), "Do not inspect a recording simulator.");
}
if (realUdid) await assertUnreservedSimulator();

// Audit both native input and its H.264 normalizer. Real mode refuses every idb
// operation except read-only describe/video-stream, even if capture regresses.
async function wrapper(name, executable) {
  const file = path.join(temporary, name);
  await writeFile(file, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2), kind = ${JSON.stringify(name)};
const audit = (data) => appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ at: Date.now(), kind, pid: process.pid, ...data }) + '\\n');
audit({ type: 'start', args });
const real = ${JSON.stringify(Boolean(realUdid))};
if (kind === 'idb' && real && !['describe', 'video-stream'].includes(args[0])) { audit({ type: 'refused' }); process.exit(91); }
if (kind === 'idb' && !real && args[0] === 'describe') {
  process.stdout.write(JSON.stringify({ udid: ${JSON.stringify(udid)}, state: 'Booted', target_type: 'simulator', screen_dimensions: { width: 960, height: 540, width_points: 480, height_points: 270 } }));
  audit({ type: 'exit', code: 0 }); process.exit(0);
}
if (kind === 'idb' && !real && args[0] === 'ui') { audit({ type: 'gesture', args }); audit({ type: 'exit', code: 0 }); process.exit(0); }
let command = ${JSON.stringify(executable)}, childArgs = args;
if (kind === 'idb' && !real) {
  if (args[0] !== 'video-stream' || args[args.indexOf('--format') + 1] !== 'h264') process.exit(92);
  const fps = Number(args[args.indexOf('--fps') + 1]);
  const scale = args.includes('--scale-factor') ? Number(args[args.indexOf('--scale-factor') + 1]) : 1;
  const width = Math.floor(960 * scale / 2) * 2, height = Math.floor(540 * scale / 2) * 2;
  command = ${JSON.stringify(ffmpeg)};
  childArgs = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=' + width + 'x' + height + ':rate=' + fps + ',drawbox=x=iw*0.02:y=ih*0.02:w=iw*0.1:h=ih*0.2:color=red:t=fill', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', String(fps), '-x264-params', 'aud=1:repeat-headers=1:scenecut=0', '-f', 'h264', 'pipe:1'];
}
const child = spawn(command, childArgs, { stdio: 'inherit' });
audit({ type: 'child', childPid: child.pid, command, args: childArgs });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { audit({ type: 'error', message: error.message }); process.exitCode = 1; });
child.on('exit', (code, signal) => { audit({ type: 'exit', code, signal }); process.exitCode = code || 0; });
`, { mode: 0o700 });
  return file;
}
const tools = { idb: await wrapper("idb", idb), ffmpeg: await wrapper("ffmpeg", ffmpeg) };
const device = { id: "qa-ios-native", name: "iOS native video QA", platform: "Apple", kind: "virtual", model: "QA", visibility: "local", connection: { type: "simulator", udid, os: "ios" }, captureSourceId: "qa-ios-source" };
const source = { id: "qa-ios-source", kind: "native", name: "iOS native screen", deviceId: device.id };
let screenshotCalls = 0;
class AuditedAdapters extends Adapters {
  async screenshot() { screenshotCalls++; throw new Error("Native iOS video must never capture screenshots."); }
  async startInteractive(target, control) {
    assert.ok(!realUdid, "Actual simulator QA is view-only.");
    // The fake UDID has no simctl entry. Keep the real idb gesture adapter and
    // identity checks, bypassing only the OS-level boot readiness preflight.
    return startIdbInteractive(target, tools.idb, control);
  }
}
const adapters = new AuditedAdapters(() => ({ tools }));
const capture = new CaptureEngine(adapters);
const failures = [];
const streams = new LiveStreams({
  resolve(args) {
    assert.ok(args.deviceId === device.id || args.sourceId === source.id);
    assert.ok(!realUdid || !args.control, "Actual simulator QA is view-only.");
    return { device, source, validate() {} };
  },
  video: (target, profile) => capture.live(target.device, target.source, profile),
  interactive: (target, profile) => adapters.startInteractive(target, true, profile),
  report: (error) => failures.push(error.message),
});
const html = `<!doctype html><meta charset="utf-8"><title>Native iOS video QA</title><style>body{margin:0;background:#111827;color:white;font:16px system-ui}video{max-width:100%;max-height:80vh;display:block;margin:1rem auto}h1{text-align:center;font-size:20px}</style><h1>Native iOS H.264 · read-only QA</h1><video autoplay muted playsinline></video>`;
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
    assert.equal(request.method, "POST");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    const result = request.url === "/open" ? await streams.open(value) : request.url === "/ping" ? await streams.ping(value) : request.url === "/close" ? await streams.closeStream(value) : undefined;
    assert.ok(result);
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ message: error.message })); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const result = { startedAt: new Date().toISOString(), source: realUdid ? "actual-booted-simulator" : "synthetic-native-h264", passed: false, cases: [], screenshots: [], screenshotCalls: 0, failures };
let browser;
const viewers = [];
async function commands() {
  return (await readFile(auditFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function openViewer(profile = "balanced", control = false) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(base);
  const began = Date.now();
  const answer = await page.evaluate(async ({ profile, control, deviceId }) => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    const receiver = peer.addTransceiver("video", { direction: "recvonly" });
    receiver.setCodecPreferences(RTCRtpReceiver.getCapabilities("video").codecs.filter((codec) => codec.mimeType === "video/H264"));
    const channel = control ? peer.createDataChannel("control", { ordered: true }) : undefined;
    peer.ontrack = ({ track, streams }) => { document.querySelector("video").srcObject = streams[0] || new MediaStream([track]); };
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); });
    });
    const response = await fetch("/open", { method: "POST", body: JSON.stringify({ deviceId, offer: peer.localDescription.sdp, profile, control, ...(control ? { sessionId: "qa-only-session", leaseToken: "qa-only-lease" } : {}) }) });
    const answer = await response.json();
    if (!response.ok) { peer.close(); throw new Error(answer.message); }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.answer });
    const credentials = { id: answer.id, token: answer.token };
    const heartbeat = setInterval(() => { void fetch("/ping", { method: "POST", body: JSON.stringify(credentials) }); }, 3000);
    window.qa = { peer, channel, credentials, heartbeat };
    return { mode: answer.mode, width: answer.width, height: answer.height, capabilities: answer.capabilities };
  }, { profile, control, deviceId: device.id });
  viewers.push(page);
  assert.equal(answer.mode, "live");
  await page.waitForFunction(() => document.querySelector("video").readyState >= 2, undefined, { timeout: 25_000 });
  return { page, answer, connectedMs: Date.now() - began };
}
async function stats(page, milliseconds = 5000) {
  return page.evaluate(async (milliseconds) => {
    const video = document.querySelector("video");
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const digest = () => { context.drawImage(video, 0, 0, 64, 36); const bytes = context.getImageData(0, 0, 64, 36).data; return bytes.reduce((hash, value) => ((hash << 5) - hash + value) | 0, 0); };
    const firstHash = digest(), firstFrames = video.getVideoPlaybackQuality().totalVideoFrames, firstTime = video.currentTime;
    let callbacks = 0, callbackId;
    const frame = () => { callbacks++; callbackId = video.requestVideoFrameCallback(frame); };
    callbackId = video.requestVideoFrameCallback(frame);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    video.cancelVideoFrameCallback(callbackId);
    const hash = digest(), red = Array.from(context.getImageData(4, 4, 1, 1).data);
    return { width: video.videoWidth, height: video.videoHeight, callbacks, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames - firstFrames, advancedSeconds: video.currentTime - firstTime, observedFps: callbacks * 1000 / milliseconds, pixelsChanged: hash !== firstHash, sampleRGBA: red };
  }, milliseconds);
}
async function closeViewer(page) {
  await page.evaluate(async () => {
    const { peer, heartbeat, credentials } = window.qa;
    clearInterval(heartbeat);
    await fetch("/close", { method: "POST", body: JSON.stringify(credentials) });
    peer.close();
  });
  await page.close();
  viewers.splice(viewers.indexOf(page), 1);
}
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const primary = await openViewer();
  const measurement = await stats(primary.page);
  assert.ok(measurement.callbacks >= 20, "Native video must deliver substantially more than 2 fps.");
  assert.ok(measurement.advancedSeconds >= 3);
  if (!realUdid) {
    assert.ok(measurement.pixelsChanged, "The native fixture has moving pixels.");
    assert.ok(measurement.sampleRGBA[0] > 180 && measurement.sampleRGBA[1] < 80 && measurement.sampleRGBA[2] < 80, "Decoded native H.264 preserves the red reference patch.");
  }
  await primary.page.screenshot({ path: path.join(output, "native-video.png") });
  result.screenshots.push("native-video.png");
  result.cases.push({ name: "view-only-native-h264", ...primary.answer, connectedMs: primary.connectedMs, ...measurement });

  const late = await openViewer();
  const lateStats = await stats(late.page, 1200);
  assert.ok(lateStats.callbacks >= 5);
  let audit = await commands();
  assert.equal(audit.filter((event) => event.kind === "idb" && event.type === "start" && event.args[0] === "video-stream").length, 1, "Two balanced viewers share one native idb capture.");
  result.cases.push({ name: "late-viewer-shared-native-source", connectedMs: late.connectedMs, ...lateStats });
  await closeViewer(late.page);

  if (!realUdid) {
    const touch = await openViewer("balanced", true);
    assert.deepEqual(touch.answer.capabilities, ["tap", "swipe", "longPress"]);
    await touch.page.waitForFunction(() => window.qa.channel?.readyState === "open");
    await touch.page.evaluate(({ width, height }) => window.qa.channel.send(JSON.stringify({ type: "gesture", gesture: { type: "tap", x: width / 2, y: height / 2, width, height } })), touch.answer);
    for (let attempt = 0; attempt < 50 && !(await commands()).some((event) => event.type === "gesture"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    audit = await commands();
    assert.equal(audit.filter((event) => event.kind === "idb" && event.type === "start" && event.args[0] === "video-stream").length, 1, "Touch uses the shared native video, not a screenshot stream.");
    assert.ok(audit.some((event) => event.type === "gesture" && event.args[0] === "ui" && event.args[1] === "tap"));
    result.cases.push({ name: "touch-native-h264", ...touch.answer, ...(await stats(touch.page, 1200)), syntheticGestureAccepted: true });
    await closeViewer(touch.page);
  }
  {
    for (const profile of realUdid ? ["low"] : ["low", "high"]) {
      const viewer = await openViewer(profile);
      const sample = await stats(viewer.page, 1500);
      assert.ok(sample.callbacks >= (profile === "high" ? 20 : 7));
      if (profile === "low") assert.equal(Math.max(sample.width, sample.height), 640);
      const primaryStillAdvancing = await stats(primary.page, 1500);
      assert.ok(primaryStillAdvancing.callbacks >= 7, "A second quality profile must not interrupt the existing balanced viewer.");
      result.cases.push({ name: `profile-${profile}`, ...viewer.answer, ...sample, primaryStillAdvancing });
      await closeViewer(viewer.page);
    }
  }
  await closeViewer(primary.page);
  await streams.close();
  await capture.close();
  audit = await commands();
  assert.equal(screenshotCalls, 0);
  assert.ok(audit.filter((event) => event.kind === "idb" && event.type === "start").every((event) => ["describe", "video-stream", "ui"].includes(event.args[0])));
  const encoderStarts = audit.filter((event) => event.kind === "ffmpeg" && event.type === "start");
  assert.ok(encoderStarts.length > 0);
  assert.ok(encoderStarts.every((event) => !event.args.some((arg) => /image2pipe|mpjpeg|mjpeg|png/.test(arg))), "The native pipeline never enters an image decoder.");
  const childPids = audit.filter((event) => event.type === "child").flatMap((event) => [event.pid, event.childPid]);
  const stillRunning = childPids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  assert.deepEqual(stillRunning, [], "All QA-owned capture and encoder processes must stop.");
  assert.deepEqual(failures, []);
  result.cases.push({ name: "zero-screenshots-and-cleanup", screenshotCalls, nativeVideoStarts: audit.filter((event) => event.kind === "idb" && event.type === "start" && event.args[0] === "video-stream").length, encoderStarts: encoderStarts.length, leakedPids: stillRunning });
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  for (const page of [...viewers]) await closeViewer(page).catch(() => {});
  await browser?.close();
  await streams.close();
  await capture.close();
  await new Promise((resolve) => server.close(resolve));
  result.screenshotCalls = screenshotCalls;
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "commands.json"), JSON.stringify(await commands(), null, 2));
  await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: result.passed, cases: result.cases.length, output, error: result.error?.split("\n")[0] }));
}
