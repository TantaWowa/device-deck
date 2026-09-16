// Uses only the isolated qa-live-server fixture; never contacts real devices.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const output = path.resolve("outputs/portal-remote-qa");
const fixture = JSON.parse(await readFile("outputs/live-video-qa/fixture.json", "utf8"));
assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
assert.equal(fixture.token, "synthetic-qa-token");
await mkdir(output, { recursive: true });
const headers = { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" };
async function api(name, args = {}) {
  const response = await fetch(`${fixture.base}/v1/operations/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  assert.equal(response.status, 200, name);
  return response.json();
}
assert.ok((await api("inventory")).devices.every((device) => device.name.startsWith("Synthetic ")));
await build({ entryPoints: ["scripts/fixtures/live-portal.tsx"], bundle: true, format: "esm", outfile: path.join(output, "portal.js"), loader: { ".css": "css" } });
const leases = new Map();
const operations = [];
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
      const body = Buffer.concat(chunks);
      const upstream = await fetch(fixture.base + request.url, { method: request.method, headers, body: request.method === "POST" ? body : undefined });
      const type = upstream.headers.get("content-type") || "application/octet-stream";
      let data = Buffer.from(await upstream.arrayBuffer());
      if (type.includes("application/json")) {
        const result = JSON.parse(data);
        const operation = request.url.split("/operations/")[1];
        if (operation) operations.push({ operation, status: upstream.status, args: JSON.parse(body) });
        if (result.session?.id && result.leaseToken) leases.set(result.session.id, { sessionId: result.session.id, leaseToken: result.leaseToken });
        if (operation === "inventory") {
          // Present the synthetic capture target as a TV; its fixture adapter still
          // handles every command and provides generated video, with no Roku IO.
          const tv = result.devices.find((device) => device.id === "usb");
          tv.platform = "Roku";
          tv.model = "Synthetic Roku TV";
          tv.connection = { type: "roku", host: "127.0.0.1", serial: "qa-only" };
        }
        data = Buffer.from(JSON.stringify(result));
      }
      response.writeHead(upstream.status, { "Content-Type": type }); response.end(data);
    } else if (["/portal.js", "/portal.css"].includes(request.url)) {
      response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(await readFile(path.join(output, request.url.slice(1))));
    } else { response.writeHead(404); response.end(); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const width of [1440, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 640, isMobile: width < 640 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const feed = page.locator('[data-feed-source="qa-usb"]');
    await expect.poll(() => feed.locator("video").evaluate((video) => video.readyState), { timeout: 35_000 }).toBeGreaterThanOrEqual(2);
    const before = await feed.locator("video").evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
    const trigger = feed.getByRole("button", { name: "Remote", exact: true });
    await trigger.click();
    const remote = page.getByRole("region", { name: "Remote for Synthetic USB", exact: true });
    await expect(remote).toBeVisible();
    await expect(page.locator(".portal-remote-sheet,.remote-backdrop")).toHaveCount(0);
    await expect(remote.locator("video,img")).toHaveCount(0);
    await expect(remote.getByRole("button", { name: "Screenshot", exact: true })).toHaveCount(0);
    const menuButton = remote.getByRole("button", { name: "Remote menu", exact: true });
    const inputsBeforeMenu = operations.filter((entry) => entry.operation === "remote.input").length;
    await menuButton.focus(); await page.keyboard.press("Enter");
    await expect(menuButton).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Space");
    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    assert.equal(operations.filter((entry) => entry.operation === "remote.input").length, inputsBeforeMenu, "Popup buttons keep native keyboard behavior.");
    const box = await remote.boundingBox();
    assert.ok(box && box.width <= (width < 640 ? width : 320));
    assert.ok(box.height < (width < 640 ? 650 : 360));
    await expect.poll(() => feed.locator("video").evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(before + 5);
    if (width < 640) {
      const small = await remote.locator("[data-remote-key]").evaluateAll((buttons) => buttons.filter((button) => {
        const box = button.getBoundingClientRect(); return box.width < 48 || box.height < 48;
      }).map((button) => button.getAttribute("data-remote-key")));
      assert.deepEqual(small, [], "Touch targets must be at least 48px.");
    } else {
      const bar = await remote.locator("header").boundingBox();
      await page.mouse.move(bar.x + 65, bar.y + 15); await page.mouse.down();
      await page.mouse.move(bar.x + 110, bar.y + 65, { steps: 4 }); await page.mouse.up();
      const moved = await remote.boundingBox();
      assert.ok(Math.abs(moved.x - box.x) > 20 || Math.abs(moved.y - box.y) > 20, "Popup must drag.");
    }
    const key = page.waitForResponse((response) => response.url().endsWith("/operations/remote.input"));
    await remote.locator('[data-remote-key="Home"]').click();
    assert.equal((await key).status(), 200);
    await page.screenshot({ path: path.join(output, `remote-${width}.png`) });
    await remote.getByRole("button", { name: "Remote menu", exact: true }).click();
    await expect(remote.getByRole("button", { name: "Screenshot", exact: true })).toBeVisible();
    const screenshot = page.waitForResponse((response) => response.url().endsWith("/operations/captures.screenshot"));
    await remote.getByRole("button", { name: "Screenshot", exact: true }).click();
    assert.equal((await screenshot).status(), 200);
    await expect(page.locator(".capture-toast")).toHaveCount(1);
    await remote.getByRole("button", { name: "Remote menu", exact: true }).click();
    await expect(remote.locator('[data-remote-key="Home"]')).toBeVisible();
    await remote.getByRole("button", { name: "Close remote", exact: true }).click();
    await expect(remote).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await expect(remote).toBeVisible();
    await remote.locator('[data-remote-key="Home"]').focus();
    await expect(remote.getByRole("button", { name: /Keyboard locked/ })).toHaveAttribute("aria-pressed", "true");
    const keyboardButton = remote.locator(".keyboard-toggle");
    await keyboardButton.focus(); await page.keyboard.press("Enter");
    await expect(keyboardButton).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Space");
    await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");
    await remote.locator('[data-remote-key="Home"]').focus();
    // Match the existing popup: the first Escape releases keyboard capture;
    // the second closes the window without sending either key to the device.
    const inputCount = operations.filter((entry) => entry.operation === "remote.input").length;
    await page.keyboard.press("Escape");
    await expect(remote).toBeVisible();
    await expect(remote.getByRole("button", { name: /Keyboard unlocked/ })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape"); await expect(remote).toHaveCount(0);
    assert.equal(operations.filter((entry) => entry.operation === "remote.input").length, inputCount);
    await trigger.click();
    await remote.getByRole("button", { name: "Close remote", exact: true }).focus();
    await page.keyboard.press("Enter"); await expect(remote).toHaveCount(0);
    assert.equal(operations.filter((entry) => entry.operation === "remote.input").length, inputCount);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    results.push({ width, popup: { width: box.width, height: box.height }, advancingVideo: true, menuCapture: true, keyboardAndFocus: true });
    await context.close();
    for (const lease of leases.values()) await api("sessions.release", lease).catch(() => {});
    leases.clear();
  }
  assert.ok(operations.some((entry) => entry.operation === "streams.open" && entry.status === 200));
  assert.ok(operations.filter((entry) => entry.operation === "remote.input").every((entry) => entry.args.key === "Home"));
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log("Portal remote QA passed: actual moving video, shared compact popup, phone targets, dragging, menu capture, controls, Escape and focus.");
} finally {
  await browser.close();
  for (const lease of leases.values()) await api("sessions.release", lease).catch(() => {});
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
