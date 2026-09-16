import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const ep = JSON.parse(
  await readFile("work/range-card-fixture/endpoint.json", "utf8"),
);
const base = `http://127.0.0.1:${ep.port}`;
const out = path.resolve(process.env.QA_OUTPUT || "outputs/ranges-cards");
await mkdir(out, { recursive: true });
const api = async (op, args = {}) => {
  const r = await fetch(base + "/v1/operations/" + op, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const { ticket } = await fetch(base + "/v1/browser-ticket", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ep.token}`,
    "Content-Type": "application/json",
  },
  body: "{}",
}).then((r) => r.json());
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const nav = async (name) =>
  page
    .locator(".live-sidebar")
    .getByRole("button", {
      name: name === "Devices" ? /^Devices/ : name,
      exact: true,
    })
    .click();
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
const checkSelectedPeriod = async (label) => {
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgb(36, 91, 199)");
  await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.mouse.move(0, 0);
  await button.focus();
  await expect(button).toHaveCSS("background-color", "rgb(36, 91, 199)");
  await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
  await button.hover();
};
try {
  await page.goto(`${base}/#ticket=${ticket}`);
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  await nav("Reports");
  for (const [label, preset] of [
    ["Day", "day"],
    ["Week", "week"],
    ["Month", "month"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const report = await api("reports.get", { preset });
    await expect(page.locator(".period-caption")).toContainText(
      `${report.range.start} to ${report.range.end}`,
    );
    await expect(
      page
        .locator(".range-metrics article")
        .filter({ hasText: "Sessions used" })
        .locator("strong"),
    ).toHaveText(String(report.sessions));
    await checkSelectedPeriod(label);
  }
  await page.screenshot({
    path: path.join(out, "local-reports-month.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await checkSelectedPeriod("Custom");
  await page.getByLabel("Start date", { exact: true }).fill("2099-03-04");
  await page.getByLabel("End date", { exact: true }).fill("2099-03-02");
  await expect(page.getByRole("alert")).toContainText("Start date must");
  assert.equal(await page.locator(".range-metrics").count(), 0);
  await page.getByLabel("End date", { exact: true }).fill("2099-03-05");
  await expect(
    page.getByText(
      "No usage or capture activity in this period. Choose another date range.",
    ),
  ).toBeVisible();
  for (const metric of await page
    .locator(".range-metrics strong")
    .allTextContents())
    assert.ok(metric === "0" || metric === "0h 0m 0s");
  await page.reload();
  await nav("Reports");
  await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
    "2099-03-04",
  );
  await expect(
    page.getByRole("button", { name: "Custom", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".range-metrics")).toBeVisible();
  await nav("Capture Cards");
  await card("Fixture Cam Link").waitFor();
  assert.equal(await page.locator(".capture-card").count(), 3);
  await expect(card("Fixture disconnected HDMI")).toContainText(
    "Capture card disconnected",
  );
  await card("Fixture disconnected HDMI").locator("summary").click();
  await expect(card("Fixture disconnected HDMI").locator("code")).toHaveText(
    "fixture-usb-b",
  );
  await expect(
    card("Fixture disconnected HDMI").getByText(
      "Fixture agent · Reserved binding proof",
      { exact: true },
    ),
  ).toBeVisible();
  await card("Fixture disconnected HDMI").locator("summary").click();
  await assignedDevice("Fixture disconnected HDMI").click();
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
  // Normalize any prior fixture run, keeping the held disconnected card reserved.
  const config = await api("config.get");
  for (const d of config.config.devices)
    if (d.id !== "busy") d.captureSourceId = d.id === "desk" ? "saved-a" : null;
  await api("config.save", {
    config: config.config,
    revision: config.revision,
  });
  await page.reload();
  await nav("Capture Cards");
  await card("Fixture spare HDMI").waitFor();
  await assignedDevice("Fixture spare HDMI").click();
  await expect(deviceOption("Fixture desk TV")).toContainText(
    "already has a capture input",
  );
  await expect(deviceOption("Fixture desk TV")).toBeDisabled();
  await deviceOption("Fixture spare TV").click();
  await expect(picker).not.toBeVisible();
  await expect(assignedDevice("Fixture spare HDMI")).toContainText(
    "Fixture spare TV",
  );
  const saved = await api("config.get");
  assert.equal(
    saved.config.sources.find((s) => s.id === "fixture-usb-c").uniqueId,
    "fixture-usb-c",
  );
  assert.equal(
    saved.config.devices.find((d) => d.id === "spare").captureSourceId,
    "fixture-usb-c",
  );
  await nav("Devices");
  await expect(
    page.getByRole("combobox", {
      name: "Capture input for Fixture spare TV",
      exact: true,
    }),
  ).toHaveValue("fixture-usb-c");
  await page.reload();
  await nav("Capture Cards");
  await expect(assignedDevice("Fixture spare HDMI")).toContainText(
    "Fixture spare TV",
  );
  await page
    .getByRole("button", { name: "Discover / refresh", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discover / refresh", exact: true }),
  ).toBeEnabled();
  await expect(assignedDevice("Fixture spare HDMI")).toContainText(
    "Fixture spare TV",
  );
  await page.screenshot({
    path: path.join(out, "local-capture-cards-fixture.png"),
    fullPage: true,
  });
  await assignedDevice("Fixture spare HDMI").click();
  await picker.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(assignedDevice("Fixture spare HDMI")).toContainText(
    "Choose a device…",
  );
  await assignedDevice("Fixture Cam Link").click();
  await deviceOption("Fixture spare TV").click();
  await expect(picker).not.toBeVisible();
  await expect(assignedDevice("Fixture Cam Link")).toContainText(
    "Fixture spare TV",
  );
  assert.equal(
    (await api("config.get")).config.devices.find((d) => d.id === "desk")
      .captureSourceId,
    null,
  );
  await card("Fixture Cam Link")
    .getByRole("button", { name: "View Fixture spare TV", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Fixture spare TV", exact: true }),
  ).toBeVisible();
  await nav("Capture Cards");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(out, "capture-cards-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await nav("Reports");
  await expect(page.locator(".range-metrics")).toBeVisible();
  await page.screenshot({
    path: path.join(out, "reports-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, "validation.json"),
    JSON.stringify(
      {
        calendarPresets: true,
        selectedPeriodHoverAndFocusContrast: true,
        countsMatchApi: true,
        invalidAndEmptyRanges: true,
        rangePersisted: true,
        stableIdentityAssignment: true,
        conflictsPrevented: true,
        reservedAssignmentBlocked: true,
        bindingSurvivesReloadAndRediscovery: true,
        deviceSelectorConsistent: true,
        unassignAndReassign: true,
        viewerLink: true,
        mobileNoBodyOverflow: true,
        fixtureOnly: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("Range and Capture Cards browser checks passed.");
} finally {
  await browser.close();
}
