// Read-only production smoke/performance check. Opens exactly one already-booted
// iOS feed, leaves touch off, and never reserves, boots, or inputs to a device.
// node scripts/qa-ios-native-production.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const output = path.resolve(process.env.QA_IOS_NATIVE_OUTPUT || "outputs/ios-native-video-production-after");
const endpoint = JSON.parse(await readFile("work/local-deck/endpoint.json", "utf8"));
const base = `http://127.0.0.1:${endpoint.port}`;
const headers = { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" };
const inventory = async () => {
  const response = await fetch(`${base}/v1/operations/inventory`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  return response.json();
};
const before = await inventory();
const device = before.devices.find((entry) => entry.connection.type === "simulator" && entry.connection.os === "ios" && entry.online && entry.readiness !== "starting" && (!process.env.QA_IOS_NATIVE_UDID || entry.connection.udid === process.env.QA_IOS_NATIVE_UDID));
assert.ok(device, "This check requires an already-booted iOS simulator.");
assert.ok(!before.sessions.some((session) => session.deviceId === device.id && session.state !== "closed"), "Do not inspect a reserved simulator.");
assert.ok(!before.artifacts.some((artifact) => artifact.deviceId === device.id && ["recording", "finalizing"].includes(artifact.status)), "Do not inspect a recording simulator.");
const source = before.sources.find((entry) => entry.kind === "native" && entry.deviceId === device.id);
assert.ok(source);
const ticketResponse = await fetch(`${base}/v1/browser-ticket`, { method: "POST", headers, body: "{}" });
assert.equal(ticketResponse.status, 200);
const { ticket } = await ticketResponse.json();
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], operations = [], answers = [], blocked = [], health = [];
const result = { startedAt: new Date().toISOString(), device: device.name, sourceId: source.id, passed: false, errors, operations, answers, blocked, health };
let healthTimer;
let pendingHealth;
await page.addInitScript(() => {
  window.qaPeers = [];
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) { super(...args); window.qaPeers.push(this); }
  };
});
page.on("pageerror", (error) => errors.push(error.message));
// Enforce read-only behavior independently of the UI. Even a future regression
// in initial page setup cannot acquire a real reservation or dispatch input.
await page.route("**/v1/operations/**", async (route) => {
  const name = route.request().url().split("/v1/operations/")[1];
  const body = route.request().postDataJSON();
  if (!["inventory", "streams.open", "streams.ping", "streams.close"].includes(name) || name === "streams.open" && body.control !== false) {
    blocked.push(name); await route.abort(); return;
  }
  operations.push({ name, ...(name === "streams.open" ? { control: body.control, profile: body.profile, deviceId: body.deviceId, sourceId: body.sourceId } : {}) });
  await route.continue();
});
await page.route(/\/v1\/(?:source-)?preview\//, async (route) => { blocked.push("screenshot-preview"); await route.abort(); });
page.on("response", async (response) => {
  if (response.url().endsWith("/v1/operations/streams.open") && response.ok()) {
    const answer = await response.json();
    answers.push({ mode: answer.mode, width: answer.width, height: answer.height, capabilities: answer.capabilities });
  }
});
try {
  const query = new URLSearchParams({ view: "feeds", sources: source.id, active: source.id, layout: "single" });
  await page.goto(`${base}/?${query}#ticket=${ticket}`);
  const feed = page.locator(`[data-feed-source="${source.id}"]`);
  await expect(feed.locator(".deck-live-status")).toContainText("Live video · H.264 · silent", { timeout: 35_000 });
  await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked();
  assert.equal(await feed.locator("img").count(), 0);
  assert.equal(await feed.getByRole("combobox", { name: /Video quality/ }).inputValue(), "balanced");
  const started = performance.now();
  healthTimer = setInterval(() => {
    if (pendingHealth) return;
    const began = performance.now();
    pendingHealth = fetch(`${base}/v1/health`, { headers, signal: AbortSignal.timeout(5000) })
      .then(async (response) => { await response.arrayBuffer(); health.push({ atMs: performance.now() - started, elapsedMs: performance.now() - began, status: response.status }); })
      .catch((error) => { health.push({ atMs: performance.now() - started, elapsedMs: performance.now() - began, error: error.message }); })
      .finally(() => { pendingHealth = undefined; });
  }, 200);
  result.samples = await feed.locator("video").evaluate(async (video) => {
    const rows = [];
    let previousDecoded = 0, previousReceived = 0, previousAt = performance.now();
    for (let second = 1; second <= 30; second++) {
      let callbacks = 0, frameId;
      const frame = () => { callbacks++; frameId = video.requestVideoFrameCallback(frame); };
      frameId = video.requestVideoFrameCallback(frame);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      video.cancelVideoFrameCallback(frameId);
      const at = performance.now();
      const stats = Array.from((await window.qaPeers[0].getStats()).values()).find((entry) => entry.type === "inbound-rtp");
      rows.push({ second, elapsedMs: at - previousAt, callbacks, decoded: stats.framesDecoded - previousDecoded, received: stats.framesReceived - previousReceived, droppedTotal: stats.framesDropped, freezeCount: stats.freezeCount || 0, jitter: stats.jitter, mediaTime: video.currentTime });
      previousDecoded = stats.framesDecoded; previousReceived = stats.framesReceived; previousAt = at;
    }
    return rows;
  });
  clearInterval(healthTimer); await pendingHealth;
  const settled = result.samples.slice(5);
  result.observedFps = settled.reduce((sum, sample) => sum + sample.callbacks, 0) * 1000 / settled.reduce((sum, sample) => sum + sample.elapsedMs, 0);
  result.receivedFps = settled.reduce((sum, sample) => sum + sample.received, 0) * 1000 / settled.reduce((sum, sample) => sum + sample.elapsedMs, 0);
  result.stalledSecondsAfterWarmup = settled.filter((sample) => sample.received < 3).length;
  result.healthMaxMs = Math.max(...health.map((sample) => sample.elapsedMs));
  const durations = health.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  result.healthP95Ms = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  result.label = await feed.locator(".deck-live-status > span").innerText();
  result.touchEnabled = await feed.getByRole("switch", { name: "Enable touch", exact: true }).isChecked();
  result.dimensions = await feed.locator("video").evaluate((video) => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState }));
  await page.screenshot({ path: path.join(output, "local-ios-native-video.png"), fullPage: true });
  const after = await inventory();
  result.createdSessions = after.sessions.filter((session) => !before.sessions.some((previous) => previous.id === session.id)).length;
  assert.equal(result.createdSessions, 0);
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  assert.equal(answers.length, 1); assert.equal(answers[0].mode, "live");
  assert.ok(health.every((sample) => sample.status === 200));
  result.performancePassed = result.observedFps >= 12 && result.stalledSecondsAfterWarmup === 0 && result.healthMaxMs < 750;
  assert.ok(result.performancePassed, "Native video works, but delivery/health latency still needs investigation; see results.json.");
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  clearInterval(healthTimer); await pendingHealth;
  await browser.close();
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, observedFps: result.observedFps, receivedFps: result.receivedFps, stalledSeconds: result.stalledSecondsAfterWarmup, healthMaxMs: result.healthMaxMs, healthP95Ms: result.healthP95Ms, output }));
}
