// Device-type filters against an isolated synthetic fixture; no native devices,
// sessions or live encoders. Only bounded capture thumbnails invoke ffmpeg.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { captureViewCase } from "./capture-view-qa.mjs";

const output = path.resolve("outputs/device-type-qa");
await mkdir(output, { recursive: true });
const results = { startedAt: new Date().toISOString(), cases: [], passed: false };
let fixture, fixtureProcess, browser, portal, currentPage;
async function startFixture() {
  fixtureProcess = spawn(process.execPath, ["--import", "tsx", "scripts/qa-live-server.ts"], {
    env: { ...process.env, QA_CAPTURES: "1", QA_PHONE_CONTROLS: "1", QA_FORM_FACTOR: "1", QA_LIVE_PORT: "0", QA_LIVE_OUTPUT: output }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out\n${log}`)), 90_000);
    for (const stream of [fixtureProcess.stdout, fixtureProcess.stderr]) stream.on("data", (data) => {
      log += data.toString();
      const ready = /LIVE_QA_READY (\{[^\n]+\})/.exec(log);
      if (ready) { clearTimeout(timer); resolve(JSON.parse(ready[1])); }
    });
    fixtureProcess.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}\n${log}`)); });
  });
}
async function api(operation, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${operation}`, { method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" }, body: JSON.stringify(args) });
  assert(response.ok, `${operation} failed: ${await response.clone().text()}`);
  return response.json();
}
async function ticketUrl() {
  const result = await fetch(`${fixture.base}/v1/browser-ticket`, { method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json());
  return `${fixture.base}/#ticket=${result.ticket}`;
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
        assert.equal(request.headers.authorization, "Bearer fixture-grant");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(fixture.base + request.url, { method: request.method, headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" }, body: request.method === "POST" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(30_000) });
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
const formFactors = [
  ["tv", ["Synthetic USB"], ["qa-usb"], ["Synthetic USB feed"]],
  ["phone", ["Synthetic Android", "Synthetic Android emulator", "Synthetic Apple simulator"], ["qa-native"], ["Synthetic Android screen", "Synthetic Android emulator", "Synthetic iPhone screen"]],
  ["other", ["Synthetic Other"], ["qa-other"], ["Synthetic Other feed"]],
];
async function geometry(page, label) {
  const value = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "fixed").slice(0, 8).map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })) }));
  assert(value.document <= value.viewport + 1, `${label} overflow: ${JSON.stringify(value)}`);
  return { viewport: value.viewport, document: value.document };
}
async function workspaceCase(page, isPortal, width) {
  const label = `${isPortal ? "portal" : "local"}-${width}`;
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.getByRole("button", { name: /^Devices(?:\s|$)/ }).click();
  const filter = page.getByRole("combobox", { name: "Filter device type", exact: true });
  await filter.selectOption("");
  const deviceNames = () => page.locator(isPortal ? ".device-card h2" : "tbody .live-device-name").allTextContents().then((names) => names.sort());
  await expect.poll(deviceNames).toEqual(["Synthetic Android", "Synthetic Android emulator", "Synthetic Apple simulator", "Synthetic Other", "Synthetic USB"]);
  if (!isPortal) await page.getByRole("checkbox", { name: "Select Synthetic USB", exact: true }).check();
  for (const [value, expected] of formFactors) {
    await filter.selectOption(value);
    await expect.poll(deviceNames).toEqual([...expected].sort());
  }
  await filter.selectOption("tv");
  if (!isPortal) await expect(page.getByRole("checkbox", { name: "Select Synthetic USB", exact: true })).toBeChecked();
  const devicesGeometry = await geometry(page, `${label} devices`);
  await page.screenshot({ path: path.join(output, `${label}-devices-tv.png`), fullPage: true });
  await filter.selectOption("");
  await page.getByRole("button", { name: /^Feeds(?:\s|$)/ }).click();
  await filter.selectOption("");
  const picker = page.getByRole("dialog", { name: "Choose feeds", exact: true });
  const openPicker = () => page.getByRole("button", { name: /^Choose feeds/ }).first().click();
  const closePicker = () => picker.getByRole("button", { name: isPortal ? "Close feed picker" : "Close feed selector", exact: true }).click();
  const feedNames = () => picker.locator(isPortal ? ".portal-feed-option strong" : ".feed-selector-row strong").allTextContents().then((names) => names.sort());
  const feeds = () => page.locator("[data-feed-source]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-feed-source")).sort());
  await openPicker();
  const ios = isPortal ? picker.locator(".portal-feed-option").filter({ has: page.getByText("Synthetic iPhone screen", { exact: true }) }).getByRole("checkbox") : picker.getByRole("checkbox", { name: "Show Synthetic iPhone screen", exact: true });
  await ios.uncheck();
  await closePicker();
  for (const [value, , expected, options] of formFactors) {
    await filter.selectOption(value);
    await expect.poll(feeds).toEqual(expected);
    await openPicker();
    await expect.poll(feedNames).toEqual([...options].sort());
    if (value === "phone") await expect(ios).not.toBeChecked();
    await geometry(page, `${label} ${value} chooser`);
    await closePicker();
  }
  await filter.selectOption("");
  await expect.poll(feeds).toEqual(["qa-native", "qa-other", "qa-usb"]);
  const feedsGeometry = await geometry(page, `${label} feeds`);
  await page.screenshot({ path: path.join(output, `${label}-feeds-all.png`), fullPage: true });
  results.cases.push({ name: label, passed: true, deviceTypes: formFactors.map(([value]) => value), selectedFeedsPreserved: true, deviceSelectionPreserved: !isPortal, chooserFiltered: true, devicesGeometry, feedsGeometry });
}
async function launchFilterRace(page, isPortal) {
  if (!isPortal) await page.getByRole("button", { name: "Feeds", exact: true }).click();
  const filter = page.getByRole("combobox", { name: "Filter device type", exact: true });
  await filter.selectOption("phone");
  await page.getByRole("button", { name: /^Choose feeds/ }).first().click();
  const requested = page.waitForRequest((request) => request.url().endsWith("/operations/devices.simulator") && request.postDataJSON()?.action === "launch");
  await page.getByRole("dialog", { name: "Choose feeds", exact: true }).getByRole("button", { name: "Launch Synthetic Android emulator and show feed", exact: true }).click();
  await requested;
  await filter.selectOption("tv");
  await expect(filter).toHaveValue("tv");
  await expect(filter).toHaveValue("", { timeout: 15_000 });
  await expect(page.locator('[data-feed-source="native-android-sim"]')).toBeVisible();
  results.cases.push({ name: `${isPortal ? "portal" : "local"}-launch-filter-race`, passed: true, completedPhoneRevealed: true, incompatibleTvFilterCleared: true });
  await api("devices.simulator", { deviceId: "android-sim", action: "close", confirmed: true });
}
async function filterOnlyPage() {
  const page = currentPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const snapshot = await readFile(path.join(fixture.directory, "fixture.png"));
  await page.route("**/v1/operations/streams.open", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ code: "unsupported-capability", message: "Synthetic filter-only QA uses snapshot fallback." }) }));
  for (const pattern of ["**/v1/preview/**", "**/v1/source-preview/**"])
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "image/png", body: snapshot }));
  return page;
}
try {
  fixture = await startFixture();
  assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
  assert.equal(fixture.token, "synthetic-qa-token");
  assert(fixture.capturesMode && fixture.phoneControlsMode && fixture.formFactorMode);
  assert((await api("inventory")).devices.every((device) => device.name.startsWith("Synthetic ")));
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  results.browser = browser.version();
  portal = await startPortal();
  for (const isPortal of [false, true]) {
    const page = await filterOnlyPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(isPortal ? portal.url : await ticketUrl());
    for (const width of [1440, 390]) await workspaceCase(page, isPortal, width);
    await page.setViewportSize({ width: 1440, height: 1000 });
    results.cases.push(await captureViewCase({ page, output, label: isPortal ? "portal" : "local", otherCaptureIds: ["seed-5"], openLibrary: () => page.getByRole("button", { name: /^Captures(?:\s|$)/ }).click() }));
    assert.deepEqual(errors, []);
    await page.close(); currentPage = undefined;
  }
  for (const isPortal of [false, true]) {
    const page = await filterOnlyPage();
    await page.goto(isPortal ? portal.url : await ticketUrl());
    await launchFilterRace(page, isPortal);
    await page.close(); currentPage = undefined;
  }
  assert.equal((await api("inventory")).sessions.filter((session) => session.state !== "closed").length, 0);
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  await currentPage?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await portal?.close();
  if (fixtureProcess && fixtureProcess.exitCode === null) {
    const closed = new Promise((resolve) => fixtureProcess.once("exit", resolve));
    fixtureProcess.kill("SIGTERM");
    const timer = setTimeout(() => fixtureProcess.kill("SIGKILL"), 15_000);
    await closed; clearTimeout(timer);
  }
  results.fixtureCleanedUp = fixture ? await stat(fixture.directory).then(() => false, () => true) : undefined;
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Device-type QA: ${path.join(output, "results.json")}`);
}
