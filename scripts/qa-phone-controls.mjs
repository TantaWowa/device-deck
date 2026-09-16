// Starts its own synthetic daemon on an ephemeral loopback port. No real device
// discovery, device input, cloud account, or running Device Deck service is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const output = path.resolve("outputs/phone-controls-qa");
await mkdir(output, { recursive: true });
const results = { cases: [], passed: false };
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
async function holdNext(page, operation, matches = () => true) {
  let captured, release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  const pattern = `**/v1/operations/${operation}`;
  const handler = async (route) => {
    if (captured || !matches(route.request().postDataJSON())) return route.fallback();
    captured = route.request(); arrived(captured);
    const action = await gate;
    try { if (action === "abort") await route.abort("aborted"); else await route.continue(); }
    catch { /* A cancelled or unmounted viewer may already have aborted fetch. */ }
  };
  await page.route(pattern, handler);
  return {
    wait: async () => {
      let timer;
      try { return await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No ${operation} request reached the browser interceptor.`)), 30_000); })]); }
      finally { clearTimeout(timer); }
    },
    release: async (action = "continue") => { release(action); await page.unroute(pattern, handler); },
  };
}
const platforms = [
  { id: "android", source: "qa-native", name: "Synthetic Android", buttons: [["Back", "Back"], ["Home", "Home"], ["Recents", "Recents"], ["Volume down", "VolumeDown"], ["Volume up", "VolumeUp"], ["Power", "Power"]] },
  { id: "apple-sim", source: "qa-ios", name: "Synthetic Apple simulator", buttons: [["Home", "Home"], ["Lock", "Lock"], ["Side button", "SideButton"]] },
];
async function workspaceCase(isPortal, width) {
  const label = `${isPortal ? "portal" : "local"}-${width}`;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 640, isMobile: width < 640 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__qaPeers = [];
    window.__qaControlMessages = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__qaPeers.push(this); }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args), send = channel.send.bind(channel);
        channel.send = (value) => {
          if (typeof value === "string") window.__qaControlMessages.push(JSON.parse(value));
          return send(value);
        };
        return channel;
      }
    };
  });
  const errors = [], requests = [], streamRequests = [], responses = [], pending = [], failed = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  page.on("request", (request) => {
    if (request.url().endsWith("/operations/remote.input")) requests.push(request);
    if (/\/operations\/streams\.(open|close)$/.test(request.url())) streamRequests.push(request);
  });
  page.on("requestfailed", (request) => failed.add(request));
  page.on("response", (response) => {
    const name = response.url().split("/operations/")[1];
    if (name === "remote.input") responses.push(response);
    if (name === "sessions.reserve") pending.push(response.json().then((value) => {
      if (value.session?.id && value.leaseToken) leases.set(value.session.deviceId, { sessionId: value.session.id, leaseToken: value.leaseToken });
    }));
  });
  const feedFor = (platform) => page.locator(`[data-feed-source="${platform.source}"]`);
  const groupFor = (platform) => feedFor(platform).getByRole("group", { name: `Hardware buttons for ${platform.name}`, exact: true });
  const enable = async (platform) => {
    const feed = feedFor(platform), toggle = feed.getByRole("switch", { name: "Enable touch", exact: true });
    await toggle.click();
    if (!isPortal) await feed.getByRole("alertdialog").getByRole("button", { name: "Enable touch", exact: true }).click();
    await expect(groupFor(platform).getByRole("button", { name: "Home", exact: true })).toBeEnabled({ timeout: 35_000 });
    await expect(toggle).toBeChecked();
  };
  try {
    await page.goto(isPortal ? portal.url : await ticketUrl());
    if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
    const tv = page.locator('[data-feed-source="qa-usb"]');
    await expect(tv).toBeVisible();
    await expect(tv.getByRole("group", { name: /^Hardware buttons/ })).toHaveCount(0);
    for (const platform of platforms) {
      const feed = feedFor(platform), group = groupFor(platform);
      await expect(feed).toBeVisible();
      await expect(group).toHaveCount(0);
      await expect(feed.locator(".remote-ring")).toHaveCount(0);
      await expect(feed.getByRole("button", { name: /Remote/ })).toHaveCount(0);
      await expect.poll(() => feed.locator("video").evaluate((video) => video.readyState >= 2), { timeout: 35_000 }).toBe(true);
      // Hold signaling after the reservation exists: hardware actions must wait
      // for the live channel rather than treating possession of a lease as ready.
      const connection = await holdNext(page, "streams.open", (args) => args.deviceId === platform.id && args.control === true);
      await feed.getByRole("switch", { name: "Enable touch", exact: true }).click();
      await connection.wait();
      await expect(group).toBeVisible();
      assert.equal(await feed.locator("video").evaluate((video) => Boolean(video.srcObject && video.videoWidth)), true, "A touch handoff preserves the last displayed frame while signaling.");
      for (const button of await group.getByRole("button").all()) await expect(button).toBeDisabled();
      await connection.release();
      await expect(group.getByRole("button", { name: "Home", exact: true })).toBeEnabled({ timeout: 35_000 });
      assert.deepEqual(await group.getByRole("button").allTextContents(), platform.buttons.map(([label]) => label));
      await Promise.all(pending);
      const lease = leases.get(platform.id);
      assert.ok(lease, `Missing ${platform.id} lease.`);
      for (const [buttonLabel, key] of platform.buttons) {
        const before = (await inputs()).filter((event) => event.type === "key").length;
        const response = page.waitForResponse((response) => response.url().endsWith("/operations/remote.input"));
        await group.getByRole("button", { name: buttonLabel, exact: true }).click();
        assert.equal((await response).status(), 200);
        assert.deepEqual(requests.at(-1).postDataJSON(), { ...lease, key });
        await expect.poll(async () => (await inputs()).filter((event) => event.type === "key").length).toBe(before + 1);
        const delivered = (await inputs()).filter((event) => event.type === "key").at(-1);
        assert.equal(delivered.deviceId, platform.id);
        assert.equal(delivered.key, key);
      }
      const sizes = await group.getByRole("button").evaluateAll((buttons) => buttons.map((button) => ({ label: button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
      if (width < 640) assert.ok(sizes.every((size) => size.width >= 44 && size.height >= 44), JSON.stringify(sizes));
      await group.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${label}-${platform.id}.png`) });
      for (let cycle = 0; cycle < 2; cycle++) {
        await feed.getByRole("switch", { name: "Enable touch", exact: true }).uncheck();
        await expect(group).toHaveCount(0);
        await expect(feed.locator(".deck-live-placeholder")).toHaveCount(0, { timeout: 35_000 });
        await enable(platform);
        await expect(feed.locator(".deck-live-placeholder")).toHaveCount(0);
        await expect.poll(() => feed.locator("video").evaluate((video) => video.readyState >= 2)).toBe(true);
      }
      // Reproduce a transient browser ICE interruption without disturbing the
      // synthetic network. The same real peer/video must recover, not restart.
      const beforeReconnect = streamRequests.length;
      await feed.locator("video").evaluate((video) => {
        const track = video.srcObject.getVideoTracks()[0];
        const peer = window.__qaPeers.find((peer) => peer.getReceivers().some((receiver) => receiver.track?.id === track.id));
        if (!peer) throw new Error("Current video peer was not found.");
        window.__qaInterruptedPeer = peer;
        Object.defineProperty(peer, "connectionState", { configurable: true, get: () => "disconnected" });
        peer.dispatchEvent(new Event("connectionstatechange"));
      });
      await expect(group.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
      await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).toBeChecked();
      await expect(feed).toContainText("Connection interrupted");
      await feed.locator("video").dispatchEvent("playing");
      await expect(group.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const peer = window.__qaInterruptedPeer;
        delete peer.connectionState;
        peer.dispatchEvent(new Event("connectionstatechange"));
      });
      await expect(group.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
      assert.equal(streamRequests.length, beforeReconnect, "A transient interruption must not reopen or close the feed.");
    }
    const android = platforms[0], feed = feedFor(android), group = groupFor(android);
    const beforeOrdering = (await inputs()).length;
    const picture = feed.locator("video");
    await picture.scrollIntoViewIfNeeded();
    const frame = await picture.boundingBox();
    assert.ok(frame);
    const orderedKey = page.waitForResponse((response) => response.url().endsWith("/operations/remote.input"));
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await page.mouse.down();
    // A programmatic native click keeps the real pointer contact active while
    // selecting Home, exercising cancellation plus the ordered-channel barrier.
    await group.getByRole("button", { name: "Home", exact: true }).evaluate((button) => button.click());
    await page.mouse.up();
    assert.equal((await orderedKey).status(), 200);
    await expect.poll(async () => (await inputs()).slice(beforeOrdering).some((event) => event.type === "key")).toBe(true);
    await page.waitForTimeout(350);
    const ordered = (await inputs()).slice(beforeOrdering).filter((event) => event.deviceId === android.id && ["down", "move", "up", "key"].includes(event.type));
    assert.ok(ordered.some((event) => event.type === "down"), "The real data channel must have started the delayed gesture.");
    assert.equal(ordered.at(-1)?.type, "key", "Earlier pointer work must finish before the HTTP hardware key.");
    assert.equal(ordered.at(-1)?.key, "Home");
    const beforeBusy = requests.length;
    const beforeBusyEvents = (await inputs()).filter((event) => event.type === "key").length;
    const blocked = await holdNext(page, "remote.input");
    await group.getByRole("button", { name: "Home", exact: true }).click();
    await blocked.wait();
    for (const button of await group.getByRole("button").all()) await expect(button).toBeDisabled();
    await group.getByRole("button", { name: "Back", exact: true }).evaluate((button) => button.click());
    const beforeGesture = (await inputs()).filter((event) => event.deviceId === android.id && ["down", "up", "tap"].includes(event.type)).length;
    await feed.locator("video").click();
    await page.waitForTimeout(350);
    assert.equal(requests.length, beforeBusy + 1, "Pending controls must not queue a second key.");
    assert.equal((await inputs()).filter((event) => event.deviceId === android.id && ["down", "up", "tap"].includes(event.type)).length, beforeGesture, "Hardware keys pause gestures until completion.");
    await blocked.release();
    await expect(group.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
    await expect.poll(async () => (await inputs()).filter((event) => event.type === "key").length).toBe(beforeBusyEvents + 1);
    // Aborting while touch is switched off must discard pending work. Re-enable
    // requires a fresh deliberate action and must not replay the cancelled key.
    for (const action of ["off", "unmount"]) {
      const held = await holdNext(page, "remote.input");
      const count = requests.length;
      const delivered = (await inputs()).filter((event) => event.type === "key").length;
      await group.getByRole("button", { name: "Back", exact: true }).click();
      const request = await held.wait();
      if (action === "off") await feed.getByRole("switch", { name: "Enable touch", exact: true }).uncheck();
      else await page.getByRole("button", { name: /^Devices/ }).click();
      await expect(group).toHaveCount(0);
      await expect.poll(() => failed.has(request), { timeout: 5000 }).toBe(true);
      await held.release("abort");
      if (action === "unmount") await page.getByRole("button", { name: /^Feeds/ }).click();
      await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked();
      await enable(android);
      await page.waitForTimeout(350);
      assert.equal(requests.length, count + 1, `No key replay after ${action}.`);
      assert.equal((await inputs()).filter((event) => event.type === "key").length, delivered, `Cancelled key never reaches the synthetic device after ${action}.`);
    }
    assert.ok(responses.every((response) => response.status() === 200));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    if (width === 1440) {
      await feed.getByRole("switch", { name: "Enable touch", exact: true }).uncheck();
      const pattern = "**/v1/operations/streams.open";
      const oldAnswer = async (route) => {
        if (!route.request().postDataJSON().control) return route.fallback();
        const response = await route.fetch(), body = await response.json();
        delete body.supportsInputBarrier;
        await route.fulfill({ response, json: body });
        await page.unroute(pattern, oldAnswer);
      };
      await page.route(pattern, oldAnswer);
      await feed.getByRole("switch", { name: "Enable touch", exact: true }).click();
      if (!isPortal) await feed.getByRole("alertdialog").getByRole("button", { name: "Enable touch", exact: true }).click();
      await expect(feed.locator(".deck-touch-enabled")).toBeVisible({ timeout: 35_000 });
      await expect(group).toContainText("Update Device Deck");
      for (const button of await group.getByRole("button").all()) await expect(button).toBeDisabled();
      const markers = await page.evaluate(() => window.__qaControlMessages.filter((message) => message.type === "input-barrier").length);
      await group.getByRole("button", { name: "Home", exact: true }).evaluate((button) => button.click());
      const frames = await feed.locator("video").evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => feed.locator("video").evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames + 2);
      assert.equal(await page.evaluate(() => window.__qaControlMessages.filter((message) => message.type === "input-barrier").length), markers, "Older daemons must never receive unsupported input markers.");
      // A recovery grace is bounded: a persistent interruption must still turn
      // touch off, close its peer, and never replay any hardware action.
      const delivered = (await inputs()).filter((event) => event.type === "key").length;
      await feed.locator("video").evaluate((video) => {
        const track = video.srcObject.getVideoTracks()[0];
        const peer = window.__qaPeers.find((peer) => peer.getReceivers().some((receiver) => receiver.track?.id === track.id));
        if (!peer) throw new Error("Current video peer was not found.");
        Object.defineProperty(peer, "connectionState", { configurable: true, get: () => "disconnected" });
        peer.dispatchEvent(new Event("connectionstatechange"));
      });
      await expect(feed).toContainText("Connection interrupted");
      await expect(feed.getByRole("switch", { name: "Enable touch", exact: true })).not.toBeChecked({ timeout: 8000 });
      await expect(group).toHaveCount(0);
      await expect(feed.locator(".deck-live-placeholder")).toHaveCount(0, { timeout: 35_000 });
      assert.equal((await inputs()).filter((event) => event.type === "key").length, delivered, "Expired reconnect grace must not replay hardware input.");
    }
    results.cases.push({ name: label, platformKeysAndLeases: true, connectionGating: true, repeatTouchHandoffs: true, retainedFrameDuringHandoff: true, transientReconnectKeepsPeer: true, ...(width === 1440 ? { olderDaemonStillStreamsWithoutHardwareMarkers: true, persistentDisconnectDisablesTouch: true } : {}), earlierGestureFinishesBeforeKey: true, pendingDropsInput: true, gesturesPauseDuringKey: true, offAndUnmountAbortWithoutReplay: true, mobileTargets: width < 640 ? "at least 44px" : "desktop", noPhoneDpad: true });
    console.log(`PASS ${label}: platform keys, leases, connection gating, cancellation, no replay, touch targets`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${label}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await Promise.all(pending); await context.close(); await cleanupLeases();
  }
}
try {
  fixture = await ready;
  assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
  assert.equal(fixture.token, "synthetic-qa-token");
  assert.equal(fixture.phoneControlsMode, true);
  assert.ok((await api("inventory")).devices.every((device) => device.name.startsWith("Synthetic ")));
  portal = await startPortal();
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  for (const isPortal of [false, true]) for (const width of [1440, 390]) await workspaceCase(isPortal, width);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser?.close();
  if (fixture) await cleanupLeases();
  await portal?.close();
  child.kill("SIGTERM");
  let killTimer;
  await Promise.race([exited, new Promise((resolve) => { killTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000); })]);
  clearTimeout(killTimer);
  await writeFile(path.join(output, "fixture.log"), fixtureLog);
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Evidence: ${output}`);
}
