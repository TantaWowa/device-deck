// Starts its own synthetic daemon on an ephemeral loopback port. No real device
// discovery, device input, cloud account, or running Device Deck service is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const output = path.resolve("outputs/touch-feedback-qa");
await mkdir(output, { recursive: true });
const results = { startedAt: new Date().toISOString(), cases: [], screenshots: [], passed: false };
const leases = new Map();
let fixture, browser, portal;
let fixtureLog = "";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/qa-live-server.ts"], {
  env: { ...process.env, QA_LIVE_PORT: "0", QA_LIVE_OUTPUT: output, QA_PHONE_CONTROLS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise((resolve) => child.once("exit", resolve));
child.stderr.on("data", (data) => { fixtureLog += data; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Synthetic fixture timed out.\n${fixtureLog}`)), 60_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Synthetic fixture exited (${code}).\n${fixtureLog}`)); });
  child.stdout.on("data", (data) => {
    fixtureLog += data;
    const match = /^LIVE_QA_READY (.+)$/m.exec(fixtureLog);
    if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
  });
});
const headers = { Authorization: "Bearer synthetic-qa-token", "Content-Type": "application/json", "X-Device-Deck": "local" };
async function api(name, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${name}`, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
  return body;
}
async function inputs() {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return JSON.parse(await readFile(path.join(output, "inputs.json"), "utf8")); }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("Synthetic input evidence unavailable.");
}
async function cleanupLeases() {
  for (const lease of leases.values()) await api("sessions.release", lease).catch(() => {});
  leases.clear();
}
async function ticketUrl() {
  const response = await fetch(`${fixture.base}/v1/browser-ticket`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  return `${fixture.base}/#ticket=${(await response.json()).ticket}`;
}
async function startPortal() {
  await build({ entryPoints: ["scripts/fixtures/live-portal.tsx"], bundle: true, format: "esm", outfile: path.join(output, "portal.js"), loader: { ".css": "css" } });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/portal.css"><div id="root"></div><script type="module" src="/portal.js"></script>');
      } else if (request.url === "/v1/machine") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "f5e2543a-10d6-4f22-863a-357209b292d8", name: "Synthetic Mac", version: "qa", publicKey: { kty: "OKP", crv: "Ed25519", x: "a".repeat(43) } }));
      } else if (request.url?.startsWith("/v1/")) {
        assert.equal(request.headers.authorization, "Bearer fixture-grant");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(fixture.base + request.url, { method: request.method, headers,
          body: request.method === "POST" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(30_000) });
        response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/octet-stream" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } else if (["/portal.js", "/portal.css"].includes(request.url)) {
        response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript");
        response.end(await readFile(path.join(output, request.url.slice(1))));
      } else { response.writeHead(404); response.end(); }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

