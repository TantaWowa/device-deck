// Run from the repository root after scripts/qa-live-server.ts reports LIVE_QA_READY.
// Requires an installed Google Chrome (or PLAYWRIGHT_CHANNEL=chromium and its browser).
// Uses synthetic video and gesture adapters only; no real hardware or cloud account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const output = path.resolve("outputs/live-video-qa");
const fixture = JSON.parse(await readFile(path.join(output, "fixture.json"), "utf8"));
const origin = new URL(fixture.base);
assert.equal(origin.hostname, "127.0.0.1", "Only the loopback synthetic fixture may be controlled.");
assert.equal(origin.protocol, "http:");
assert.equal(fixture.token, "synthetic-qa-token");
await mkdir(output, { recursive: true });

async function api(name, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${name}: ${result.message || response.status}`);
  return result;
}
const inventory = await api("inventory");
assert.deepEqual(inventory.devices.map(({ id, name }) => ({ id, name })), [
  { id: "usb", name: "Synthetic USB" }, { id: "android", name: "Synthetic Android" },
  { id: "android-sim", name: "Synthetic Android emulator" }, { id: "apple-sim", name: "Synthetic Apple simulator" },
]);
assert.equal(inventory.devices[1].connection.serial, "qa-only-not-real");
assert.deepEqual(inventory.sources.map(({ id }) => id), ["qa-usb", "qa-native"]);

async function readInputs() {
  // The fixture writes every 250 ms; retry if this read overlaps a file write.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return JSON.parse(await readFile(path.join(output, "inputs.json"), "utf8")); }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("Could not read synthetic input evidence.");
}
const results = { startedAt: new Date().toISOString(), browser: "", cases: [], screenshots: [], passed: false };
const cleanupLeases = new Map();
let browser;
let portal;

function observe(page) {
  const errors = [];
  const pending = [];
  const operations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const name = response.url().split("/v1/operations/")[1];
    if (!name) return;
    operations.push({ name, status: response.status() });
    if (name === "sessions.reserve" || name === "sessions.takeover") {
      pending.push(response.json().then((result) => {
        if (result.session?.id && result.leaseToken)
          cleanupLeases.set(result.session.id, { sessionId: result.session.id, leaseToken: result.leaseToken });
      }).catch(() => {}));
    }
  });
  return { errors, pending, operations };
}
async function cleanup() {
  for (const [id, lease] of cleanupLeases) {
    try { await api("sessions.release", lease); } catch { /* A successful End session has already released it. */ }
    cleanupLeases.delete(id);
  }
}
async function ticketUrl() {
  const response = await fetch(`${fixture.base}/v1/browser-ticket`, {
    method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200);
  const { ticket } = await response.json();
  return `${fixture.base}/#ticket=${ticket}`;
}
async function picture(page, filename) {
  await page.screenshot({ path: path.join(output, filename) });
  results.screenshots.push(filename);
}
async function movingVideo(page, milliseconds = 1200) {
  await page.waitForFunction(() => document.querySelectorAll("video").length === 2 && [...document.querySelectorAll("video")].every((video) => video.readyState >= 2), undefined, { timeout: 35_000 });
  const first = await page.locator("video").evaluateAll((videos) => videos.map((video) => video.getVideoPlaybackQuality().totalVideoFrames));
  const started = Date.now();
  await page.waitForTimeout(milliseconds);
  const second = await page.locator("video").evaluateAll((videos) => videos.map((video) => ({ frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth, height: video.videoHeight, time: video.currentTime })));
  const elapsedMs = Date.now() - started;
  for (const [index, video] of second.entries()) {
    assert.ok(video.frames > first[index] + 5, "Each H.264 feed must keep advancing.");
    assert.ok(video.width > 0 && video.height > 0);
  }
  return second.map((video, index) => ({ ...video, observedFrames: video.frames - first[index], elapsedMs, observedFps: (video.frames - first[index]) * 1000 / elapsedMs }));
}
async function dragAndCancel(page, remote) {
  const video = remote.locator("video");
  const box = await video.boundingBox();
  assert.ok(box);
  const before = (await readInputs()).length;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 40, center.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await readInputs()).slice(before).some((event) => event.type === "up"), { timeout: 5000 }).toBe(true);
  const events = (await readInputs()).slice(before).filter((event) => event.type !== "cancel");
  assert.equal(events[0].type, "down");
  assert.equal(events.at(-1).type, "up");
  assert.ok(events.slice(1, -1).every((event) => event.type === "move"));
  assert.ok(events.length <= 12, "Pointer input must not duplicate or replay samples.");
  // Slow Playwright scheduling may deliver moves below the coalescing rate;
  // live-input.test.ts verifies high-rate coalescing deterministically.
  assert.equal(events[0].width, 640);
  assert.equal(events[0].height, 360);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect.poll(async () => (await readInputs()).slice(before).some((event) => event.type === "cancel"), { timeout: 5000 }).toBe(true);
  return { orderedPointerEvents: events.length, coordinates: { width: events[0].width, height: events[0].height }, blurCancelled: true };
}
async function endSession(page, remote, isPortal, deviceId = "android") {
  const released = page.waitForResponse((response) => response.url().endsWith("/operations/sessions.release"));
  if (isPortal) await remote.getByRole("button", { name: "End session", exact: true }).click();
  else {
    await remote.getByRole("button", { name: "End session…", exact: true }).click();
    await remote.getByRole("alertdialog").getByRole("button", { name: "End session", exact: true }).click();
  }
  assert.equal((await released).status(), 200);
  await remote.getByRole("button", { name: "Start control session", exact: true }).waitFor();
  assert.ok(!(await api("inventory")).sessions.some((session) => session.deviceId === deviceId && session.state !== "closed"));
}
async function workspaceCase(viewport, isPortal) {
  const label = `${isPortal ? "portal" : "local"}-${viewport.width}`;
  const page = await browser.newPage({ viewport });
  const observed = observe(page);
  try {
    await page.goto(isPortal ? portal.url : await ticketUrl());
    if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
    const video = await movingVideo(page, !isPortal && viewport.width === 1440 ? 6500 : 1200);
    if (!isPortal && viewport.width === 1440) assert.ok(observed.operations.some((operation) => operation.name === "streams.ping" && operation.status === 200));
    await picture(page, `${label}-feeds.png`);
    assert.equal(await page.locator('input[type="checkbox"]').count(), 0, "Feed checkboxes belong inside the chooser.");
    if (isPortal) await page.locator(".feed-card").filter({ hasText: "Synthetic Android screen" }).getByRole("button", { name: "Remote", exact: true }).click();
    else await page.getByRole("button", { name: "Remote · Synthetic Android screen", exact: true }).click();
    const remote = page.getByRole(isPortal ? "dialog" : "region", { name: "Remote for Synthetic Android", exact: true });
    await remote.waitFor();
    assert.equal(await remote.locator("video,img").count(), 0, "The remote panel must contain controls only.");
    await picture(page, `${label}-remote.png`);
    await remote.getByRole("button", { name: "Close remote", exact: true }).click();
    const feed = page.locator('[data-feed-source="qa-native"]');
    await feed.getByRole("button", { name: "Start control session", exact: true }).click();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    const input = await dragAndCancel(page, feed);
    await picture(page, `${label}-touch-feed.png`);
    await endSession(page, feed, isPortal);
    await Promise.all(observed.pending);
    assert.deepEqual(observed.errors, []);
    results.cases.push({ name: label, passed: true, video, input, controlsOnlyRemote: true, touchOnFeed: true, sessionReleased: true, browserErrors: observed.errors });
    console.log(`PASS ${label}: video, controls-only remote, feed gestures, cancellation and session release`);
  } finally { await Promise.all(observed.pending); await page.close(); await cleanup(); }
}
async function simulatorCase(isPortal, deviceId, name, alreadyRunningWithoutSource = false) {
  const label = `${isPortal ? "portal" : "local"}-${deviceId}-${alreadyRunningWithoutSource ? "running-unbound" : "launch"}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const observed = observe(page);
  try {
    if (alreadyRunningWithoutSource) {
      await api("devices.simulator", { deviceId, action: "launch" });
      const current = await api("inventory");
      assert.ok(!current.sessions.some((session) => session.state !== "closed"));
      const config = structuredClone(current.config);
      config.sources = config.sources.filter((source) => source.deviceId !== deviceId);
      config.devices.find((device) => device.id === deviceId).captureSourceId = null;
      await api("config.save", { config, revision: current.configRevision });
      const unbound = await api("inventory");
      assert.equal(unbound.devices.find((device) => device.id === deviceId).online, true);
      assert.equal(unbound.devices.find((device) => device.id === deviceId).captureSourceId, null);
      assert.ok(!unbound.sources.some((source) => source.deviceId === deviceId));
    }
    await page.goto(isPortal ? portal.url : await ticketUrl());
    if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
    await page.getByRole("button", { name: "Start simulator", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose feeds", exact: true });
    await picture(page, `${label}-chooser.png`);
    await picker.getByRole("button", { name: `Launch ${name} and show feed`, exact: true }).click();
    const feed = page.locator(`[data-feed-source="native-${deviceId}"]`);
    await feed.waitFor({ timeout: 35_000 });
    await expect.poll(async () => feed.locator("video").evaluate((video) => video.readyState >= 2), { timeout: 35_000 }).toBe(true);
    const inventory = await api("inventory");
    assert.equal(inventory.devices.find((d) => d.id === deviceId).online, true);
    assert.equal(inventory.devices.find((d) => d.id === deviceId).captureSourceId, `native-${deviceId}`);
    await feed.getByRole("button", { name: "Start control session", exact: true }).click();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    const before = (await readInputs()).length;
    await feed.locator("video").click();
    await expect.poll(async () => (await readInputs()).slice(before).some((event) => event.deviceId === deviceId && event.type === (deviceId === "apple-sim" ? "tap" : "up")), { timeout: 5000 }).toBe(true);
    await picture(page, `${label}.png`);
    await endSession(page, feed, isPortal, deviceId);
    assert.deepEqual(observed.errors, []);
    results.cases.push({ name: label, passed: true, alreadyRunningWithoutSource, launchedFromChooser: true, automaticallyRevealed: true, nativeSourceProvisioned: true, decodedVideo: true, touchAccepted: true, controls: deviceId === "apple-sim" ? "completed gestures" : "continuous pointer" });
    console.log(`PASS ${label}: launch, reveal, video decode, touch and session release`);
  } finally {
    await Promise.all(observed.pending); await page.close(); await cleanup();
    await api("devices.simulator", { deviceId, action: "close", confirmed: true });
  }
}
async function fallbackCase() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const observed = observe(page);
  try {
    await page.goto(await ticketUrl());
    await page.getByRole("button", { name: "Feeds", exact: true }).click();
    const tile = page.locator(".feed-tile").first();
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, undefined, { timeout: 35_000 });
    const switched = page.waitForResponse((response) => response.url().endsWith("/streams.open") && response.request().postDataJSON().profile === "low");
    await tile.getByRole("combobox").selectOption("low");
    assert.equal((await switched).status(), 200);
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, undefined, { timeout: 35_000 });
    await page.route("**/v1/operations/streams.open", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic unsupported video source" }) }));
    await tile.getByRole("combobox").selectOption("high");
    await expect(tile).toContainText("Synthetic unsupported video source");
    await tile.getByRole("button", { name: "Use snapshot preview", exact: true }).click();
    await tile.locator("img").waitFor();
    await expect(tile).toContainText("Snapshot preview · view only");
    assert.equal(await tile.locator("video").count(), 0);
    await picture(page, "snapshot-fallback.png");
    assert.deepEqual(observed.errors, []);
    results.cases.push({ name: "profile-and-fallback", passed: true, lowBandwidthConnected: true, explicitSnapshotFallback: true, accuratelyLabeled: true });
    console.log("PASS profile switching and explicit view-only snapshot fallback");
  } finally { await page.close(); }
}
async function startPortal() {
  await build({ entryPoints: ["scripts/fixtures/live-portal.tsx"], bundle: true, format: "esm", outfile: path.join(output, "portal-harness.js"), loader: { ".css": "css" } });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/portal-harness.css"><div id="root"></div><script type="module" src="/portal-harness.js"></script>');
      } else if (request.url === "/v1/machine") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "f5e2543a-10d6-4f22-863a-357209b292d8", name: "Synthetic Mac", version: "qa", publicKey: { kty: "OKP", crv: "Ed25519", x: "a".repeat(43) } }));
      } else if (request.url?.startsWith("/v1/")) {
        if (request.headers.authorization !== "Bearer fixture-grant") { response.writeHead(401); response.end(); return; }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(fixture.base + request.url, { method: request.method,
          headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" },
          body: request.method === "POST" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(30_000) });
        response.statusCode = upstream.status;
        response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } else if (["/portal-harness.js", "/portal-harness.css"].includes(request.url)) {
        response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript");
        response.end(await readFile(path.join(output, request.url.slice(1))));
      } else { response.writeHead(404); response.end(); }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  results.browser = browser.version();
  portal = await startPortal();
  for (const isPortal of [false, true])
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }])
      await workspaceCase(viewport, isPortal);
  await fallbackCase();
  for (const isPortal of [false, true]) {
    await simulatorCase(isPortal, "android-sim", "Synthetic Android emulator");
    await simulatorCase(isPortal, "apple-sim", "Synthetic Apple simulator");
  }
  await simulatorCase(false, "android-sim", "Synthetic Android emulator", true);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser?.close();
  await cleanup();
  await portal?.close();
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Evidence: ${path.join(output, "results.json")}`);
}
