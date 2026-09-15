import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = path.resolve(process.env.QA_OUTPUT || "outputs/picker-demo");
await mkdir(out, { recursive: true });
const nav = (name) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
const card = (name) => page.getByRole("article", { name, exact: true });
const assignedDevice = (name) =>
  card(name).getByRole("button", {
    name: `Assigned device for ${name}`,
    exact: true,
  });
const picker = page.getByRole("dialog");
const deviceOption = (name) =>
  picker.locator(".device-picker-list .device-picker-option").filter({
    hasText: name,
  });
try {
  await page.goto(`${process.env.QA_URL || "http://127.0.0.1:5195"}/demo/`);
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
  await assignedDevice("Cam Link 4K · USB 01 / HDMI").click();
  await expect(picker.getByRole("status")).toContainText(
    "Release the device and finish recording before changing its assignment.",
  );
  const reservedOptions = picker.locator(".device-picker-option");
  assert.ok((await reservedOptions.count()) > 0);
  for (const option of await reservedOptions.all())
    await expect(option).toBeDisabled();
  await expect(
    picker.getByRole("button", { name: "Unassign", exact: true }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker).not.toBeVisible();
  const spareName = "AVerMedia Mini · USB 03 / HDMI";
  await assignedDevice(spareName).click();
  await deviceOption("Travel Roku").click();
  await expect(picker).not.toBeVisible();
  await expect(assignedDevice(spareName)).toContainText("Travel Roku");
  await page.reload();
  await expect(assignedDevice(spareName)).toContainText("Travel Roku");
  await page
    .getByRole("button", { name: "Discover / refresh", exact: true })
    .click();
  await expect(assignedDevice(spareName)).toContainText("Travel Roku");
  await page.screenshot({
    path: path.join(out, "demo-capture-cards.png"),
    fullPage: true,
  });
  await assignedDevice(spareName).click();
  await picker.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(assignedDevice(spareName)).toContainText("Choose a device…");
  assert.deepEqual(errors, []);
  console.log(
    "Demo period contrast, custom empty range/persistence, card assignment/reload/refresh/unassign and reserved controls passed.",
  );
} finally {
  await browser.close();
}
