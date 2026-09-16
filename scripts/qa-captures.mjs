// Isolated capture workflow QA. Builds into /tmp and uses synthetic media only.
// Requires installed Google Chrome and ffmpeg. QA_CAPTURE_REUSE=1 reuses an
// explicitly started QA_CAPTURES=1 fixture without stopping that fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const output = path.resolve("outputs/capture-qa");
await mkdir(output, { recursive: true });
let fixtureProcess, browser, fixture, page;
const leases = new Map();
const results = { startedAt: new Date().toISOString(), cases: [], screenshots: [], passed: false };
async function startFixture() {
  if (process.env.QA_CAPTURE_REUSE === "1")
    return JSON.parse(await readFile(path.join(output, "fixture.json"), "utf8"));
  fixtureProcess = spawn(process.execPath, ["--import", "tsx", "scripts/qa-live-server.ts"], {
    env: { ...process.env, QA_CAPTURES: "1", QA_LIVE_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Capture fixture did not become ready.\n${log}`)), 90_000);
    for (const stream of [fixtureProcess.stdout, fixtureProcess.stderr]) stream.on("data", (data) => {
      log += data.toString();
      const ready = /LIVE_QA_READY (\{[^\n]+\})/.exec(log);
      if (ready) { clearTimeout(timer); resolve(JSON.parse(ready[1])); }
    });
    fixtureProcess.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Capture fixture exited (${code}).\n${log}`)); });
  });
}
async function api(name, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${name}`, { method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  assert(response.ok, `${name}: ${value.message || response.status}`);
  return value;
}
async function operation(name, action) {
  const pending = page.waitForResponse((response) => response.url().endsWith(`/v1/operations/${name}`));
  const [response] = await Promise.all([pending, action()]);
  const value = await response.json();
  assert(response.ok(), `${name}: ${value.message || response.status()}`);
  return value;
}
async function picture(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  results.screenshots.push(name);
}
async function remote() {
  await page.getByRole("button", { name: "Feeds", exact: true }).click();
  await page.getByRole("button", { name: "Remote · Synthetic USB feed", exact: true }).click();
  const controls = page.getByRole("region", { name: "Remote for Synthetic USB", exact: true });
  await controls.waitFor();
  const menu = controls.getByRole("button", { name: "Remote menu", exact: true });
  if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
  return controls;
}
function notifications() { return page.getByRole("complementary", { name: "Capture notifications" }); }

try {
  fixture = await startFixture();
  assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
  assert.equal(fixture.token, "synthetic-qa-token");
  assert.equal(fixture.capturesMode, true);
  const initial = await api("inventory");
  assert.equal(initial.devices.find((d) => d.id === "usb")?.name, "Synthetic USB");
  assert.equal(initial.devices.find((d) => d.id === "android")?.connection.serial, "qa-only-not-real");
  assert(initial.artifacts.some((a) => a.id === "seed-0"));
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  results.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().endsWith("/sessions.reserve")) void response.json().then((value) => {
      if (value.session?.id && value.leaseToken) leases.set(value.session.id, { sessionId: value.session.id, leaseToken: value.leaseToken });
    });
  });
  const ticket = await fetch(`${fixture.base}/v1/browser-ticket`, { method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
  await page.goto(`${fixture.base}/#ticket=${ticket.ticket}`);
  let controls = await remote();
  const screenshot = await operation("captures.screenshot", () => controls.getByRole("button", { name: "Reserve & take screenshot", exact: true }).click());
  assert.equal(screenshot.status, "completed");
  await expect(notifications().getByRole("link", { name: screenshot.name, exact: true })).toBeVisible();
  await picture("screenshot-completion-toast.png");
  await notifications().getByRole("link", { name: screenshot.name, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Name", { exact: true })).toHaveValue(screenshot.name);
  results.cases.push({ name: "screenshot-completion-link", passed: true, artifactId: screenshot.id });
  await page.keyboard.press("Escape");

  controls = await remote();
  const copied = await operation("captures.screenshot", () => controls.getByRole("button", { name: "Screenshot to clipboard", exact: true }).click());
  await expect(controls).toContainText("copied to this computer’s clipboard", { timeout: 15_000 });
  const clipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const png = items.find((item) => item.types.includes("image/png"));
    if (!png) return null;
    const blob = await png.getType("image/png"), bitmap = await createImageBitmap(blob);
    const result = { type: blob.type, bytes: blob.size, width: bitmap.width, height: bitmap.height };
    bitmap.close(); return result;
  });
  assert(clipboard && clipboard.bytes > 0 && clipboard.width === 640 && clipboard.height === 360);
  assert((await api("inventory")).artifacts.some((a) => a.id === copied.id && a.status === "completed"));
  results.cases.push({ name: "real-browser-image-clipboard", passed: true, artifactId: copied.id, clipboard });
  await picture("browser-clipboard-success.png");

  const recording = await operation("recordings.start", () => controls.getByRole("button", { name: "Start recording", exact: true }).click());
  await page.waitForTimeout(1100);
  await controls.getByRole("button", { name: "Stop recording…", exact: true }).click();
  const stopped = await operation("recordings.stop", () => controls.getByRole("button", { name: "Stop & save recording", exact: true }).click());
  assert.equal(stopped.id, recording.id);
  assert.equal(stopped.status, "completed");
  await expect(notifications().getByRole("link", { name: stopped.name, exact: true })).toBeVisible();
  await picture("recording-completion-toast.png");
  results.cases.push({ name: "recording-completion-toast", passed: true, artifactId: stopped.id, bytes: stopped.bytes });
  await controls.getByRole("button", { name: "Close remote", exact: true }).click();
  await libraryCase();
  assert.deepEqual(errors, []);
  results.browserErrors = errors;
  results.passed = true;
} catch (error) {
  results.failure = error instanceof Error ? error.stack : String(error);
  if (page) await picture("failure.png").catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const lease of leases.values()) await api("sessions.release", lease).catch(() => {});
  if (fixtureProcess && fixtureProcess.exitCode === null) {
    const closed = new Promise((resolve) => fixtureProcess.once("exit", resolve));
    fixtureProcess.kill("SIGTERM");
    const timer = setTimeout(() => fixtureProcess.kill("SIGKILL"), 15_000);
    await closed; clearTimeout(timer);
  }
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Capture QA evidence: ${path.join(output, "results.json")}`);
}

async function libraryCase() {
  await page.getByRole("button", { name: "Captures", exact: true }).click();
  const library = page.getByRole("region", { name: "Capture library", exact: true });
  await expect(library.getByRole("heading", { name: "Captures", exact: true })).toBeVisible();
  const rows = library.locator("tbody tr[data-capture-id]");
  const ids = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-capture-id")));
  await library.getByRole("searchbox", { name: "Search captures" }).fill("payments");
  await expect.poll(ids).toEqual(["seed-0", "seed-2"]);
  await library.getByRole("button", { name: "Clear capture search" }).click();
  await library.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filter captures", exact: true });
  await filters.getByRole("combobox", { name: "Capture platform" }).selectOption("Android");
  await filters.getByRole("combobox", { name: "Capture device" }).selectOption("android");
  await filters.getByRole("combobox", { name: "Capture type" }).selectOption("recording");
  await filters.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(ids).toEqual(["seed-1"]);
  await picture("library-filtered.png");
  await library.getByRole("button", { name: "Clear filters", exact: true }).click();
  await library.getByRole("columnheader").getByRole("button", { name: "Name", exact: true }).click();
  await expect(library.getByRole("columnheader").filter({ has: page.getByRole("button", { name: "Name", exact: true }) })).toHaveAttribute("aria-sort", "ascending");
  const ascending = await ids();
  assert.equal(ascending[0], "seed-0");
  assert.equal(ascending[1], "seed-1");
  await library.getByRole("columnheader").getByRole("button", { name: "Name", exact: true }).click();
  await expect.poll(ids).toEqual([...ascending].reverse());
  await library.getByRole("columnheader").getByRole("button", { name: "Name", exact: true }).click();
  results.cases.push({ name: "library-search-filters-sort", passed: true, combinedFilters: ["platform", "device", "type"], ascendingIds: ascending });

  await library.getByRole("button", { name: "Alpha screenshot", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Capture preview", exact: true });
  await expect(preview.getByRole("img", { name: "Alpha screenshot", exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Next capture", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(preview.getByLabel("Name", { exact: true })).toHaveValue("Bravo recording");
  await expect(preview.locator("video")).toBeVisible();
  await preview.locator("video").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(preview.getByLabel("Name", { exact: true })).toHaveValue("Alpha screenshot");
  await preview.getByRole("button", { name: "Next capture", exact: true }).click();
  await expect(preview.getByLabel("Name", { exact: true })).toHaveValue("Bravo recording");
  await preview.getByRole("button", { name: "Previous capture", exact: true }).click();
  await preview.getByLabel("Name", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(preview.getByLabel("Name", { exact: true })).toHaveValue("Alpha screenshot");
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "Alpha screenshot.png");
  await download.saveAs(path.join(output, "downloaded-alpha.png"));
  await picture("capture-preview.png");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  results.cases.push({ name: "preview-navigation-and-download", passed: true, keyboardArrows: true, videoFocusedArrowNavigation: true, buttons: true, editingRetainsArrows: true, filename: download.suggestedFilename() });

  await library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true }).check();
  await library.getByRole("checkbox", { name: "Select Charlie screenshot", exact: true }).check();
  const removed = await operation("captures.remove", () => library.getByRole("button", { name: "Move to trash", exact: true }).click());
  await expect.poll(async () => (await ids()).includes("seed-0")).toBe(false);
  await library.getByRole("button", { name: /^Trash \(/ }).click();
  await expect.poll(async () => (await ids()).sort()).toEqual(["seed-0", "seed-2", "seed-4"]);
  await library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true }).check();
  await library.getByRole("checkbox", { name: "Select Charlie screenshot", exact: true }).check();
  await operation("captures.restore", () => library.getByRole("button", { name: "Restore selected", exact: true }).click());
  await expect.poll(ids).toEqual(["seed-4"]);
  await library.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect.poll(async () => (await ids()).filter((id) => ["seed-0", "seed-2"].includes(id))).toEqual(["seed-0", "seed-2"]);
  results.cases.push({ name: "multiselect-trash-restore", passed: true, artifactIds: ["seed-0", "seed-2"] });

  const inventory = await api("inventory"), storage = await api("captures.storage");
  const expected = { bytes: 0, libraryBytes: 0, trashBytes: 0, files: 0 };
  const paths = new Set();
  for (const artifact of inventory.artifacts.filter((item) => !item.purgedAt)) {
    for (const file of [artifact.path, artifact.cleanPath, artifact.logPath].filter(Boolean)) {
      assert(file.startsWith(`${fixture.directory}/`), "Storage proof reads only synthetic fixture files.");
      if (paths.has(file)) continue;
      paths.add(file);
      const info = await stat(file);
      expected.bytes += info.size;
      expected[artifact.deletedAt ? "trashBytes" : "libraryBytes"] += info.size;
      expected.files++;
    }
  }
  for (const key of Object.keys(expected)) assert.equal(storage[key], expected[key], `Actual ${key} must include capture files and JSON sidecars.`);
  await expect(library.locator(".capture-storage-note")).toContainText(`${storage.files} managed files`);
  results.cases.push({ name: "actual-storage-totals", passed: true, ...storage });

  let folderRequest;
  await page.route("**/v1/operations/captures.openFolder", async (route) => {
    folderRequest = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ opened: true, folder: path.join(fixture.directory, "captures") }) });
  });
  await library.getByRole("button", { name: "Open folder on Mac", exact: true }).click();
  await expect.poll(() => folderRequest).toEqual({});
  results.cases.push({ name: "host-folder-action", passed: true, request: folderRequest, note: "Finder dispatch is covered by backend tests; browser request stub avoids opening host windows." });
  await picture("capture-library-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await picture("capture-library-mobile.png");
  results.mobileGeometry = await page.evaluate(() => ({
    viewport: window.innerWidth, document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")].map((element) => ({
      tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80),
      right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width,
      overflowX: getComputedStyle(element).overflowX,
    })).filter((entry) => entry.right > window.innerWidth + 1).slice(0, 30),
  }));
  assert(results.mobileGeometry.document <= results.mobileGeometry.viewport + 1, "Library must not cause page-wide horizontal overflow on mobile.");
}
