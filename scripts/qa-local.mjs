import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.env.DEVICE_DECK_HOME;
if (!directory) throw new Error("Use isolated DEVICE_DECK_HOME.");
const ep = JSON.parse(
    await readFile(path.join(directory, "endpoint.json"), "utf8"),
  ),
  base = `http://127.0.0.1:${ep.port}`;
const out = path.resolve("../../outputs/local-app");
await mkdir(out, { recursive: true });
const getTicket = async () => {
  const r = await fetch(base + "/v1/browser-ticket", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  return (await r.json()).ticket;
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1536, height: 1100 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${base}/#ticket=${await getTicket()}`);
  await page.getByRole("heading", { name: "Devices", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(out, "device-table.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await page
    .getByRole("img", { name: "Live screen of Device Deck Proof" })
    .waitFor();
  await page
    .getByRole("button", { name: "Reserve device", exact: true })
    .click();
  await page.getByLabel("Owner label", { exact: true }).fill("Browser proof");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Real local web session");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reserve device", exact: true })
    .click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Screenshot", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Screenshot saved to the capture library." })
    .waitFor();
  await expect(
    page.getByRole("button", { name: "Screenshot", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: path.join(out, "device-viewer.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .waitFor();
  // Closing the entire browser context must leave the daemon-owned recording running.
  await context.close();
  const snapshot = await fetch(base + "/v1/operations/inventory", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }).then((r) => r.json());
  if (!snapshot.recordings.length)
    throw new Error("Recording stopped on browser close");
  const session = snapshot.sessions.find(
    (s) => s.owner === "Browser proof" && s.state === "active",
  );
  // Restore the saved browser credential through an explicit storage export would require another token.
  // This test uses visible takeover to finalize the detached recording and reacquire the isolated target.
  const second = await browser.newContext({
    viewport: { width: 1536, height: 1100 },
  });
  const p = await second.newPage();
  await p.goto(`${base}/#ticket=${await getTicket()}`);
  await p.getByRole("button", { name: "View", exact: true }).first().click();
  await p.getByRole("button", { name: "Take over…", exact: true }).click();
  await p
    .getByLabel("Owner label", { exact: true })
    .fill("Browser proof cleanup");
  await p
    .getByLabel("Reason", { exact: true })
    .fill("Finish browser-close persistence check");
  await p
    .getByRole("button", { name: "Take over and reserve", exact: true })
    .click();
  await p.getByRole("button", { name: "Release", exact: true }).waitFor();
  await p.getByRole("button", { name: "Release", exact: true }).click();
  await p.getByRole("button", { name: "Captures", exact: true }).click();
  await p.locator(".live-captures article").first().waitFor();
  await p.screenshot({
    path: path.join(out, "capture-library.png"),
    fullPage: true,
  });
  await p.getByRole("button", { name: "Reports", exact: true }).click();
  await p.screenshot({
    path: path.join(out, "usage-report.png"),
    fullPage: true,
  });
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  await p
    .getByLabel("Owner label", { exact: true })
    .fill("Unsaved browser draft");
  const nativeApi = async (op, args = {}) => {
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
  const configBefore = await nativeApi("config.get");
  const edited = structuredClone(configBefore.config);
  edited.settings.owner = "External editor";
  await nativeApi("config.save", {
    config: edited,
    revision: configBefore.revision,
  });
  await p.waitForTimeout(2800);
  await p.getByRole("button", { name: "Save settings", exact: true }).click();
  await p
    .getByText(/Configuration changed on disk/)
    .first()
    .waitFor();
  if (
    (await nativeApi("config.get")).config.settings.owner !== "External editor"
  )
    throw new Error("Stale web draft overwrote newer JSON");
  await p
    .getByRole("button", { name: "Reload current configuration", exact: true })
    .click();
  await p
    .getByLabel("Owner label", { exact: true })
    .fill(configBefore.config.settings.owner);
  await p.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(
    p.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  await p.getByRole("button", { name: /^Devices/ }).click();
  await p
    .getByRole("checkbox", { name: "Select visible devices", exact: true })
    .check();
  await p.getByRole("button", { name: "View selected", exact: true }).click();
  await p
    .getByRole("button", {
      name: "Device Deck TV Proof Select target",
      exact: true,
    })
    .click();
  await p
    .getByRole("img", {
      name: "Live screen of Device Deck TV Proof",
      exact: true,
    })
    .waitFor();
  await p.screenshot({
    path: path.join(out, "multi-device-view.png"),
    fullPage: true,
  });
  await p.getByRole("button", { name: "All devices", exact: true }).click();
  await p.setViewportSize({ width: 390, height: 844 });
  await p.getByRole("button", { name: /^Devices/ }).click();
  await p.screenshot({
    path: path.join(out, "devices-mobile.png"),
    fullPage: true,
  });
  const overflow = await p.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (overflow) throw new Error("Mobile page overflows viewport");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    path.join(out, "web-validation.json"),
    JSON.stringify(
      {
        browserCloseRecordingSurvived: true,
        staleWebConfigDraftRejected: true,
        twoRealSimulatorPreviews: true,
        detachedSessionId: session.id,
        mobilePageOverflow: false,
        consoleErrors: errors,
        screenshots: [
          "device-table.png",
          "device-viewer.png",
          "capture-library.png",
          "usage-report.png",
          "devices-mobile.png",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "Local web flow, browser-close recording persistence, takeover, release and mobile layout passed.",
  );
} catch (e) {
  console.error(
    await page
      .locator("body")
      .innerText()
      .catch(() => "Page closed"),
  );
  await page
    .screenshot({ path: path.join(out, "failure.png"), fullPage: true })
    .catch(() => {});
  throw e;
} finally {
  await browser.close();
}
