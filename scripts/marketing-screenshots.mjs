#!/usr/bin/env node
// Render current local.html, never the legacy /demo app or a running daemon.
// Run: node scripts/marketing-screenshots.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { tsImport } from "tsx/esm/api";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = path.join(root, "work/marketing-screenshots");
const app = path.join(work, "app");
const assets = path.join(root, "apps/website/public/assets");
const { marketingWorkspace, screenshotTime } = await tsImport(
  "./fixtures/marketing-workspace.ts",
  import.meta.url,
);
const snapshot = marketingWorkspace();
await mkdir(work, { recursive: true });
await mkdir(assets, { recursive: true });
await build({
  configFile: false,
  root: path.join(root, "apps/web"),
  base: "/",
  logLevel: "warn",
  build: {
    outDir: app,
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, "apps/web/local.html") },
  },
});

const staticFiles = new Map();
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else
      staticFiles.set(
        "/" + path.relative(app, filename).split(path.sep).join("/"),
        filename,
      );
  }
}
await collect(app);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const violations = [],
  pageErrors = [],
  screenshots = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://fixture.invalid").pathname;
  const filename = staticFiles.get(pathname);
  if (request.method !== "GET" || !filename) {
    violations.push(`Static server rejected ${request.method} ${pathname}`);
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, {
      "Content-Type":
        mime[path.extname(filename)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(await readFile(filename));
  } catch (error) {
    response.writeHead(500).end();
    pageErrors.push(String(error));
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, context, page;
let browserChannel = process.env.PLAYWRIGHT_CHANNEL || "bundled chromium";
try {
  try {
    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHANNEL
        ? { channel: process.env.PLAYWRIGHT_CHANNEL }
        : {},
    );
  } catch (error) {
    const existingChrome =
      process.platform === "darwin" &&
      (await access(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ).then(
        () => true,
        () => false,
      ));
    if (
      process.env.PLAYWRIGHT_CHANNEL ||
      !existingChrome ||
      !String(error).includes("Executable doesn't exist")
    )
      throw error;
    browserChannel = "chrome";
    console.log(
      "Bundled Chromium is unavailable; using the existing Chrome installation.",
    );
    browser = await chromium.launch({ channel: "chrome" });
  }
  context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    deviceScaleFactor: 2,
    locale: "en-GB",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const previewBytes = new Map();
  // All browser network traffic must belong to this static fixture server.
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      violations.push(`Blocked external request: ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    if (
      url.pathname === "/v1/operations/inventory" &&
      request.method() === "POST"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot),
      });
      return;
    }
    const preview = /^\/v1\/(?:source-preview|preview)\/([^/]+)$/.exec(
      url.pathname,
    );
    if (preview && request.method() === "GET" && previewBytes.has(preview[1])) {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: previewBytes.get(preview[1]),
      });
      return;
    }
    if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "GET" && staticFiles.has(url.pathname)) {
      await route.continue();
      return;
    }
    violations.push(
      `Blocked unknown fixture request: ${request.method()} ${url.pathname}`,
    );
    await route.abort();
  });

  // Capture original fictional screen scenes in the browser. These PNG bytes
  // are preview API fixtures, not replacements for any Device Deck UI.
  const artwork = (
    await readFile(path.join(root, "apps/web/public/assets/fjord-preview.webp"))
  ).toString("base64");
  const screen = await context.newPage();
  await screen.setViewportSize({ width: 1280, height: 720 });
  screen.on("pageerror", (error) => pageErrors.push(error.message));
  const titles = ["Above the fjord", "The quiet coast", "Into the mountains"];
  for (let index = 0; index < titles.length; index++) {
    await screen.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#071522;color:white;font-family:Arial,sans-serif;width:1280px;height:720px;overflow:hidden}
      .art{position:absolute;width:100%;height:100%;object-fit:cover}.shade{position:absolute;inset:0;background:linear-gradient(90deg,#05131cd9,transparent 80%),linear-gradient(0deg,#05131cf5,transparent 60%)}
      nav{position:absolute;top:44px;left:54px;display:flex;align-items:center;gap:36px;font-size:17px;color:#d1dade}nav b{font-size:24px;letter-spacing:5px;margin-right:45px;color:white}nav .active{color:white;border-bottom:2px solid #add7d0;padding-bottom:9px}
      main{position:absolute;left:58px;top:262px}small{font-size:12px;letter-spacing:3px;color:#c3dad7}h1{font-size:55px;font-weight:500;letter-spacing:-2px;margin:15px 0}p{font-size:19px;color:#d1dddd;margin:0 0 28px}.play{display:inline-block;background:#f5f7f4;color:#152426;padding:15px 27px;border-radius:6px;font-weight:600;font-size:16px}
      .cards{position:absolute;left:58px;bottom:68px;display:flex;gap:16px}.cards span{width:255px;padding:20px 22px;border:1px solid #ffffff3d;border-radius:6px;background:#132831bd;font-size:15px}.cards .focused{border:2px solid #d2e9de;padding:19px 21px;background:#213b44dd}.sample{position:absolute;right:30px;bottom:18px;color:#e8f2ed;font-size:13px;letter-spacing:.4px}
      </style></head><body><img class="art" src="data:image/webp;base64,${artwork}" alt="Original fictional fjord artwork"><div class="shade"></div><nav><b>FIELDNOTES</b><span class="active">Discover</span><span>Films</span><span>My list</span></nav><main><small>A FIELDNOTES ORIGINAL</small><h1>${titles[index]}</h1><p>Some places are worth slowing down for.</p><span class="play">▶ &nbsp; Play film</span></main><div class="cards">${titles.map((title, i) => `<span class="${i === index ? "focused" : ""}">${title}</span>`).join("")}</div><span class="sample">Fictional app · sample screen</span></body></html>`);
    await screen.locator("img").evaluate((image) => image.decode());
    const bytes = await screen.screenshot({ animations: "disabled" });
    previewBytes.set(`sample-hdmi-${index + 1}`, bytes);
    previewBytes.set(snapshot.devices[index].id, bytes);
    await writeFile(path.join(work, `sample-screen-${index + 1}.png`), bytes);
  }
  await screen.close();
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.clock.setFixedTime(new Date(screenshotTime));
  await page.addInitScript(() => {
    localStorage.setItem(
      "deck-remote-position-sample-roku-studio",
      JSON.stringify({ x: 1135, y: 390, width: 300, height: 302 }),
    );
    localStorage.setItem(
      "deck-remote-position-sample-fire-tv",
      JSON.stringify({ x: 1120, y: 650, width: 300, height: 302 }),
    );
  });
  const assertVisible = async (locator) => {
    assert(await locator.isVisible(), `Expected visible ${locator}`);
  };
  const readyImages = async (selector) => {
    await page.locator(selector).first().waitFor({ state: "visible" });
    await page.waitForFunction(
      (selector) =>
        [...document.querySelectorAll(selector)].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      selector,
    );
  };
  const badge = async () =>
    page.evaluate(() => {
      document.getElementById("marketing-fixture-badge")?.remove();
      const label = document.createElement("div");
      label.id = "marketing-fixture-badge";
      label.textContent = "Fictional workspace · current Device Deck UI";
      label.style.cssText =
        "position:fixed;right:24px;bottom:16px;z-index:2000;background:#fff;color:#526075;border:1px solid #d6dfe9;border-radius:7px;padding:7px 11px;font:11px system-ui;pointer-events:none";
      (document.fullscreenElement || document.body).append(label);
    });
  const capture = async (name) => {
    await badge();
    await page.mouse.move(5, 5);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(violations, [], "Unexpected network access");
    assert.deepEqual(pageErrors, [], "Browser errors");
    const label = await page.locator("#marketing-fixture-badge").boundingBox();
    const viewport = page.viewportSize();
    assert(
      label &&
        label.x >= 0 &&
        label.y >= 0 &&
        label.x + label.width <= viewport.width &&
        label.y + label.height <= viewport.height - 8,
      "Fictional-workspace badge must fit wholly inside the screenshot",
    );
    const output = path.join(assets, `${name}-current.png`);
    await page.screenshot({
      path: output,
      animations: "disabled",
      caret: "hide",
    });
    screenshots.push({
      path: path.relative(root, output),
      viewport: page.viewportSize(),
      deviceScaleFactor: 2,
      bytes: (await readFile(output)).length,
    });
    console.log(`Captured ${path.relative(root, output)}`);
  };
  const checkCompactRemote = async (name) => {
    const remote = page.getByRole("region", {
      name: `Remote for ${name}`,
      exact: true,
    });
    await assertVisible(remote);
    assert.equal(
      await remote
        .getByRole("button", { name: "Remote menu", exact: true })
        .getAttribute("aria-expanded"),
      "false",
    );
    await assertVisible(
      remote.getByRole("button", { name: "OK", exact: true }),
    );
    await assertVisible(
      remote.getByRole("textbox", { name: `Text for ${name}` }),
    );
    await assertVisible(remote.getByRole("button", { name: /Keyboard input/ }));
    const rect = await remote.boundingBox();
    assert(
      rect && rect.width <= 320 && rect.height <= 320,
      `Remote must remain compact: ${JSON.stringify(rect)}`,
    );
    const input = await remote.getByRole("textbox").boundingBox();
    assert(
      input && input.y + input.height < rect.y + rect.height,
      "Text field must fit inside the compact remote",
    );
    return remote;
  };

  await page.goto(`${origin}/local.html`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  assert.equal(
    await page.locator(".live-table tbody tr").count(),
    snapshot.devices.length,
  );
  for (const name of ["Apple", "Roku", "Android"])
    await assertVisible(
      page
        .getByRole("group", { name: "Filter platform" })
        .getByRole("button", { name: new RegExp(`^${name}`) }),
    );
  for (const name of ["Sim", "Real"])
    await assertVisible(
      page
        .getByRole("group", { name: "Filter device type" })
        .getByRole("button", { name, exact: true }),
    );
  assert.equal(
    await page.locator(".live-table .feed-actions").count(),
    snapshot.devices.length,
  );
  const table = await page.locator(".live-table").boundingBox();
  assert(
    table && table.y + table.height <= 970,
    "The complete Devices table must fit in the screenshot",
  );
  await capture("devices");

  await page.getByRole("button", { name: "Studio Roku", exact: true }).click();
  await readyImages(".live-view-tile .live-screen img");
  await page
    .getByRole("button", { name: "Remote · Studio Roku", exact: true })
    .click();
  const remote = await checkCompactRemote("Studio Roku");
  await remote.getByRole("textbox").fill("Above the fjord");
  await remote
    .getByRole("button", { name: "Keyboard input", exact: true })
    .click();
  // Use the actual drag behavior to place the remote over a corner of the feed.
  const bar = await remote.locator(".floating-remote-bar").boundingBox();
  await page.mouse.move(bar.x + 50, bar.y + 17);
  await page.mouse.down();
  await page.mouse.move(bar.x + 36, bar.y + 38, { steps: 8 });
  await page.mouse.up();
  await checkCompactRemote("Studio Roku");
  await capture("remote");

  await page.goto(
    `${origin}/local.html?view=feeds&layout=grid&sources=sample-hdmi-1,sample-hdmi-2,sample-hdmi-3&active=sample-hdmi-1`,
    { waitUntil: "domcontentloaded" },
  );
  await readyImages(".feed-tile .live-screen img");
  assert.equal(await page.locator(".feed-tile").count(), 3);
  assert.equal(
    await page.locator(".feed-tile .feed-actions button").count(),
    15,
  );
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page
    .getByRole("button", { name: "Remote · HDMI 3 · Fire TV", exact: true })
    .click();
  await checkCompactRemote("Fire TV");
  await assertVisible(page.locator(".remote-fire-tv"));
  const bounds = await page.locator(".feed-tile").evaluateAll((tiles) =>
    tiles.map((tile) => {
      const rect = tile.getBoundingClientRect();
      return { bottom: rect.bottom, right: rect.right };
    }),
  );
  assert(
    bounds.every((rect) => rect.bottom <= 1000 && rect.right <= 1500),
    "Every complete feed tile must fit in the screenshot",
  );
  await capture("feeds");
  const report = {
    sourceEntry: "apps/web/local.html",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    fixture: "scripts/fixtures/marketing-workspace.ts",
    browserChannel,
    browserVersion: browser.version(),
    screenshotTime: new Date(screenshotTime).toISOString(),
    screenshots,
    unknownRequests: violations,
    pageErrors,
  };
  await writeFile(
    path.join(work, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "Screenshot checks passed; report: work/marketing-screenshots/report.json",
  );
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(work, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
