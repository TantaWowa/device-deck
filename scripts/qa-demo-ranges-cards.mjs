import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = path.resolve("../../outputs/ranges-cards");
const nav = (name) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
try {
  await page.goto("http://127.0.0.1:5195/demo/");
  await nav("Reports");
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.locator(".range-metrics")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Month", exact: true }),
  ).toHaveCSS("background-color", "rgb(36, 91, 199)");
  await page.screenshot({
    path: path.join(out, "demo-reports-month.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Start date", { exact: true }).fill("2099-01-01");
  await page.getByLabel("End date", { exact: true }).fill("2099-01-02");
  await expect(
    page.getByText(
      "No usage or capture activity in this period. Choose another date range.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
    "2099-01-01",
  );
  await nav("Capture Cards");
  assert.equal(await page.locator(".capture-card").count(), 4);
  const reserved = page.getByRole("article", {
    name: "Cam Link 4K · USB 01 / HDMI",
    exact: true,
  });
  await expect(reserved.getByRole("combobox")).toBeDisabled();
  const spare = page.getByRole("article", {
    name: "AVerMedia Mini · USB 03 / HDMI",
    exact: true,
  });
  await spare.getByRole("combobox").selectOption("roku-stick");
  await spare.getByRole("button", { name: "Apply assignment" }).click();
  await expect(spare).toContainText("Travel Roku →");
  await page.reload();
  await expect(spare).toContainText("Travel Roku →");
  await page
    .getByRole("button", { name: "Discover / refresh", exact: true })
    .click();
  await expect(spare).toContainText("Travel Roku →");
  await page.screenshot({
    path: path.join(out, "demo-capture-cards.png"),
    fullPage: true,
  });
  await spare.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(spare.getByRole("combobox")).toHaveValue("");
  assert.deepEqual(errors, []);
  console.log(
    "Demo period contrast, custom empty range/persistence, card assignment/reload/refresh/unassign and reserved controls passed.",
  );
} finally {
  await browser.close();
}
