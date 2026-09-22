// Actual local App bundle, static loopback server and mocked HTTP routes only.
// Never starts the daemon or discovers, reserves, or controls any device.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const directory = await mkdtemp(path.join(os.tmpdir(), "deck-connection-qa-"));
const output = path.resolve("outputs/connection-screen-qa");
await mkdir(output, { recursive: true });
const snapshot = {
  mode: "local", devices: [], sources: [], sessions: [], artifacts: [], events: [], inputs: [], recordings: [], diagnostics: [],
  configRevision: "synthetic-connection-qa", configError: null,
  license: { tier: "free", state: "free", configured: false, message: "Synthetic connection QA", features: [], maxSessions: 1 },
  config: { schemaVersion: 1, port: 0, devices: [], sources: [], tools: {}, savedViews: [], settings: { folder: "/synthetic/captures", naming: "{device}-{time}", owner: "Connection QA", ttl: 15, overlay: true, logging: true, clipboard: false, captureMode: "clean", maxRecordingMinutes: 15, previewIntervalMs: 750 } },
  reports: { range: { preset: "day", start: "2026-09-17", end: "2026-09-17", startMs: 0, endMs: 0, asOf: 0, timeZone: "UTC" }, sessions: 0, reservedMs: 0, contentions: 0, captureAttempts: 0, captureFailures: 0, devices: [], owners: [], daily: [] },
};
let browser, currentPage, base;
const results = { startedAt: new Date().toISOString(), passed: false, cases: [], browserErrors: [] };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>');
    } else if (["/app.js", "/app.css"].includes(pathname)) {
      response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(await readFile(path.join(directory, pathname.slice(1))));
    } else { response.writeHead(404); response.end(); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
const deferred = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function fixture({ bootstrap, inventory, operation, width = 1280, reducedMotion, clock = false, hidden = false } = {}) {
  const page = currentPage = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 }, reducedMotion });
  page.setDefaultTimeout(10_000);
  if (clock) await page.clock.install();
  await page.addInitScript((hidden) => {
    window.syntheticHidden = hidden;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.syntheticHidden });
    window.setSyntheticHidden = (hidden) => { window.syntheticHidden = hidden; document.dispatchEvent(new Event("visibilitychange")); };
  }, hidden);
  const requests = { bootstrap: 0, inventory: 0 };
  const operations = [];
  page.on("pageerror", (error) => results.browserErrors.push(error.message));
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/v1/operations/")) operations.push({ name: pathname.split("/v1/operations/")[1], args: route.request().postDataJSON() });
    if (pathname === "/v1/bootstrap") { requests.bootstrap++; if (bootstrap) return bootstrap(route, requests); return json(route, { ok: true }); }
    if (pathname === "/v1/operations/inventory") { requests.inventory++; if (inventory) return inventory(route, requests); return json(route, snapshot); }
    if (pathname === "/v1/hub/status") return json(route, { paired: false });
    if (pathname === "/v1/operations/capture-cards.list") { requests.cards = (requests.cards || 0) + 1; return json(route, { sources: [], diagnostics: [] }); }
    if (operation && pathname.startsWith("/v1/operations/")) return operation(route, pathname.split("/v1/operations/")[1]);
    return json(route, { message: `Unexpected synthetic endpoint ${pathname}` }, 404);
  });
  return { page, requests, operations };
}
const connecting = (page) => page.getByRole("heading", { name: "Connecting to Device Deck", exact: true });
const failed = (page) => page.getByRole("heading", { name: /couldn.t connect to device deck/i });
const moreInfo = (page) => page.getByRole("button", { name: /(?:more|less) info/i });
async function loaded(page) {
  await expect(page.locator(".live-app")).toBeVisible();
  await expect(connecting(page)).toHaveCount(0);
  await expect(failed(page)).toHaveCount(0);
}
async function failureDetails(page) {
  await expect(failed(page)).toBeVisible();
  await expect(moreInfo(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("devdeck start", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
}
async function picture(page, name) { await page.screenshot({ path: path.join(output, name), fullPage: true }); }
async function close(page) { await page.close(); currentPage = undefined; }
try {
  await build({ entryPoints: ["apps/web/src/local/main.tsx"], bundle: true, format: "esm", jsx: "automatic", outfile: path.join(directory, "app.js") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  results.browser = browser.version();

  {
    const { page, operations } = await fixture({ operation: (route, name) => json(route, name === "discover" ? { devices: [], sources: [], diagnostics: [] } : {}) });
    await page.goto(base); await loaded(page);
    await page.getByRole("button", { name: "Capture Cards", exact: true }).click();
    const manual = page.getByRole("button", { name: "Discover / refresh", exact: true });
    await expect(manual).toBeEnabled();
    await manual.click();
    await expect.poll(() => operations.filter((request) => request.name === "capture-cards.list").length).toBe(2);
    assert.deepEqual(operations.filter((request) => request.name === "capture-cards.list").map((request) => request.args), [{}, { refresh: true }]);
    await page.locator(".live-sidebar").getByRole("button", { name: /^Devices/ }).click();
    await page.getByRole("button", { name: "Discover / add devices", exact: true }).click();
    await expect.poll(() => operations.filter((request) => request.name === "discover").length).toBe(1);
    assert.deepEqual(operations.find((request) => request.name === "discover").args, { refresh: true });
    results.cases.push({ name: "explicit-discovery-intent", passed: true, ordinaryReadsRemainCached: true });
    await close(page);
  }
  {
    let launched = false, afterLaunch = 0;
    const config = { id: "waiting-sim", name: "Synthetic Waiting Simulator", platform: "Apple", kind: "virtual", model: "QA", visibility: "local", connection: { type: "simulator", udid: "ea415a3a-39fa-4dcb-a028-a5260f5156c3", os: "ios" }, captureSourceId: "native-waiting" };
    const source = { id: "native-waiting", name: "Synthetic Waiting Screen", kind: "native", deviceId: config.id };
    const { page } = await fixture({
      inventory: (route) => {
        const ready = launched && ++afterLaunch >= 3;
        const device = { ...config, online: ready, locked: false, capabilities: ready ? ["preview"] : [], healthDetail: ready ? "Ready" : "Checking status", simulatorState: ready ? "booted" : "shutdown", observation: { observedAt: ready || !launched ? Date.now() : null, stale: launched && !ready, refreshing: launched && !ready, error: null, nextRefreshAt: 0 } };
        return json(route, { ...snapshot, devices: [device], sources: [{ ...source, status: ready ? "connected" : launched ? "unknown" : "missing" }], config: { ...snapshot.config, devices: [config], sources: [source] } });
      },
      operation: (route, name) => {
        if (name === "devices.simulator") { launched = true; return json(route, { deviceId: config.id, action: "launch", state: "booted", changed: true }); }
        return json(route, { message: "Synthetic preview unavailable; this case only checks feed selection." }, 503);
      },
    });
    await page.goto(`${base}/?view=feeds&sources=`); await loaded(page);
    await page.getByRole("button", { name: "Start simulator", exact: true }).click();
    await page.getByRole("button", { name: `Launch ${config.name} and show feed`, exact: true }).click();
    await expect(page.locator(".feed-launch-status")).toContainText("Waiting for its updated screen status");
    await expect(page.locator(".feed-launch-error,.feed-selector-error")).toHaveCount(0);
    await expect(page.locator('[data-feed-source="native-waiting"]')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator(".feed-launch-error,.feed-selector-error")).toHaveCount(0);
    assert.ok(afterLaunch >= 3, "Feed reveal waits through checking snapshots for published readiness");
    results.cases.push({ name: "successful-launch-awaits-inventory", passed: true, checkingReads: afterLaunch - 1 });
    await close(page);
  }

  if (process.env.QA_CONNECTION_FOCUS !== "refresh") {

  {
    const { page, requests } = await fixture({ hidden: true });
    await page.goto(base);
    await page.waitForTimeout(2800);
    assert.equal(requests.inventory, 0, "A hidden mount must not create inventory demand");
    await page.evaluate(() => window.setSyntheticHidden(false));
    await loaded(page);
    await page.getByRole("button", { name: "Capture Cards", exact: true }).click();
    await expect.poll(() => requests.cards).toBe(1);
    await page.evaluate(() => window.setSyntheticHidden(true));
    const before = { ...requests };
    await page.waitForTimeout(10_500);
    assert.deepEqual(requests, before, "Inventory and card discovery stop while hidden");
    await page.evaluate(() => window.setSyntheticHidden(false));
    await expect.poll(() => requests.inventory).toBe(before.inventory + 1);
    await expect.poll(() => requests.cards).toBe(before.cards + 1);
    await page.context().setOffline(true);
    const offline = { ...requests };
    await page.waitForTimeout(2800);
    assert.deepEqual(requests, offline);
    await page.context().setOffline(false);
    await expect.poll(() => requests.inventory).toBe(offline.inventory + 1);
    await expect.poll(() => requests.cards).toBe(offline.cards + 1);
    results.cases.push({ name: "hidden-offline-inventory-and-cards", passed: true, immediateResume: true, noCatchup: true });
    await close(page);
  }
  {
    const gate = deferred();
    const { page, requests } = await fixture({ inventory: async (route, calls) => { if (calls.inventory === 1) await gate.promise; await json(route, snapshot).catch(() => {}); } });
    await page.goto(base);
    await expect.poll(() => requests.inventory).toBe(1);
    await page.evaluate(() => window.setSyntheticHidden(true));
    gate.release();
    await page.waitForTimeout(300);
    await expect(connecting(page)).toBeVisible();
    await expect(failed(page)).toHaveCount(0);
    await page.evaluate(() => window.setSyntheticHidden(false));
    await loaded(page);
    assert.equal(requests.inventory, 2);
    results.cases.push({ name: "hide-aborts-pending-inventory", passed: true, lateResultIgnored: true });
    await close(page);
  }

  {
    const gate = deferred();
    const { page, requests } = await fixture({ bootstrap: async (route) => { await gate.promise; await json(route, { ok: true }); } });
    await page.goto(`${base}/#ticket=synthetic-launch-ticket`);
    await expect(connecting(page)).toBeVisible();
    await expect(moreInfo(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("devdeck start", { exact: false })).not.toBeVisible();
    await page.waitForTimeout(2800);
    assert.equal(requests.bootstrap, 1);
    assert.equal(requests.inventory, 0, "Inventory cannot race the bootstrap cookie exchange.");
    await moreInfo(page).click();
    await expect(moreInfo(page)).toHaveAttribute("aria-expanded", "true");
    await expect(connecting(page)).toBeVisible();
    await picture(page, "connecting-more-info.png");
    gate.release();
    await loaded(page);
    assert.equal(requests.inventory, 1);
    assert.equal(new URL(page.url()).hash, "", "Launch tickets must leave the URL.");
    await expect.poll(() => requests.inventory, { timeout: 4000 }).toBeGreaterThanOrEqual(2);
    results.cases.push({ name: "delayed-bootstrap-gates-inventory", passed: true, delayedMs: 2800, moreInfoDoesNotCancel: true, pollingResumesAfterReady: true });
    await close(page);
  }
  {
    const gate = deferred();
    const { page, requests } = await fixture({ width: 390, reducedMotion: "reduce", inventory: async (route) => { await gate.promise; await json(route, snapshot); } });
    await page.goto(base);
    await expect(connecting(page)).toBeVisible();
    await expect(moreInfo(page)).toHaveAttribute("aria-expanded", "false");
    await page.waitForTimeout(2800);
    assert.deepEqual(requests, { bootstrap: 0, inventory: 1 });
    assert.equal(await page.locator(".connection-spinner").evaluate((spinner) => getComputedStyle(spinner).animationName), "none");
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert(geometry.document <= geometry.viewport + 1);
    await picture(page, "connecting-mobile-reduced-motion.png");
    await moreInfo(page).click();
    await expect(page.getByText("devdeck start", { exact: false })).toBeVisible();
    gate.release(); await loaded(page);
    results.cases.push({ name: "delayed-inventory-mobile-reduced-motion", passed: true, geometry, noOverlappingPolls: true, reducedMotionStopsAnimation: true });
    await close(page);
  }
  for (const failure of ["inventory-401", "inventory-network", "bootstrap-expired"]) {
    let recovered = false;
    const { page, requests } = await fixture({
      bootstrap: (route) => failure === "bootstrap-expired" && !recovered ? json(route, { message: "Invalid ticket" }, 403) : json(route, { ok: true }),
      inventory: (route) => recovered ? json(route, snapshot) : failure !== "inventory-network" ? json(route, { message: "Open the dashboard with devdeck ui." }, 401) : route.abort("connectionrefused"),
    });
    await page.goto(`${base}/${failure === "bootstrap-expired" ? "#ticket=expired-synthetic-ticket" : ""}`);
    await failureDetails(page);
    if (failure === "bootstrap-expired") {
      await expect(page.getByText(/launch link expired/i)).toBeVisible();
      assert.equal(requests.inventory, 0);
    }
    await picture(page, `${failure}.png`);
    if (failure === "bootstrap-expired") {
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await failureDetails(page);
      await expect(page.getByText("Open the dashboard with devdeck ui.", { exact: true })).toBeVisible();
      assert.equal(requests.bootstrap, 1, "Reload cannot reuse an expired, stripped launch ticket.");
      recovered = true;
      await page.goto(`${base}/#ticket=fresh-synthetic-ticket`);
      await loaded(page);
      results.cases.push({ name: failure, passed: true, automaticallyExpandedDetails: true, freshTicketRequired: true, freshLinkRecovery: true });
      await close(page);
      continue;
    }
    recovered = true;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await loaded(page);
    results.cases.push({ name: failure, passed: true, automaticallyExpandedDetails: true, reloadRecovery: true });
    await close(page);
  }
  for (const target of ["bootstrap", "inventory"]) {
    const gate = deferred();
    const started = deferred();
    const { page, requests } = await fixture({ clock: true, [target]: async (route) => { started.release(); await gate.promise; await json(route, target === "bootstrap" ? { ok: true } : snapshot).catch(() => {}); } });
    await page.goto(`${base}/${target === "bootstrap" ? "#ticket=timeout-synthetic-ticket" : ""}`);
    await started.promise;
    await expect(connecting(page)).toBeVisible();
    const began = Date.now();
    await page.clock.fastForward(target === "bootstrap" ? 15_100 : 30_100);
    // AbortSignal.timeout may use Chromium's native active-time timer rather
    // than page Clock. In that case wait for the real, bounded deadline.
    await expect(failed(page)).toBeVisible({ timeout: target === "bootstrap" ? 18_000 : 33_000 });
    await failureDetails(page);
    await expect(page.getByText(/timed out|taking too long|did not respond|too long to respond/i)).toBeVisible();
    if (target === "bootstrap") assert.equal(requests.inventory, 0);
    results.cases.push({ name: `${target}-timeout`, passed: true, elapsedAfterClockMs: Date.now() - began });
    gate.release(); await close(page);
  }
  }
  assert.deepEqual(results.browserErrors, []);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  await currentPage?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Connection screen QA: ${results.passed ? "PASS" : "FAIL"} (${results.cases.length} cases)`);
}
