// Real web UI and daemon; isolated configuration and inert adapters only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { z } from "zod";
import { chromium, expect, type Browser } from "@playwright/test";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters } from "../packages/adapters/src";
import { CaptureEngine } from "../packages/capture/src";
import { LicenseManager } from "../packages/licensing/src";
import {
  assignCustomCaptureCard,
  mergeCaptureCards,
} from "../packages/core/src/capture-cards";
import type {
  Device,
  DeviceConfig,
  SourceConfig,
} from "../packages/core/src/local/types";

const stage = path.resolve("work/custom-device-ui");
const output = path.resolve("outputs/custom-devices");
await mkdir("work", { recursive: true });
await mkdir(output, { recursive: true });
await build({
  root: path.resolve("apps/web"),
  logLevel: "warn",
  build: {
    outDir: stage,
    emptyOutDir: true,
    rollupOptions: { input: path.resolve("apps/web/local.html") },
  },
});
await rename(path.join(stage, "local.html"), path.join(stage, "index.html"));
const directory = await mkdtemp(path.resolve("work/custom-device-fixture-"));
const detected = [
  { uniqueId: "fixture-new", name: "Fixture HDMI" },
  { uniqueId: "fixture-auto", name: "Fixture USB video" },
  { uniqueId: "fixture-roku", name: "Fixture Roku input" },
];
let deck: DeckService;
class FixtureAdapters extends Adapters {
  async diagnostics() {
    return [];
  }
  async discover() {
    return { devices: [], sources: [], diagnostics: [] };
  }
  async inspect(device: DeviceConfig): Promise<Device> {
    return {
      ...device,
      online: true,
      locked: false,
      healthDetail: "Isolated fixture",
      capabilities: [],
    };
  }
  async inspectSources(sources: SourceConfig[]) {
    return sources.map((source) => ({
      ...source,
      status: "connected" as const,
    }));
  }
  async captureCards(sources: SourceConfig[]) {
    return {
      sources: mergeCaptureCards(sources, detected, (id) => id),
      diagnostics: [],
    };
  }
  async input() {
    throw new Error("Fixture must not send input");
  }
}
class FixtureCapture extends CaptureEngine {
  async closeSource() {}
  async close() {}
  async preview() {
    // A fixed one-pixel test image; never reads a device or the user's screen.
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
  }
  async start(): Promise<never> {
    throw new Error("Fixture must not record");
  }
}
const adapters = new FixtureAdapters(() => deck.config.config);
deck = new DeckService(
  directory,
  undefined,
  adapters,
  new FixtureCapture(adapters),
  new LicenseManager(directory, null),
);
const token = randomBytes(32).toString("base64url");
const server = createService(deck, token, stage);
let browser: Browser | undefined;
const checks: string[] = [];
const errors: string[] = [];
try {
  await deck.init();
  const initial = structuredClone(deck.config.config);
  initial.sources = [
    {
      id: "saved-auto",
      name: "Fixture USB video",
      kind: "usb",
      uniqueId: "fixture-auto",
    },
    {
      id: "saved-roku",
      name: "Fixture Roku input",
      kind: "usb",
      uniqueId: "fixture-roku",
    },
  ];
  initial.devices = [
    {
      id: "auto-feed",
      name: "Auto feed",
      platform: "Other",
      kind: "physical",
      model: "USB capture",
      visibility: "local",
      connection: { type: "capture" },
      captureSourceId: "saved-auto",
    },
    {
      id: "roku",
      name: "Fixture Roku",
      platform: "Roku",
      kind: "physical",
      model: "Fixture",
      visibility: "local",
      connection: {
        type: "roku",
        host: "roku.example.test",
        serial: "FIXTURE",
      },
      captureSourceId: "saved-roku",
    },
  ];
  await deck.execute("config.save", {
    config: initial,
    revision: deck.config.revision,
  });
  deck.store.event({
    deviceId: "auto-feed",
    owner: "Fixture",
    action: "Custom rename proof",
    detail: "History must keep the same device ID",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route: string, body: unknown) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const { ticket } = await request("/v1/browser-ticket", {}).then((r) =>
    r.json(),
  );
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      errors.push(
        `Blocked request outside fixture: ${url.origin}${url.pathname}`,
      );
      await route.abort();
    } else if (url.pathname === "/favicon.ico") {
      // The daemon has no favicon; avoid the browser's unrelated implicit 404.
      await route.fulfill({ status: 204 });
    } else await route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(
        `${message.text()} ${message.location().url ? new URL(message.location().url).pathname : ""}`,
      );
  });
  const nav = (name: string) =>
    page
      .locator(".live-sidebar")
      .getByRole("button", {
        name: name === "Devices" ? /^Devices/ : name,
        exact: true,
      })
      .click();
  const card = (name: string) =>
    page.getByRole("article", { name, exact: true });
  await page.goto(`${base}/#ticket=${ticket}`);
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  await nav("Capture Cards");
  const fresh = card("Fixture HDMI");
  await fresh.getByRole("combobox").selectOption("custom:");
  await fresh.getByRole("textbox").fill("  Mac mini  ");
  await page.screenshot({
    path: path.join(output, "custom-name-desktop.png"),
    fullPage: true,
  });
  await fresh
    .getByRole("button", { name: "Create & assign", exact: true })
    .click();
  await expect(
    fresh.getByRole("button", { name: "Mac mini →", exact: true }),
  ).toBeVisible();
  const mac = deck.config.config.devices.find(
    (device) => device.name === "Mac mini",
  );
  assert(mac);
  assert.equal(mac.connection.type, "capture");
  assert.equal(mac.captureSourceId, "fixture-new");
  const disk = JSON.parse(await readFile(deck.config.file, "utf8"));
  assert.equal(
    disk.devices.find((device: DeviceConfig) => device.id === mac.id).name,
    "Mac mini",
  );
  await page.reload();
  await nav("Capture Cards");
  await page
    .getByRole("button", { name: "Discover / refresh", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discover / refresh", exact: true }),
  ).toBeEnabled();
  await expect(fresh.getByRole("combobox")).toHaveValue(mac.id);
  await nav("Devices");
  await expect(
    page.getByRole("combobox", {
      name: "Capture input for Mac mini",
      exact: true,
    }),
  ).toHaveValue("fixture-new");
  await page.goto(`${base}/?view=feeds&sources=fixture-new`);
  await expect(page.locator(".feed-tile")).toContainText("Mac mini");
  checks.push(
    "Custom creation persists to disk, reload, rediscovery, Devices and Feeds",
  );

  await nav("Capture Cards");
  const auto = card("Fixture USB video");
  await auto.getByRole("combobox").selectOption("custom:");
  await expect(auto.getByRole("textbox")).toHaveValue("Auto feed");
  const unchanged = JSON.stringify(deck.config.config);
  await auto.getByRole("textbox").fill("   ");
  await expect(
    auto.getByRole("button", { name: "Save device name", exact: true }),
  ).toBeDisabled();
  await auto.getByRole("textbox").fill("MAC MINI");
  await auto
    .getByRole("button", { name: "Save device name", exact: true })
    .click();
  await expect(auto.getByRole("alert")).toContainText("already exists");
  assert.equal(JSON.stringify(deck.config.config), unchanged);
  await auto.getByRole("textbox").fill("Studio Mac mini");
  await auto
    .getByRole("button", { name: "Save device name", exact: true })
    .click();
  await expect(auto.getByRole("combobox")).toHaveValue("auto-feed");
  assert.equal(deck.config.config.devices.length, 3);
  assert.equal(
    deck.config.config.devices.find((device) => device.id === "auto-feed")
      ?.name,
    "Studio Mac mini",
  );
  assert(
    deck.store
      .events()
      .some(
        (event) =>
          event.deviceId === "auto-feed" &&
          event.action === "Custom rename proof",
      ),
  );
  checks.push(
    "Blank and duplicate names cannot mutate config; rename preserves device ID and history",
  );

  const held = z
    .object({ session: z.object({ id: z.string() }), leaseToken: z.string() })
    .parse(
      await deck.execute("sessions.reserve", {
        selector: { device: "roku" },
        owner: "Fixture owner",
        reason: "Reserved binding proof",
      }),
    );
  await page.reload();
  await nav("Capture Cards");
  await expect(card("Fixture Roku input").getByRole("combobox")).toBeDisabled();
  const before = JSON.stringify(deck.config.config);
  const source = deck.config.config.sources.find(
    (item) => item.id === "saved-roku",
  )!;
  const rejected = await request("/v1/operations/config.save", {
    config: assignCustomCaptureCard(deck.config.config, source, {
      id: "blocked",
      name: "Blocked target",
    }),
    revision: deck.config.revision,
  });
  assert.equal(rejected.status, 409);
  assert.equal(JSON.stringify(deck.config.config), before);
  await deck.execute("sessions.release", {
    sessionId: held.session.id,
    leaseToken: held.leaseToken,
  });
  checks.push(
    "Reserved assignment is disabled and stale HTTP save is rejected without mutation",
  );

  await page.reload();
  await nav("Capture Cards");
  await auto.getByRole("combobox").selectOption("custom:");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: path.join(output, "custom-name-mobile.png"),
    fullPage: true,
  });
  await auto.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(auto.getByRole("combobox")).toHaveValue("auto-feed");
  checks.push("Custom form fits mobile; Cancel restores assigned device");
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { checks, errors, fixtureOnly: true, stagedUI: stage },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await deck.close();
  await rm(directory, { recursive: true, force: true });
}
