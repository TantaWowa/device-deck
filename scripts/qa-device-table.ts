// Browser checks shared by the isolated local UI fixture; no device operations.
import assert from "node:assert/strict";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

export async function exerciseDeviceTable(
  page: Page,
  output: string,
  base: string,
) {
  const table = page.locator(".live-table");
  const names = table.locator("tbody .live-device-name");
  const search = page.getByRole("searchbox", {
    name: "Search devices",
    exact: true,
  });
  const reset = page
    .locator(".live-filters")
    .getByRole("button", { name: "Reset", exact: true });
  const row = (name: string) =>
    table
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name, exact: true }) });
  const choose = (group: string, name: string) =>
    page
      .getByRole("group", { name: group, exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  const snapshotNames = await names.allTextContents();
  const ascending = [...snapshotNames].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const nameHeader = table
    .getByRole("columnheader", { name: /Device/ })
    .filter({ has: page.getByRole("button") });
  if ((await nameHeader.getAttribute("aria-sort")) !== "ascending")
    await nameHeader.getByRole("button").click();
  await expect(names).toHaveText(ascending);
  await page
    .getByRole("checkbox", { name: "Select Pixel 9", exact: true })
    .check();
  await nameHeader.getByRole("button").click();
  await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  await expect(names).toHaveText([...ascending].reverse());
  await expect(
    page.getByRole("checkbox", { name: "Select Pixel 9", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Select Pixel 9", exact: true })
    .uncheck();
  for (const label of [
    "Connection",
    "Reservation / reason",
    "Capture input",
    "Visibility",
  ]) {
    const header = table.getByRole("columnheader", {
      name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
  }
  await nameHeader.getByRole("button").click();
  await expect(names).toHaveText(ascending);
  await expect(page.getByText("More filters", { exact: true })).toHaveCount(0);
  for (const group of [
    "Filter platform",
    "Filter device environment",
    "Filter connection",
    "Filter availability",
    "Filter visibility",
  ]) {
    await expect(
      page.getByRole("group", { name: group, exact: true }),
    ).toBeVisible();
  }
  await search.fill("  pIxEl  ");
  await expect(names).toHaveText(["Pixel 9"]);
  await search.clear();
  await choose("Filter connection", "Offline");
  await expect(names).toHaveText(["iPhone 16 simulator"]);
  await reset.click();
  await choose("Filter visibility", "Shared");
  await expect(names).toHaveText(["Apple TV simulator"]);
  await reset.click();
  await choose("Filter platform", "Apple 2");
  await choose("Filter device environment", "Sim");
  await expect(names).toHaveText(["Apple TV simulator", "iPhone 16 simulator"]);
  await reset.click();
  const searchBounds = await search.boundingBox();
  const platformBounds = await page
    .getByRole("group", { name: "Filter platform", exact: true })
    .boundingBox();
  assert(
    searchBounds &&
      platformBounds &&
      searchBounds.width <= 260 &&
      searchBounds.x > platformBounds.x + platformBounds.width,
  );
  await page.screenshot({
    path: path.join(output, "devices-toolbar-desktop.png"),
    fullPage: true,
  });

  const panel = page.getByRole("region", {
    name: "Remote for Pixel 9",
    exact: true,
  });
  const remote = row("Pixel 9").getByRole("button", {
    name: "Remote · Pixel 9",
    exact: true,
  });
  const screenshot = row("Pixel 9").getByRole("button", {
    name: "Screenshot · Pixel 9",
    exact: true,
  });
  const boundsNear = async (
    popup: Locator,
    trigger: Locator,
    above = false,
  ) => {
    await expect(popup).toBeVisible();
    await expect
      .poll(async () => {
        const p = await popup.boundingBox(),
          b = await trigger.boundingBox();
        if (!p || !b) return false;
        const viewport = page.viewportSize()!;
        const expectedX = Math.max(
          8,
          Math.min(
            b.x + b.width / 2 - p.width / 2,
            viewport.width - p.width - 8,
          ),
        );
        return (
          p.x >= 0 &&
          p.y >= 0 &&
          p.x + p.width <= viewport.width + 1 &&
          p.y + p.height <= viewport.height + 1 &&
          Math.abs(p.x - expectedX) <= 2 &&
          (above
            ? Math.abs(p.y + p.height + 8 - b.y) <= 2
            : Math.min(
                Math.abs(p.y + p.height + 8 - b.y),
                Math.abs(p.y - b.y - b.height - 8),
              ) <= 2)
        );
      })
      .toBe(true);
  };
  await remote.click();
  await boundsNear(panel, remote, true);
  await nameHeader.getByRole("button").click();
  await expect(names.first()).toHaveText("Pixel 9");
  await boundsNear(panel, remote, true);
  await nameHeader.getByRole("button").click();
  await expect(names).toHaveText(ascending);
  await remote.scrollIntoViewIfNeeded();
  await boundsNear(panel, remote, true);
  await page.evaluate(() => window.scrollBy(0, -24));
  await boundsNear(panel, remote, true);
  await page.screenshot({
    path: path.join(output, "device-remote-anchored.png"),
  });
  const bar = panel.locator(".floating-remote-bar");
  const barBounds = await bar.boundingBox();
  assert(barBounds);
  await page.mouse.move(barBounds.x + 45, barBounds.y + 16);
  await page.mouse.down();
  await page.mouse.move(barBounds.x - 75, barBounds.y - 24, { steps: 5 });
  await page.mouse.up();
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await screenshot.click();
  await boundsNear(panel, screenshot, true);
  await expect(panel.getByText("Quick capture", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.join(output, "device-screenshot-anchored.png"),
  });
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  const identify = row("Pixel 9").getByRole("button", {
    name: "Identify · Pixel 9",
    exact: true,
  });
  await identify.click();
  const info = page.getByRole("dialog", {
    name: "Identify · Pixel 9",
    exact: true,
  });
  await boundsNear(info, identify, true);
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);
  await expect(identify).toBeFocused();

  await page.goto(
    `${base}/?view=feeds&layout=grid&sources=saved-auto,saved-roku`,
  );
  const feedRemote = page.getByRole("button", {
    name: "Remote · Fixture USB video",
    exact: true,
  });
  await feedRemote.click();
  const feedPanel = page.getByRole("region", {
    name: "Remote for Auto feed",
    exact: true,
  });
  await boundsNear(feedPanel, feedRemote);
  await page.screenshot({
    path: path.join(output, "feed-remote-anchored.png"),
  });
  await feedPanel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(true);
  await feedRemote.click();
  await boundsNear(feedPanel, feedRemote);
  assert(
    await feedPanel.evaluate((element) =>
      document.fullscreenElement?.contains(element),
    ),
  );
  await feedPanel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await page.evaluate(() => document.exitFullscreen());
  await page
    .locator(".live-sidebar")
    .getByRole("button", { name: /^Devices/ })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const group of [
    "Filter connection",
    "Filter availability",
    "Filter visibility",
  ])
    await expect(
      page.getByRole("group", { name: group, exact: true }),
    ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: path.join(output, "devices-toolbar-mobile.png"),
    fullPage: true,
  });
  await remote.click();
  await boundsNear(panel, remote);
  await page.screenshot({
    path: path.join(output, "device-remote-mobile.png"),
  });
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => window.scrollTo(0, 0));
  return [
    "Sortable device columns preserve selection; all filter buttons are visible with a compact right-hand search",
    "Device and feed actions open above their trigger, clamp to the viewport and re-anchor after dragging",
  ];
}