const platforms = [
  { id: "android", source: "qa-native", completed: false },
  { id: "apple-sim", source: "qa-ios", completed: true },
];
const feedbackEvents = new Set(["down", "move", "up", "tap", "swipe", "longPress"]);
async function gesturesFor(id) { return (await inputs()).filter((event) => event.deviceId === id && feedbackEvents.has(event.type)); }
async function screenshot(page, filename) {
  await page.screenshot({ path: path.join(output, filename) });
  results.screenshots.push(filename);
}
async function geometry(feed) {
  return feed.locator("video").evaluate((video) => {
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    return { left: box.left + (box.width - video.videoWidth * scale) / 2,
      top: box.top + (box.height - video.videoHeight * scale) / 2,
      width: video.videoWidth * scale, height: video.videoHeight * scale,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
}
function at(frame, x, y) { return { x: frame.left + frame.width * x, y: frame.top + frame.height * y }; }
async function expectContact(feed, target) {
  const circle = feed.locator('.deck-touch-trace[data-touch-phase="active"] .deck-touch-contact');
  await expect(circle).toHaveCount(1);
  const readPosition = () => circle.evaluate((element) => {
    const matrix = element.getScreenCTM();
    const point = new DOMPoint(element.cx.baseVal.value, element.cy.baseVal.value).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  // Feedback deliberately batches pointer samples into animation frames. The
  // last browser input can finish before that frame paints under encoder load.
  await expect.poll(async () => {
    const position = await readPosition();
    return Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y));
  }, { message: "Rendered touch feedback must reach the final input coordinates" }).toBeLessThanOrEqual(2);
  const position = await readPosition();
  assert.ok(Math.abs(position.x - target.x) <= 2 && Math.abs(position.y - target.y) <= 2,
    `Feedback ${JSON.stringify(position)} must align with browser contact ${JSON.stringify(target)}.`);
  return position;
}
async function enable(page, feed, isPortal) {
  const toggle = feed.getByRole("switch", { name: "Enable touch", exact: true });
  await toggle.click();
  if (!isPortal) {
    const confirm = feed.getByRole("alertdialog").getByRole("button", { name: "Enable touch", exact: true });
    if (await confirm.isVisible()) await confirm.click();
  }
  await expect(feed.locator(".deck-touch-enabled")).toHaveCount(1, { timeout: 35_000 });
  await expect(toggle).toBeChecked();
}
async function workspaceCase(isPortal, width) {
  const label = `${isPortal ? "portal" : "local"}-${width}`;
  const mobile = width < 640;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  const cdp = mobile ? await context.newCDPSession(page) : null;
  await page.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__qaPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__qaPeers.push(this); }
      createDataChannel(...args) { const channel = super.createDataChannel(...args); this.__qaChannel = channel; return channel; }
    };
  });
  const errors = [], pending = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  page.on("response", (response) => {
    if (response.url().endsWith("/operations/sessions.reserve")) pending.push(response.json().then((value) => {
      if (value.session?.id && value.leaseToken) leases.set(value.session.deviceId, { sessionId: value.session.id, leaseToken: value.leaseToken });
    }));
  });
  const down = async (point) => {
    if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
    else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  };
  const move = async (start, end) => {
    for (let step = 1; step <= 8; step++) {
      const point = { x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8 };
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] });
      else await page.mouse.move(point.x, point.y);
    }
  };
  const up = async () => {
    if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    else await page.mouse.up();
  };
  const tap = async (point) => { await down(point); await up(); };
  try {
    await page.goto(isPortal ? portal.url : await ticketUrl());
    if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
    for (const platform of platforms) {
      const feed = page.locator(`[data-feed-source="${platform.source}"]`);
      await expect.poll(() => feed.locator("video").evaluate((video) => video.readyState >= 2), { timeout: 35_000 }).toBe(true);
      await expect(feed.getByRole("button", { name: /^Touch(?: ·|$)/ })).toHaveCount(0);
      // A deliberately tall media box exercises actual object-fit letterboxing.
      // The production overlay must follow the contained pixels, not tile bounds.
      await feed.locator(".deck-live-preview").evaluate((element) => { element.style.height = "440px"; element.style.aspectRatio = "auto"; });
      await feed.locator("video").evaluate((element) => { element.style.height = "300px"; element.style.flex = "none"; });
      await feed.locator("video").scrollIntoViewIfNeeded();
      let frame = await geometry(feed);
      let start = at(frame, 0.25, 0.45), end = at(frame, 0.75, 0.65);
      const disabledBefore = (await gesturesFor(platform.id)).length;
      await tap(start);
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0);
      await page.waitForTimeout(350);
      assert.equal((await gesturesFor(platform.id)).length, disabledBefore, "Touch off sends no input or feedback.");
      await enable(page, feed, isPortal);
      await feed.locator("video").scrollIntoViewIfNeeded();
      frame = await geometry(feed); start = at(frame, 0.25, 0.45); end = at(frame, 0.75, 0.65);
      const verticalLetterbox = frame.top - frame.box.y >= 10;
      assert.ok(verticalLetterbox || frame.left - frame.box.x >= 10, "The QA media box must contain a letterbox.");
      const letterboxBefore = (await gesturesFor(platform.id)).length;
      const letterbox = verticalLetterbox ? { x: frame.box.x + frame.box.width / 2, y: frame.box.y + 4 } : { x: frame.box.x + 4, y: frame.box.y + frame.box.height / 2 };
      await tap(letterbox);
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0);
      await page.waitForTimeout(350);
      assert.equal((await gesturesFor(platform.id)).length, letterboxBefore, "Letterbox taps must be ignored.");

      const before = (await gesturesFor(platform.id)).length;
      await down(start);
      await expectContact(feed, start);
      await move(start, end);
      const contact = await expectContact(feed, end);
      const trail = feed.locator('.deck-touch-trace[data-touch-phase="active"] .deck-touch-trail');
      const points = await trail.getAttribute("points");
      assert.ok(points && points.trim().split(/\s+/).length >= 3, "A held swipe shows its travelled path.");
      await screenshot(page, `${label}-${platform.id}-held-drag.png`);
      await up();
      const released = feed.locator('.deck-touch-trace[data-touch-phase="released"]');
      await expect(released).toHaveCount(1);
      await page.waitForTimeout(260);
      assert.ok(await released.evaluate((element) => Number(getComputedStyle(element).opacity)) < 1, "Released feedback visibly fades before removal.");
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });
      await expect.poll(async () => (await gesturesFor(platform.id)).slice(before).some((event) => event.type === (platform.completed ? "swipe" : "up"))).toBe(true);
      const delivered = (await gesturesFor(platform.id)).slice(before);
      const first = delivered[0];
      assert.ok(Math.abs(first.x - 160) <= 2 && Math.abs(first.y - 162) <= 2, "Delivered input uses the same contained-frame origin.");
      if (platform.completed) {
        assert.equal(delivered.length, 1, "iOS dispatches one completed gesture.");
        assert.equal(first.type, "swipe");
        assert.ok(Math.abs(first.toX - 480) <= 2 && Math.abs(first.toY - 234) <= 2);
      } else assert.equal(delivered.at(-1).type, "up");

      await down(start);
      await expectContact(feed, start);
      await move(start, letterbox);
      await expect(feed.locator('.deck-touch-trace[data-touch-phase="cancelled"]')).toHaveCount(1);
      await screenshot(page, `${label}-${platform.id}-cancelled.png`);
      await up();
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });

      await down(start);
      await expectContact(feed, start);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0);
      await up();

      await tap(end);
      await expect(feed.locator('.deck-touch-trace[data-touch-phase="released"]')).toHaveCount(1);
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });

      await page.emulateMedia({ reducedMotion: "reduce" });
      await tap(end);
      const stillTrace = feed.locator('.deck-touch-trace[data-touch-phase="released"]');
      await expect(stillTrace).toHaveCount(1);
      assert.equal(await stillTrace.evaluate((element) => getComputedStyle(element).animationName), "none");
      assert.equal(await stillTrace.locator(".deck-touch-ring").evaluate((element) => getComputedStyle(element).animationName), "none");
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await down(start);
      await expectContact(feed, start);
      await feed.getByRole("switch", { name: "Enable touch", exact: true }).evaluate((element) => element.click());
      await expect(feed.locator('.deck-touch-trace[data-touch-phase="active"]')).toHaveCount(0);
      await up();
      await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked();
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });
      await enable(page, feed, isPortal);
      await feed.locator("video").scrollIntoViewIfNeeded();
      frame = await geometry(feed); start = at(frame, 0.25, 0.45);
      await down(start);
      await expectContact(feed, start);
      await feed.locator("video").evaluate((video) => {
        const track = video.srcObject.getVideoTracks()[0];
        const peer = window.__qaPeers.find((candidate) => candidate.getReceivers().some((receiver) => receiver.track?.id === track.id));
        if (!peer?.__qaChannel) throw new Error("Active synthetic control channel was not found.");
        peer.__qaChannel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", message: "Synthetic rejected gesture" }) }));
      });
      await expect(feed).toContainText("Synthetic rejected gesture");
      await expect(feed.locator('.deck-touch-trace[data-touch-phase="active"]')).toHaveCount(0);
      await up();
      await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked();
      await expect(feed.locator(".deck-touch-trace")).toHaveCount(0, { timeout: 2500 });
      results.cases.push({ name: `${label}-${platform.id}`, passed: true, realTouchscreen: mobile, letterboxing: true, heldContact: contact, trailSamples: points.trim().split(/\s+/).length, releasedFades: true, disabledSuppressesInput: true, cancellationVisible: true, blurClears: true, reducedMotion: true, rejectedInputDisarms: true, completedGesture: platform.completed });
      console.log(`PASS ${label}-${platform.id}: feedback alignment, trail, fade, cancellation, rejection, disabled input`);
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  } finally { await Promise.all(pending); await context.close(); await cleanupLeases(); }
}

try {
  fixture = await ready;
  assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
  assert.equal(fixture.token, "synthetic-qa-token");
  assert.equal(fixture.phoneControlsMode, true);
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  results.browser = browser.version();
  portal = await startPortal();
  await workspaceCase(false, 1440);
  await workspaceCase(true, 390);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser?.close();
  await cleanupLeases();
  await portal?.close();
  child.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000); })]);
  clearTimeout(timer);
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "fixture.log"), fixtureLog);
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Evidence: ${path.join(output, "results.json")}`);
}
