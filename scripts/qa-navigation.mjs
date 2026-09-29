// Isolated browser-history QA. Builds the dashboard into a temporary fixture
// and uses synthetic devices and captures only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";

let fixtureProcess;
let browser;

async function startFixture() {
  fixtureProcess = spawn(process.execPath, ["--import", "tsx", "scripts/qa-live-server.ts"], {
    env: { ...process.env, QA_CAPTURES: "1", QA_LIVE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Navigation fixture did not become ready.\n${log}`)),
      90_000,
    );
    for (const stream of [fixtureProcess.stdout, fixtureProcess.stderr])
      stream.on("data", (data) => {
        log += data.toString();
        const ready = /LIVE_QA_READY (\{[^\n]+\})/.exec(log);
        if (ready) {
          clearTimeout(timer);
          resolve(JSON.parse(ready[1]));
        }
      });
    fixtureProcess.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Navigation fixture exited (${code}).\n${log}`));
    });
  });
}

try {
  const fixture = await startFixture();
  assert.equal(new URL(fixture.base).hostname, "127.0.0.1");
  assert.equal(fixture.token, "synthetic-qa-token");
  const ticket = await fetch(`${fixture.base}/v1/browser-ticket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }).then((response) => response.json());

  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${fixture.base}/#ticket=${ticket.ticket}`);

  const tab = (name) => page.locator(".live-sidebar nav").getByRole("button", {
    name: new RegExp(`^${name}(?:\\s|$)`),
  });
  await expect(tab("Devices")).toHaveClass(/active/);
  await tab("Reports").click();
  await expect(page).toHaveURL(/\?view=reports$/);
  await tab("Settings").click();
  await expect(page).toHaveURL(/\?view=settings$/);
  await page.goBack();
  await expect(tab("Reports")).toHaveClass(/active/);
  await page.goBack();
  await expect(tab("Devices")).toHaveClass(/active/);
  await page.goForward();
  await expect(tab("Reports")).toHaveClass(/active/);

  await tab("Devices").click();
  const device = page.locator("tbody tr").filter({
    has: page.getByRole("button", { name: "Synthetic USB", exact: true }),
  });
  await device.getByRole("button", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(/view=devices&devices=usb/);
  await expect(page.getByRole("button", { name: "All devices" })).toBeVisible();
  await page.goBack();
  await expect(device).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("button", { name: "All devices" })).toBeVisible();

  await tab("Captures").click();
  await page.locator('[data-capture-id="seed-0"] .capture-tile-preview').click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/view=captures&capture=seed-0/);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tab("Captures")).toHaveClass(/active/);
  await page.goForward();
  await expect(page.getByRole("dialog")).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("PASS dashboard back/forward navigation");
} finally {
  await browser?.close();
  if (fixtureProcess && fixtureProcess.exitCode === null) {
    const closed = new Promise((resolve) => fixtureProcess.once("exit", resolve));
    fixtureProcess.kill("SIGTERM");
    const timer = setTimeout(() => fixtureProcess.kill("SIGKILL"), 15_000);
    await closed;
    clearTimeout(timer);
  }
}
