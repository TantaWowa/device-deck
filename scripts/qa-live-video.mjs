// Run from the repository root after scripts/qa-live-server.ts reports LIVE_QA_READY.
// Requires an installed Google Chrome (or PLAYWRIGHT_CHANNEL=chromium and its browser).
// Uses synthetic video and gesture adapters only; no real hardware or cloud account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const output = path.resolve(process.env.QA_LIVE_OUTPUT || "outputs/live-video-qa");
const portalOnly = process.env.QA_LIVE_FOCUS === "portal";
const mobileOnly = process.env.QA_LIVE_FOCUS === "mobile";
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
assert.deepEqual(inventory.sources.filter(({ id }) => id.startsWith("qa-")).map(({ id }) => id), ["qa-usb", "qa-native"]);
assert.ok(inventory.sources.every(({ id }) => ["qa-usb", "qa-native", "native-android-sim", "native-apple-sim"].includes(id)));

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
  await video.scrollIntoViewIfNeeded();
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
async function confirmAction(page, feed, isPortal, action, accept, confirmation, warning) {
  if (isPortal) {
    const dialogPromise = page.waitForEvent("dialog");
    const clicked = action();
    const dialog = await dialogPromise;
    assert.match(dialog.message(), warning);
    if (accept) await dialog.accept(); else await dialog.dismiss();
    await clicked;
  } else {
    await action();
    const dialog = feed.getByRole("alertdialog", { name: "Confirm feed session change", exact: true });
    await expect(dialog).toContainText(warning);
    await dialog.getByRole("button", { name: accept ? confirmation : "Cancel", exact: true }).click();
  }
}
async function endSession(page, feed, isPortal, deviceId = "android", testCancel = false) {
  const end = () => feed.getByRole("button", { name: isPortal ? "End session" : "End session…", exact: true }).click();
  if (testCancel) {
    await confirmAction(page, feed, isPortal, end, false, "End session", /[Ee]nd.*session/);
    assert.ok((await api("inventory")).sessions.some((session) => session.deviceId === deviceId && session.state !== "closed"));
    await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).toBeChecked();
  }
  const released = page.waitForResponse((response) => response.url().endsWith("/operations/sessions.release"));
  await confirmAction(page, feed, isPortal, end, true, "End session", /[Ee]nd.*session/);
  assert.equal((await released).status(), 200);
  await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked();
  assert.ok(!(await api("inventory")).sessions.some((session) => session.deviceId === deviceId && session.state !== "closed"));
}
async function workspaceCase(viewport, isPortal) {
  const label = `${isPortal ? "portal" : "local"}-${viewport.width}`;
  const page = await browser.newPage({ viewport, hasTouch: viewport.width <= 640 });
  const observed = observe(page);
  try {
    await page.goto(isPortal ? portal.url : await ticketUrl());
    if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
    const video = await movingVideo(page, !isPortal && viewport.width === 1440 ? 6500 : 1200);
    if (!isPortal && viewport.width === 1440) assert.ok(observed.operations.some((operation) => operation.name === "streams.ping" && operation.status === 200));
    await picture(page, `${label}-feeds.png`);
    assert.equal(await page.locator('input[type="checkbox"]:not([role="switch"])').count(), 0, "Feed selection checkboxes belong inside the chooser.");
    const feed = page.locator('[data-feed-source="qa-native"]');
    assert.equal(await feed.getByRole("button", { name: /Remote/ }).count(), 0, "Phones must not offer a TV remote.");
    const tvFeed = page.locator('[data-feed-source="qa-usb"]');
    assert.equal(await tvFeed.getByRole("switch", { name: "Enable touch", exact: true }).count(), 0, "A remote-only device must not show a touch switch.");
    if (isPortal) await tvFeed.getByRole("button", { name: "Remote", exact: true }).click();
    else await page.getByRole("button", { name: "Remote · Synthetic USB feed", exact: true }).click();
    const remote = page.getByLabel("Remote for Synthetic USB", { exact: true });
    await remote.waitFor();
    const remoteMenu = remote.getByRole("button", { name: "Remote menu", exact: true });
    if (await remoteMenu.count() && await remoteMenu.getAttribute("aria-expanded") !== "true") await remoteMenu.click();
    assert.equal(await remote.locator("video,img").count(), 0, "The remote panel must contain controls only.");
    await picture(page, `${label}-remote.png`);
    await remote.getByRole("button", { name: "Close remote", exact: true }).click();
    const toggle = feed.getByRole("switch", { name: "Enable touch", exact: true });
    await expect(toggle).not.toBeChecked();
    assert.ok(!(await api("inventory")).sessions.some((session) => session.deviceId === "android" && session.state !== "closed"));
    let releaseStale;
    if (isPortal) {
      const stale = await api("inventory");
      const delayed = new Promise((resolve) => { releaseStale = resolve; });
      const pattern = "**/v1/operations/inventory";
      await page.route(pattern, async (route) => {
        await delayed;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
      }, { times: 1 });
      const requested = page.waitForRequest((request) => request.url().endsWith("/operations/inventory"));
      if (viewport.width > 640) await page.getByRole("button", { name: "Refresh machine", exact: true }).click();
      await requested;
    }
    const reserved = page.waitForResponse((response) => response.url().endsWith("/operations/sessions.reserve"));
    await toggle.click();
    assert.equal((await reserved).status(), 200);
    releaseStale?.();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    await expect(toggle).toBeChecked();
    const own = (await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed");
    assert.ok(own, "Enabling touch must reserve the device.");
    if (viewport.width <= 640) {
      await feed.locator("video").scrollIntoViewIfNeeded();
      const box = await feed.locator("video").boundingBox();
      assert.ok(box);
      const before = (await readInputs()).length;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(async () => (await readInputs()).slice(before).some((event) => event.deviceId === "android" && event.type === "up"), { timeout: 5000 }).toBe(true);
    }
    const input = await dragAndCancel(page, feed);
    await picture(page, `${label}-touch-feed.png`);
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(geometry.document <= geometry.viewport + 1, "Feed controls must not overflow the page.");
    if (!isPortal) {
      const switchBox = await toggle.boundingBox();
      assert.ok(switchBox && switchBox.width >= 34 && switchBox.height >= 20, "The switch must retain its track dimensions under the app styles.");
    }
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(feed.locator(".deck-touch-enabled")).toHaveCount(0);
    const beforeDisabledClick = (await readInputs()).filter((event) => event.deviceId === "android" && ["down", "move", "up", "tap"].includes(event.type)).length;
    await feed.locator("video").click();
    await page.waitForTimeout(350);
    assert.equal((await readInputs()).filter((event) => event.deviceId === "android" && ["down", "move", "up", "tap"].includes(event.type)).length, beforeDisabledClick);
    assert.equal((await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed")?.id, own.id);
    await confirmAction(page, feed, isPortal, () => toggle.click(), false, "Enable touch", /interrupt work|running tests/i);
    await expect(toggle).not.toBeChecked();
    await confirmAction(page, feed, isPortal, () => toggle.click(), true, "Enable touch", /interrupt work|running tests/i);
    await expect(toggle).toBeChecked();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    assert.equal((await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed")?.id, own.id, "Re-enabling reuses the reservation.");
    if (isPortal) {
      await page.getByRole("button", { name: /^Devices/ }).click();
      await page.getByRole("button", { name: /^Feeds/ }).click();
      await expect(toggle).not.toBeChecked();
      assert.equal((await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed")?.id, own.id);
      await confirmAction(page, feed, true, () => toggle.click(), true, "Enable touch", /interrupt work|running tests/i);
      await expect(toggle).toBeChecked();
      await page.getByRole("button", { name: "Choose feeds", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Choose feeds", exact: true });
      const selected = picker.locator(".portal-feed-option").filter({ hasText: "Synthetic Android screen" }).getByRole("checkbox");
      await selected.uncheck();
      await expect(feed).toHaveCount(0);
      await selected.check();
      await picker.getByRole("button", { name: "Close feed picker", exact: true }).click();
      await expect(toggle).not.toBeChecked();
      assert.equal((await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed")?.id, own.id);
      await confirmAction(page, feed, true, () => toggle.click(), true, "Enable touch", /interrupt work|running tests/i);
      await expect(toggle).toBeChecked();
    }
    await endSession(page, feed, isPortal, "android", true);

    const other = await api("sessions.reserve", { selector: { device: "android" }, owner: "QA other user", reason: "Synthetic takeover proof" });
    cleanupLeases.set(other.session.id, { sessionId: other.session.id, leaseToken: other.leaseToken });
    if (isPortal && viewport.width > 640) await page.getByRole("button", { name: "Refresh machine", exact: true }).click();
    await expect(feed).toContainText("QA other user", { timeout: 15_000 });
    await confirmAction(page, feed, isPortal, () => toggle.click(), false, "End session & enable touch", /Take over.*QA other user/);
    await expect(toggle).not.toBeChecked();
    assert.equal((await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed")?.id, other.session.id);
    await confirmAction(page, feed, isPortal, () => toggle.click(), true, "End session & enable touch", /Take over.*QA other user/);
    await expect(toggle).toBeChecked();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    const replaced = (await api("inventory")).sessions.find((session) => session.deviceId === "android" && session.state !== "closed");
    assert.ok(replaced && replaced.id !== other.session.id);
    await endSession(page, feed, isPortal);
    await Promise.all(observed.pending);
    assert.deepEqual(observed.errors, []);
    results.cases.push({ name: label, passed: true, video, input, geometry, ...(viewport.width <= 640 ? { browserTouchscreenTapAccepted: true } : {}), controlsOnlyTvRemote: true, noPhoneRemote: true, touchOffByDefault: true, disablePreservesReservation: true, reenableConfirmed: true, takeoverCancelAndAccept: true, endSessionCancelAndAccept: true, ...(isPortal ? { staleInventoryPreservesLease: true, leavingOrHidingFeedDisablesTouch: true } : {}), browserErrors: observed.errors });
    console.log(`PASS ${label}: video, TV remote, touch switch, preserved reservation, takeover and end confirmations`);
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
    const launch = picker.getByRole("button", { name: `Launch ${name} and show feed`, exact: true });
    const launchCount = (await readInputs()).filter((event) => event.type === "simulator" && event.deviceId === deviceId && event.action === "launch").length;
    await launch.click();
    if (!alreadyRunningWithoutSource) {
      await expect(launch).toBeDisabled();
      await expect(launch).toContainText("Booting");
      const starting = (await api("inventory")).devices.find((device) => device.id === deviceId);
      assert.equal(starting.online, false);
      assert.equal(starting.readiness, "starting");
      assert.equal(starting.simulatorState, "starting");
      await picture(page, `${label}-booting.png`);
    }
    const feed = page.locator(`[data-feed-source="native-${deviceId}"]`);
    await feed.waitFor({ timeout: 35_000 });
    await expect.poll(async () => feed.locator("video").evaluate((video) => video.readyState >= 2), { timeout: 35_000 }).toBe(true);
    const inventory = await api("inventory");
    assert.equal(inventory.devices.find((d) => d.id === deviceId).online, true);
    assert.equal(inventory.devices.find((d) => d.id === deviceId).captureSourceId, `native-${deviceId}`);
    await expect.poll(async () => (await readInputs()).filter((event) => event.type === "simulator" && event.deviceId === deviceId && event.action === "launch").length).toBe(launchCount + 1);
    const toggle = feed.getByRole("switch", { name: "Enable touch", exact: true });
    await expect(toggle).not.toBeChecked();
    assert.equal(await feed.getByRole("button", { name: /Remote/ }).count(), 0);
    await toggle.click();
    await feed.locator(".deck-touch-enabled").waitFor({ timeout: 35_000 });
    const before = (await readInputs()).length;
    await feed.locator("video").click();
    await expect.poll(async () => (await readInputs()).slice(before).some((event) => event.deviceId === deviceId && event.type === (deviceId === "apple-sim" ? "tap" : "up")), { timeout: 5000 }).toBe(true);
    await picture(page, `${label}.png`);
    await endSession(page, feed, isPortal, deviceId);
    assert.deepEqual(observed.errors, []);
    results.cases.push({ name: label, passed: true, alreadyRunningWithoutSource, launchedFromChooser: true, bootingShown: !alreadyRunningWithoutSource, duplicateLaunchDisabled: !alreadyRunningWithoutSource, automaticallyRevealed: true, nativeSourceProvisioned: true, decodedVideo: true, touchOffByDefault: true, touchAccepted: true, controls: deviceId === "apple-sim" ? "completed gestures" : "continuous pointer" });
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
  for (const isPortal of portalOnly ? [true] : [false, true])
    for (const viewport of mobileOnly ? [{ width: 390, height: 844 }] : [{ width: 1440, height: 1000 }, { width: 390, height: 844 }])
      await workspaceCase(viewport, isPortal);
  if (!portalOnly && !mobileOnly) await fallbackCase();
  for (const isPortal of mobileOnly ? [] : portalOnly ? [true] : [false, true]) {
    await simulatorCase(isPortal, "android-sim", "Synthetic Android emulator");
    await simulatorCase(isPortal, "apple-sim", "Synthetic Apple simulator");
  }
  if (!portalOnly && !mobileOnly) await simulatorCase(false, "android-sim", "Synthetic Android emulator", true);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser?.close();
  await cleanup();
  await portal?.close();
  results.finishedAt = new Date().toISOString();
  const resultFile = path.join(output, mobileOnly ? "mobile-results.json" : portalOnly ? "portal-results.json" : "results.json");
  await writeFile(resultFile, JSON.stringify(results, null, 2));
  console.log(`Evidence: ${resultFile}`);
}
