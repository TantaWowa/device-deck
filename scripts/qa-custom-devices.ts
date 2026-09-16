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
import { exerciseDeviceTable } from "./qa-device-table";
import { exerciseRemoteInput } from "./qa-remote-input";
import { exerciseWake } from "./qa-wake";
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
const remoteInputs: { key?: string; text?: string }[] = [];
const remoteAttempts: { key?: string; text?: string }[] = [];
const wakeAttempts: string[] = [];
let rokuOnline = true;
let remoteInputBarrier: Promise<void> | undefined;
let teammateLease: { session: { id: string }; leaseToken: string } | undefined;
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
      online: device.id === "roku" ? rokuOnline : device.id !== "iphone-sim",
      locked: false,
      healthDetail: "Isolated fixture",
      capabilities: device.id === "roku" ? ["key", "text", "wake"] : [],
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
  async input(device: DeviceConfig, input: { key?: string; text?: string }) {
    assert.equal(
      device.id,
      "roku",
      "Only the inert fixture remote may receive input",
    );
    const value =
      input.text !== undefined ? { text: input.text } : { key: input.key };
    remoteAttempts.push(value);
    const barrier = remoteInputBarrier;
    remoteInputBarrier = undefined;
    if (barrier) await barrier;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    remoteInputs.push(value);
  }
  async wake(device: DeviceConfig) {
    assert(
      device.id === "roku",
      "Only inert wake fixtures may receive wake requests",
    );
    wakeAttempts.push(device.id);
    return { method: "Roku Home button" };
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
    {
      id: "iphone-sim",
      name: "iPhone 16 simulator",
      platform: "Apple",
      kind: "virtual",
      model: "iPhone 16",
      visibility: "local",
      connection: {
        type: "simulator",
        os: "ios",
        udid: "11111111-1111-4111-8111-111111111111",
      },
      captureSourceId: null,
    },
    {
      id: "pixel",
      name: "Pixel 9",
      platform: "Android",
      kind: "physical",
      model: "Pixel 9 phone",
      visibility: "local",
      connection: { type: "adb", serial: "FIXTURE-PIXEL", port: 5037 },
      captureSourceId: null,
    },
    {
      id: "tv-sim",
      name: "Apple TV simulator",
      platform: "Apple",
      kind: "virtual",
      model: "tvOS",
      visibility: "shared",
      connection: {
        type: "simulator",
        os: "tvos",
        udid: "22222222-2222-4222-8222-222222222222",
      },
      captureSourceId: null,
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
  checks.push(...(await exerciseDeviceTable(page, output, base)));
  checks.push(
    ...(await exerciseWake(page, output, {
      attempts: () => wakeAttempts,
      remoteInputs: () => remoteInputs.length,
      sessions: () => deck.store.sessions().length,
      session: (id) => deck.store.session(id),
      reserve: async (owner) => {
        const held = z
          .object({
            session: z.object({ id: z.string() }),
            leaseToken: z.string(),
          })
          .parse(
            await deck.execute("sessions.reserve", {
              selector: { device: "roku" },
              owner,
              reason: "Keep this reservation during wake override",
            }),
          );
        return {
          session: deck.store.session(held.session.id),
          leaseToken: held.leaseToken,
        };
      },
      release: async (lease) => {
        await deck.execute("sessions.release", {
          sessionId: lease.session.id,
          leaseToken: lease.leaseToken,
        });
      },
      setOnline: async (online) => {
        rokuOnline = online;
        await deck.devices(true);
      },
    })),
  );
  checks.push(
    ...(await exerciseRemoteInput(page, output, {
      inputs: () => remoteInputs,
      attempts: () => remoteAttempts,
      sessions: () =>
        deck.store.sessions().filter((session) => session.deviceId === "roku")
          .length,
      session: (id) => deck.store.session(id),
      reserveOther: async () => {
        const held = z
          .object({
            session: z.object({ id: z.string() }),
            leaseToken: z.string(),
          })
          .parse(
            await deck.execute("sessions.reserve", {
              selector: { device: "roku" },
              owner: "Fixture teammate",
              reason: "Keep this reservation during remote override",
            }),
          );
        teammateLease = held;
        return deck.store.session(held.session.id);
      },
      endOther: async () => {
        assert(teammateLease);
        await deck.execute("sessions.release", {
          sessionId: teammateLease.session.id,
          leaseToken: teammateLease.leaseToken,
        });
      },
      holdNext: () => {
        let release!: () => void;
        remoteInputBarrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        return release;
      },
      release: async () => {
        const leases = await page.evaluate(() =>
          JSON.parse(localStorage.getItem("deck-local-leases") || "{}"),
        );
        const lease = leases.roku;
        if (lease)
          await deck.execute("sessions.release", {
            sessionId: lease.session.id,
            leaseToken: lease.leaseToken,
          });
      },
    })),
  );
  await nav("Capture Cards");
  const fresh = card("Fixture HDMI");
  const dialog = page.getByRole("dialog");
  const trigger = (name: string) =>
    card(name).getByRole("button", {
      name: `Assigned device for ${name}`,
      exact: true,
    });
  const filter = (group: string, name: string) =>
    dialog
      .getByRole("group", { name: group, exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  const options = () => dialog.locator(".device-picker-option");
  for (const row of await page.locator(".capture-card").all()) {
    const bounds = await row.boundingBox();
    assert(
      bounds && bounds.height <= 110,
      "Desktop capture cards must be compact single rows",
    );
  }
  await page.screenshot({
    path: path.join(output, "capture-rows-desktop.png"),
    fullPage: true,
  });
  await trigger("Fixture HDMI").click();
  await expect(
    dialog.getByRole("textbox", { name: "Search devices", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: path.join(output, "device-picker-desktop.png"),
  });
  await filter("Family", "Android");
  await filter("Class", "Phone");
  await filter("Type", "Physical");
  await dialog
    .getByRole("textbox", { name: "Search devices", exact: true })
    .fill(" PIXEL ");
  await expect(options()).toHaveCount(1);
  await expect(options()).toContainText("Pixel 9");
  await dialog
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await filter("Family", "Apple");
  await filter("Class", "Phone");
  await filter("Type", "Simulator");
  await expect(options()).toHaveCount(1);
  await expect(options()).toContainText("iPhone 16 simulator");
  await filter("Class", "TV");
  await expect(options()).toHaveCount(1);
  await expect(options()).toContainText("Apple TV simulator");
  await dialog
    .getByRole("textbox", { name: "Search devices", exact: true })
    .fill("missing device");
  await expect(
    dialog.getByText("No matching devices", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(options().filter({ hasText: "Fixture Roku" })).toBeDisabled();
  await expect(options().filter({ hasText: "Fixture Roku" })).toContainText(
    "already has a capture input",
  );
  await dialog
    .getByRole("textbox", { name: "Search devices", exact: true })
    .fill("Pixel");
  await dialog
    .getByRole("textbox", { name: "Search devices", exact: true })
    .press("ArrowDown");
  await expect(options()).toBeFocused();
  await options().press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger("Fixture HDMI")).toContainText("Pixel 9");
  await expect(trigger("Fixture HDMI")).toHaveAccessibleDescription("Pixel 9");
  await expect(trigger("Fixture HDMI")).toBeFocused();
  await trigger("Fixture HDMI").click();
  await dialog.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(
    deck.config.config.devices.find((device) => device.id === "pixel")
      ?.captureSourceId,
    null,
  );
  await expect(trigger("Fixture HDMI")).toContainText("Choose a device");
  checks.push(
    "Combined family/class/type/text filters, empty state, conflicts, keyboard assignment, unassign and focus return",
  );
  await trigger("Fixture HDMI").click();
  await filter("Family", "Other");
  await dialog
    .getByRole("textbox", { name: "Custom device name", exact: true })
    .fill("  Mac mini  ");
  await page.screenshot({
    path: path.join(output, "custom-name-desktop.png"),
    fullPage: false,
  });
  await dialog
    .getByRole("button", { name: "Create & assign", exact: true })
    .click();
  await expect(trigger("Fixture HDMI")).toContainText("Mac mini");
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
  await expect(trigger("Fixture HDMI")).toContainText("Mac mini");
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
  await trigger("Fixture USB video").click();
  await filter("Family", "Other");
  const customName = dialog.getByRole("textbox", {
    name: "Custom device name",
    exact: true,
  });
  await expect(customName).toHaveValue("Auto feed");
  const unchanged = JSON.stringify(deck.config.config);
  await customName.fill("   ");
  await expect(
    dialog.getByRole("button", { name: "Save name", exact: true }),
  ).toBeDisabled();
  await customName.fill("MAC MINI");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  assert.equal(JSON.stringify(deck.config.config), unchanged);
  await customName.fill("Studio Mac mini");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger("Fixture USB video")).toContainText("Studio Mac mini");
  assert.equal(deck.config.config.devices.length, initial.devices.length + 1);
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

  await trigger("Fixture USB video").click();
  await filter("Family", "Other");
  await customName.fill("An outdated draft");
  const renamedElsewhere = structuredClone(deck.config.config);
  renamedElsewhere.devices.find((device) => device.id === "auto-feed")!.name =
    "Team Mac mini";
  await deck.execute("config.save", {
    config: renamedElsewhere,
    revision: deck.config.revision,
  });
  await expect(dialog).toHaveCount(0, { timeout: 10000 });
  await expect(trigger("Fixture USB video")).toBeFocused();
  await expect(trigger("Fixture USB video")).toHaveAccessibleDescription(
    "Team Mac mini",
  );
  await trigger("Fixture USB video").click();
  await filter("Family", "Other");
  await expect(customName).toHaveValue("Team Mac mini");
  await customName.fill("Studio Mac mini");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  checks.push(
    "External assignment changes close stale drafts and current values are accessible",
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
  await trigger("Fixture Roku input").click();
  await expect(dialog.getByRole("status")).toContainText("Release the device");
  for (const option of await options().all())
    await expect(option).toBeDisabled();
  await filter("Family", "Other");
  await expect(
    dialog.getByRole("textbox", { name: "Custom device name", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "capture-rows-mobile.png"),
    fullPage: true,
  });
  await trigger("Fixture USB video").click();
  await filter("Family", "Other");
  await expect(
    dialog.getByRole("textbox", { name: "Custom device name", exact: true }),
  ).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  assert(
    dialogBounds &&
      dialogBounds.x >= 0 &&
      dialogBounds.y >= 0 &&
      dialogBounds.x + dialogBounds.width <= 390 &&
      dialogBounds.y + dialogBounds.height <= 844,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: path.join(output, "custom-name-mobile.png"),
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger("Fixture USB video")).toContainText("Studio Mac mini");
  await trigger("Fixture USB video").click();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger("Fixture USB video")).toBeFocused();
  await page.getByText("Details", { exact: true }).first().click();
  await expect(fresh.locator(".hardware-id")).toBeVisible();
  checks.push(
    "Compact rows and picker fit mobile; Details, Cancel, Escape and focus restoration work",
  );
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
