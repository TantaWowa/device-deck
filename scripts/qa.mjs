import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
const base = process.env.QA_URL || "http://127.0.0.1:5175";
const output = process.env.QA_OUTPUT || "outputs";
await mkdir(output, { recursive: true });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {},
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const state = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("device-deck-demo-v2") || "null"),
  );
const nav = async (name) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
const close = () => page.getByRole("button", { name: "Close dialog" }).click();
const reset = async () => {
  await page.goto(base + "/demo/");
  await page.evaluate(() => localStorage.removeItem("device-deck-demo-v2"));
  await page.reload();
};
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS", name);
}
try {
  await page.goto(base);
  await check(
    "marketing assets, flat images, client tabs and internal links",
    async () => {
      await page.evaluate(() =>
        document.querySelectorAll("img").forEach((i) => (i.loading = "eager")),
      );
      await page.waitForFunction(() =>
        [...document.images].every((i) => i.complete && i.naturalWidth),
      );
      for (const tab of ["MCP", "API", "JSON", "CLI"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        assert.equal(
          await page
            .getByRole("tab", { name: tab, exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
      }
      const links = await page
        .locator("a[href]")
        .evaluateAll((as) => [
          ...new Set(as.map((a) => a.getAttribute("href"))),
        ]);
      for (const href of links) {
        if (href.startsWith("#"))
          assert.equal(await page.locator(href).count(), 1);
        else if (href.startsWith("/"))
          assert.equal(
            (await page.request.get(new URL(href, base).href)).status(),
            200,
          );
      }
      assert.equal(
        await page
          .locator("img")
          .evaluateAll((imgs) =>
            imgs.some((img) => getComputedStyle(img).transform !== "none"),
          ),
        false,
      );
    },
  );
  await page.screenshot({
    path: `${output}/website-desktop.png`,
    fullPage: true,
  });
  await reset();
  await check("combined filters, counts, saved view and reset", async () => {
    await page
      .getByRole("combobox", { name: "Platform", exact: true })
      .selectOption("Android");
    await page
      .getByRole("combobox", { name: "Device type", exact: true })
      .selectOption("virtual");
    await page
      .getByRole("combobox", { name: "Visibility", exact: true })
      .selectOption("local");
    await page.getByRole("textbox", { name: "Search devices" }).fill("Pixel");
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.match(
      await page.locator(".table-meta").innerText(),
      /1 of 8 devices/,
    );
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    await page.getByLabel("View name").fill("Android virtual");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reset filters", exact: true })
      .click();
    assert.equal(await page.locator("tbody tr").count(), 8);
    await page
      .getByRole("button", { name: "Android virtual", exact: true })
      .click();
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page
      .getByRole("textbox", { name: "Search devices" })
      .fill("no device");
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page
      .locator(".table-meta")
      .getByRole("button", { name: "Reset filters", exact: true })
      .click();
  });
  await check(
    "hover, keyboard focus and touch-style preview have unavailable states",
    async () => {
      const preview = page
        .getByTestId("device-roku-desk")
        .getByRole("button", { name: "Preview", exact: true });
      await preview.hover();
      assert.equal(
        await page
          .getByTestId("device-roku-desk")
          .locator(".hover-preview")
          .isVisible(),
        true,
      );
      await preview.focus();
      assert.equal(
        await page
          .getByTestId("device-roku-desk")
          .locator(".hover-preview")
          .isVisible(),
        true,
      );
      await preview.click();
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page
        .getByTestId("device-roku-stick")
        .getByRole("button", { name: "Preview", exact: true })
        .click();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Device offline/,
      );
      await close();
    },
  );
  await check(
    "USB source conflict is visible and preserves binding, available source can be selected",
    async () => {
      const source = page.getByRole("combobox", {
        name: "Capture input for Desk Roku",
        exact: true,
      });
      assert.equal(await source.isDisabled(), true);
      await page
        .getByRole("button", { name: "Desk Roku", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Release session", exact: true })
        .click();
      await nav("Devices");
      await source.selectOption("hd60");
      assert.match(
        await page.getByRole("alert").innerText(),
        /Source conflict.*Living room TV/,
      );
      assert.equal(await source.inputValue(), "cam-link");
      await source.selectOption("avermedia");
      assert.equal(await source.inputValue(), "avermedia");
      assert.equal(
        await page
          .getByRole("combobox", {
            name: "Capture input for Living room TV",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "Desk Roku", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Reserve device", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByLabel("Reason")
        .fill("Source binding checked");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /Reserve for/ })
        .click();
      await nav("Devices");
    },
  );
  await check(
    "add and edit validation prevents duplicate names and native source on physical devices",
    async () => {
      await page
        .getByRole("button", { name: "Add device", exact: true })
        .click();
      await page.getByLabel("Friendly name").fill("Desk Roku");
      await page
        .getByRole("button", { name: "Save device", exact: true })
        .click();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /already in use/,
      );
      await page.getByLabel("Friendly name").fill("QA simulator");
      await page
        .getByRole("dialog")
        .getByLabel("Platform", { exact: true })
        .selectOption("Apple");
      assert.equal(
        await page.getByLabel("Simulated remote input capability").isChecked(),
        false,
      );
      await page
        .getByRole("dialog")
        .getByLabel("Device type", { exact: true })
        .selectOption("virtual");
      await page.getByLabel("Simulated remote input capability").check();
      await page
        .getByRole("dialog")
        .getByLabel("Capture input", { exact: true })
        .selectOption("native");
      await page
        .getByRole("button", { name: "Save device", exact: true })
        .click();
      assert.equal(await page.locator("tbody tr").count(), 9);
      await page
        .getByRole("button", { name: "Edit QA simulator", exact: true })
        .click();
      await page.getByLabel("Friendly name").fill("QA simulator edited");
      await page
        .getByRole("button", { name: "Save device", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "QA simulator edited", exact: true })
          .count(),
        1,
      );
    },
  );
  await check(
    "selection survives filters; bulk lock skips a reservation and unlock is distinct",
    async () => {
      await page
        .getByRole("checkbox", { name: "Select Desk Roku", exact: true })
        .check();
      await page
        .getByRole("checkbox", {
          name: "Select Apple TV simulator",
          exact: true,
        })
        .check();
      await page.getByRole("textbox", { name: "Search devices" }).fill("Desk");
      assert.match(
        await page.locator(".selection-bar").innerText(),
        /includes hidden rows/,
      );
      await page.getByRole("button", { name: "Lock", exact: true }).click();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Will skip · Reserved/,
      );
      await page
        .getByRole("button", { name: "Run simulated operation", exact: true })
        .click();
      await page.getByRole("button", { name: "Done", exact: true }).waitFor();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Completed · Maintenance locked/,
      );
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Skipped · Reserved/,
      );
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await page
        .getByRole("button", { name: "Run simulated operation", exact: true })
        .click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert.equal(
        (await state()).inventory.leases.some(
          (l) => l.deviceId === "roku-desk",
        ),
        true,
      );
      await page.getByRole("button", { name: "Restart", exact: true }).click();
      await page
        .getByRole("button", { name: "Run simulated operation", exact: true })
        .click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page
        .getByRole("button", { name: "Reset filters", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Clear selection", exact: true })
        .click();
    },
  );
  await check(
    "focused viewer targets input, clipboard writes a labelled PNG, recording log aligns with session",
    async () => {
      await page
        .getByRole("button", { name: "Desk Roku", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Record video", exact: true })
        .click();
      await page.getByRole("button", { name: "Right", exact: true }).click();
      assert.match(
        await page.locator(".sample-title h3").innerText(),
        /quiet coast/,
      );
      assert.match(await page.locator(".key-overlay").innerText(), /Right/);
      assert.match(await page.locator(".input-log").innerText(), /Right/);
      await page
        .getByRole("checkbox", { name: "Enable keyboard remote", exact: true })
        .check();
      await page.locator("h1").click();
      await page.keyboard.press("ArrowRight");
      assert.match(
        await page.locator(".sample-title h3").innerText(),
        /mountains/,
      );
      const count = (await state()).inputs.length;
      await page.getByRole("textbox", { name: "Text to device" }).fill("QA");
      await page.keyboard.press("ArrowLeft");
      assert.equal((await state()).inputs.length, count);
      await page
        .getByRole("button", { name: "Send text", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Copy sample PNG", exact: true })
        .click();
      await page.waitForFunction(async () => {
        const items = await navigator.clipboard.read();
        return items.some((x) => x.types.includes("image/png"));
      });
      await page.getByRole("button", { name: /Stop recording/ }).click();
      const saved = (await state()).artifacts[0];
      assert.equal(saved.kind, "recording");
      assert.ok(saved.log.length >= 3);
      assert.ok(
        saved.log.every(
          (x) =>
            x.deviceId === "roku-desk" &&
            x.sessionId === saved.sessionId &&
            x.elapsedMs >= 0,
        ),
      );
      await page
        .getByRole("button", { name: "Screenshot", exact: true })
        .click();
      assert.equal((await state()).artifacts[0].kind, "screenshot");
    },
  );
  await check(
    "session release prevents input, reserve restores it, other owners remain protected",
    async () => {
      await page
        .getByRole("button", { name: "Release session", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Right", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "Reserve device", exact: true })
        .click();
      await page.getByLabel("Owner label").fill("QA human");
      await page.getByLabel("Reservation reason").fill("Browser flow");
      await page
        .getByRole("button", { name: /Reserve for .* minutes/ })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Right", exact: true })
          .isDisabled(),
        false,
      );
      await page.goto(base + "/demo/#viewer/android-tv");
      assert.equal(
        await page
          .getByRole("button", { name: "Right", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Release session", exact: true })
          .isDisabled(),
        true,
      );
    },
  );
  await check(
    "multi-view changes target without broadcasting remote input",
    async () => {
      await page.goto(
        base + "/demo/#multi/roku-desk,apple-sim,pixel-emulator,android-tv",
      );
      await page
        .getByRole("button", {
          name: "Control Apple TV simulator",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Reserve device", exact: true })
        .click();
      await page.getByLabel("Reservation reason").fill("Grid check");
      await page
        .getByRole("button", { name: /Reserve for .* minutes/ })
        .click();
      const before = (await state()).inputs.filter(
        (i) => i.deviceId === "roku-desk",
      ).length;
      await page.getByRole("button", { name: "Left", exact: true }).click();
      assert.equal((await state()).inputs[0].deviceId, "apple-sim");
      assert.equal(
        (await state()).inputs.filter((i) => i.deviceId === "roku-desk").length,
        before,
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "Control Apple TV simulator",
            exact: true,
          })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page
        .getByRole("button", { name: "Control Living room TV", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Left", exact: true })
          .isDisabled(),
        true,
      );
    },
  );
  await check(
    "capture filters, rename and tags, selection removal, undo and session navigation",
    async () => {
      await nav("Capture library");
      await page
        .getByRole("textbox", { name: "Search capture names or tags" })
        .fill("browse-focus");
      await page
        .getByRole("button", { name: "browse-focus.png", exact: true })
        .click();
      await page
        .getByLabel("Capture name", { exact: true })
        .fill("QA review.png");
      await page.getByLabel("Tags, separated by commas").fill("qa, navigation");
      await page
        .getByRole("button", { name: "Save name & tags", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Search capture names or tags" })
        .fill("qa");
      assert.equal(await page.locator(".capture-card").count(), 1);
      await page
        .getByRole("checkbox", {
          name: "Select filtered captures",
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "Remove selected", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Remove entries", exact: true })
        .click();
      assert.equal(await page.locator(".capture-card").count(), 0);
      await page
        .getByRole("button", { name: "Undo removal", exact: true })
        .click();
      assert.equal(await page.locator(".capture-card").count(), 1);
      await page
        .getByRole("button", { name: "Reset filters", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Capture type", exact: true })
        .selectOption("recording");
      assert.ok((await page.locator(".capture-card").count()) >= 3);
      await nav("Usage history");
      await page
        .getByRole("button", { name: "Session captures", exact: false })
        .first()
        .click();
      assert.match(page.url(), /#captures\/session\//);
      assert.equal(
        await page
          .getByRole("combobox", { name: "Capture type", exact: true })
          .inputValue(),
        "",
      );
    },
  );
  await check(
    "settings validate and persist across reload with modified inventory and saved views",
    async () => {
      await nav("Settings");
      await page.getByLabel("Screenshot & video folder").fill("relative");
      await page
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      assert.match(
        await page.getByRole("alert").innerText(),
        /absolute Mac folder/,
      );
      await page
        .getByLabel("Screenshot & video folder")
        .fill("~/Movies/QA Captures");
      await page.getByLabel("Default owner label").fill("QA operator");
      await page.getByLabel("Default capture output").selectOption("annotated");
      await page
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await page.reload();
      assert.equal(
        await page.getByLabel("Screenshot & video folder").inputValue(),
        "~/Movies/QA Captures",
      );
      await nav("Devices");
      assert.equal(
        await page
          .getByRole("button", { name: "QA simulator edited", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Android virtual", exact: true })
          .count(),
        1,
      );
    },
  );
  await check(
    "CLI examples and reporting remain labelled illustrative or seeded",
    async () => {
      await nav("CLI & agents");
      assert.match(await page.locator(".notice").innerText(), /illustrative/);
      assert.match(await page.locator("main").innerText(), /ambiguous-match/);
      for (const tab of ["MCP", "API", "JSON", "CLI"])
        await page.getByRole("tab", { name: tab, exact: true }).click();
      await nav("Reports");
      await page.getByRole("group", { name: "Report period" }).waitFor();
      assert.match(
        await page.locator(".workspace-heading").innerText(),
        /Seeded report/,
      );
      await page.waitForSelector(".range-metrics article");
      assert.equal(await page.locator(".range-metrics article").count(), 5);
    },
  );
  await check(
    "browser clipboard failure gives a real sample download fallback",
    async () => {
      const fallback = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      await fallback.addInitScript(() =>
        Object.defineProperty(navigator, "clipboard", {
          value: { write: () => Promise.reject(new Error("blocked")) },
          configurable: true,
        }),
      );
      await fallback.goto(base + "/demo/#viewer/roku-desk");
      await fallback
        .getByRole("button", { name: "Copy sample PNG", exact: true })
        .click();
      assert.match(
        await fallback.getByRole("dialog").innerText(),
        /could not write an image/,
      );
      const dl = fallback.waitForEvent("download");
      await fallback
        .getByRole("button", { name: "Download sample PNG", exact: true })
        .click();
      assert.equal((await dl).suggestedFilename(), "device-deck-sample.png");
      await fallback.close();
    },
  );
  await check(
    "reset restores all seeded state and default settings",
    async () => {
      await nav("Settings");
      await page
        .getByRole("button", { name: "Reset demo", exact: true })
        .last()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Reset demo", exact: true })
        .click();
      assert.equal(await page.locator("tbody tr").count(), 8);
      assert.equal((await state()).settings.folder, "~/Movies/Device Deck");
      assert.equal((await state()).savedViews.length, 0);
    },
  );
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of [
      "/",
      "/demo/",
      "/demo/#viewer/roku-desk",
      "/demo/#multi/roku-desk,apple-sim,pixel-emulator,android-tv",
      "/demo/#captures",
      "/demo/#history",
      "/demo/#reports",
      "/demo/#settings",
      "/demo/#connect",
    ]) {
      await page.goto(base + route);
      await page.evaluate(() =>
        document.querySelectorAll("img").forEach((i) => (i.loading = "eager")),
      );
      await page.waitForFunction(() =>
        [...document.images].every((i) => i.complete && i.naturalWidth),
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${route} overflows at ${width}`,
      );
      if (width === 390)
        await page.screenshot({
          path: `${output}/${route === "/" ? "website" : route.includes("#") ? route.split("#")[1].split("/")[0] : "table"}-mobile.png`,
          fullPage: true,
        });
    }
  }
  checks.push(
    "all nine routes fit 390, 768 and 1440px with table-only horizontal scrolling",
  );
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(base);
  await check("mobile marketing menu and app navigation work", async () => {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .getByRole("link", { name: "Development status", exact: true })
      .click();
    assert.match(page.url(), /#status$/);
    await page.goto(base + "/demo/");
    await nav("Settings");
    assert.equal(
      await page
        .getByRole("heading", { name: "Local settings", exact: true })
        .count(),
      1,
    );
  });
  assert.deepEqual(errors, []);
  const report = { base, checks, consoleErrors: errors };
  await writeFile(`${output}/qa-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await page.screenshot({ path: `${output}/qa-failure.png`, fullPage: true });
  throw e;
} finally {
  await browser.close();
}
