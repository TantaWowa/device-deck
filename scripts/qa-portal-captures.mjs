// Run while the isolated capture QA fixture is running. Never contacts real devices.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { captureViewCase } from "./capture-view-qa.mjs";

const output = path.resolve("outputs/capture-qa");
const focusedPreview = process.env.QA_PORTAL_CAPTURE_FOCUS === "stale-preview";
const fixture = JSON.parse(await readFile(path.join(output, "fixture.json"), "utf8"));
assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
assert.equal(fixture.token, "synthetic-qa-token");
await mkdir(output, { recursive: true });
async function api(name, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${name}`, {
    method: "POST", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${name}: ${data.message || response.status}`);
  return data;
}
assert.ok((await api("inventory")).devices.every((device) => device.name.startsWith("Synthetic ")));
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
      const upstream = await fetch(fixture.base + request.url, {
        method: request.method, headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" },
        body: request.method === "POST" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(90_000),
      });
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
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
await context.addInitScript(() => {
  // Exercise deferred ClipboardItem PNG loading without replacing the user's OS clipboard.
  window.__captureClipboard = [];
  window.__denyCaptureClipboard = false;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async (items) => {
    if (window.__denyCaptureClipboard) throw new DOMException("Synthetic permission denial", "NotAllowedError");
    const blob = await items[0].getType("image/png");
    window.__captureClipboard.push({ type: blob.type, size: blob.size });
  } } });
});
const page = await context.newPage();
const errors = [], operations = [], pending = [], leases = new Map();
const result = { passed: false, cases: [], clipboard: "Browser API instrumented; OS clipboard untouched" };
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  const operation = response.url().split("/v1/operations/")[1];
  if (!operation) return;
  operations.push({ operation, status: response.status(), args: response.request().postDataJSON() });
  if (operation === "sessions.reserve" || operation === "sessions.takeover") pending.push(response.json().then((data) => {
    if (data.session?.id && data.leaseToken) leases.set(data.session.id, { sessionId: data.session.id, leaseToken: data.leaseToken });
  }));
});
async function openRemote() {
  await page.getByRole("button", { name: /^Feeds/ }).click();
  await page.locator('[data-feed-source="qa-usb"]').getByRole("button", { name: "Remote", exact: true }).click();
  const remote = page.getByRole("region", { name: "Remote for Synthetic USB", exact: true });
  await remote.getByRole("button", { name: "Remote menu", exact: true }).click();
  return remote;
}
async function screenshot(remote, clipboard = false) {
  const response = page.waitForResponse((item) => item.url().endsWith("/operations/captures.screenshot"));
  await remote.getByRole("button", { name: clipboard ? "Screenshot to clipboard" : "Screenshot", exact: true }).click();
  const completed = await response;
  assert.equal(completed.status(), 200);
  const artifact = await completed.json();
  await expect(page.locator(`.capture-toast a[href="#capture=${artifact.id}"]`)).toBeVisible();
  return artifact;
}
async function stalePreviewFeedbackCase() {
  const artifact = (await api("inventory")).artifacts
    .filter((item) => item.kind === "screenshot" && item.status === "completed" && !item.deletedAt && !item.purgedAt)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  assert.ok(artifact, "The isolated fixture needs a completed screenshot.");
  await page.getByRole("button", { name: /^Captures/ }).click();
  await page.getByRole("region", { name: "Capture library", exact: true }).getByRole("button", { name: "List view", exact: true }).click();
  await page.locator(`[data-capture-id="${artifact.id}"]`).getByRole("button", { name: artifact.name, exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Capture preview", exact: true });
  await expect(preview.locator("img")).toBeVisible();
  for (const action of ["Copy image", "Download file"]) for (const fail of [false, true]) {
    let begin, release, finished;
    const requested = new Promise((resolve) => { begin = resolve; });
    const delayed = new Promise((resolve) => { release = resolve; });
    const settled = new Promise((resolve) => { finished = resolve; });
    const pattern = `**/v1/artifacts/${artifact.id}/file`;
    const handler = async (route) => {
      begin(); await delayed;
      try {
        if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic delayed image failure" }) });
        else await route.continue();
      } catch { /* Browser cleanup can cancel an intercepted fetch. */ }
      finally { finished(); }
    };
    await page.route(pattern, handler);
    const clipboardBefore = await page.evaluate(() => window.__captureClipboard.length);
    const downloadFinished = action === "Download file" && !fail ? page.waitForEvent("download", { timeout: 15_000 }) : null;
    await preview.getByRole("button", { name: action, exact: true }).click();
    await requested;
    const next = preview.getByRole("button", { name: "Next capture", exact: true });
    const forwards = await next.isEnabled();
    await (forwards ? next : preview.getByRole("button", { name: "Previous capture", exact: true })).click();
    await expect(preview.getByRole("textbox", { name: "Name", exact: true })).not.toHaveValue(artifact.name);
    release(); await settled;
    if (downloadFinished) assert.ok((await downloadFinished).suggestedFilename().endsWith(".png"), "The explicitly requested file still downloads after navigating.");
    if (action === "Copy image" && !fail)
      await expect.poll(() => page.evaluate(() => window.__captureClipboard.length)).toBe(clipboardBefore + 1);
    await page.waitForTimeout(250);
    await expect(preview).not.toContainText("Screenshot copied to clipboard.");
    await expect(preview).not.toContainText("Download started.");
    await expect(preview).not.toContainText("Synthetic delayed image failure");
    await page.unroute(pattern, handler);
    await preview.getByRole("button", { name: forwards ? "Previous capture" : "Next capture", exact: true }).click();
    await expect(preview.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(artifact.name);
    await expect(preview.locator("img")).toBeVisible();
  }
  await preview.getByRole("button", { name: "Close capture preview", exact: true }).click();
  result.cases.push({ name: "preview-navigation-keeps-explicit-actions-without-stale-feedback", passed: true, delayedSuccessAndFailure: true });
}
try {
  await page.goto(url);
  await page.locator('[data-feed-source="qa-usb"]').waitFor();
  if (focusedPreview) await stalePreviewFeedbackCase();
  else {
  assert.equal(await page.locator(".capture-toast").count(), 0, "Existing capture history is not announced on first load.");
  result.cases.push(await captureViewCase({ page, output, label: "portal", openLibrary: () => page.getByRole("button", { name: /^Captures/ }).click() }));
  let remote = await openRemote();
  assert.equal(await remote.locator("img,video").count(), 0);
  const saved = await screenshot(remote);
  const renamedName = `Portal clipboard regression ${saved.id.slice(0, 8)}`;
  result.cases.push({ name: "screenshot-completion-toast", artifactId: saved.id, passed: true });
  await screenshot(remote, true);
  await expect.poll(() => page.evaluate(() => window.__captureClipboard.length)).toBe(1);
  const copied = await page.evaluate(() => window.__captureClipboard[0]);
  assert.equal(copied.type, "image/png"); assert.ok(copied.size > 0);
  await expect(remote).toContainText("Screenshot copied to your clipboard");
  result.cases.push({ name: "browser-clipboard-screenshot", passed: true, ...copied });
  await page.evaluate(() => { window.__denyCaptureClipboard = true; });
  await screenshot(remote, true);
  await expect(remote).toContainText("Allow clipboard access");
  await page.waitForTimeout(500);
  await expect(remote).toContainText("Allow clipboard access");
  await page.evaluate(() => { window.__denyCaptureClipboard = false; });
  result.cases.push({ name: "clipboard-denial-preserves-capture-and-error", passed: true });
  assert.ok(operations.filter((item) => item.operation === "captures.screenshot").every((item) => item.args.clipboard === false));
  await page.screenshot({ path: path.join(output, "portal-capture-remote.png") });
  await page.locator(`.capture-toast a[href="#capture=${saved.id}"]`).click();
  const preview = page.getByRole("dialog", { name: "Capture preview", exact: true });
  await expect(preview.locator("img")).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(saved.name);
  await preview.getByRole("button", { name: "Next capture", exact: true }).click();
  await expect(preview.getByRole("textbox", { name: "Name", exact: true })).not.toHaveValue(saved.name);
  await page.keyboard.press("ArrowLeft");
  await expect(preview.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(saved.name);
  await preview.getByRole("textbox", { name: "Name", exact: true }).fill(renamedName);
  await page.keyboard.press("ArrowLeft");
  await expect(preview.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(renamedName);
  await preview.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(preview).toContainText("Details saved.");
  await preview.getByRole("button", { name: "Copy image", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__captureClipboard.length)).toBe(2);
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), `${renamedName}.png`);
  await download.saveAs(path.join(output, "portal-downloaded.png"));
  assert.deepEqual([...((await readFile(path.join(output, "portal-downloaded.png"))).subarray(0, 8))], [137, 80, 78, 71, 13, 10, 26, 10]);
  await page.screenshot({ path: path.join(output, "portal-capture-preview.png") });
  await preview.getByRole("button", { name: "Close capture preview", exact: true }).click();
  const library = page.getByRole("region", { name: "Capture library", exact: true });
  await library.getByRole("button", { name: "List view", exact: true }).click();
  await library.getByRole("searchbox", { name: "Search captures", exact: true }).fill(renamedName);
  await expect(library.locator("tbody tr")).toHaveCount(1);
  await library.getByRole("button", { name: "Name", exact: true }).click();
  await expect(library.getByRole("columnheader", { name: "Name", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await library.getByRole("group", { name: "Filter capture type", exact: true }).getByRole("button", { name: "Recordings", exact: true }).click();
  await expect(library.locator("tbody tr")).toHaveCount(0);
  await library.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page.route("**/v1/operations/captures.openFolder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ opened: true, folder: "Synthetic capture folder" }) }));
  const opened = page.waitForResponse((response) => response.url().endsWith("/operations/captures.openFolder"));
  await library.getByRole("button", { name: /^Open folder/ }).click();
  assert.equal((await opened).status(), 200);
  await expect(library).toContainText("Opened the capture folder");
  result.cases.push({ name: "library-preview-navigation-copy-download-filter-folder", passed: true, download: download.suggestedFilename(), openFolder: "UI operation stubbed to avoid opening Finder" });
  remote = await openRemote();
  for (const finalizeBy of ["stop", "session-release"]) {
    const startedResponse = page.waitForResponse((response) => response.url().endsWith("/operations/recordings.start"));
    await remote.getByRole("button", { name: "Record", exact: true }).click();
    const started = await startedResponse;
    assert.equal(started.status(), 200);
    const recording = await started.json();
    await page.waitForTimeout(700);
    const finalizedResponse = page.waitForResponse((response) => response.url().endsWith(finalizeBy === "stop" ? "/operations/recordings.stop" : "/operations/sessions.release"));
    await remote.getByRole("button", { name: finalizeBy === "stop" ? "Stop recording" : "End session & save recording", exact: true }).click();
    assert.equal((await finalizedResponse).status(), 200);
    await expect(page.locator(`.capture-toast a[href="#capture=${recording.id}"]`)).toBeVisible({ timeout: 15_000 });
    result.cases.push({ name: `recording-completion-toast-${finalizeBy}`, passed: true });
  }
  await remote.getByRole("button", { name: "Close remote", exact: true }).click();
  await stalePreviewFeedbackCase();
  }
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  result.failure = error instanceof Error ? error.stack : String(error);
  await page.screenshot({ path: path.join(output, "portal-capture-failure.png") }).catch(() => {});
  throw error;
} finally {
  await Promise.allSettled(pending);
  await browser.close();
  for (const lease of leases.values()) await api("sessions.release", lease).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(output, focusedPreview ? "portal-preview-races-results.json" : "portal-results.json"), JSON.stringify({ ...result, errors }, null, 2));
  console.log(`Portal capture QA: ${result.passed ? "PASS" : "FAIL"} (${result.cases.length} cases)`);
}
