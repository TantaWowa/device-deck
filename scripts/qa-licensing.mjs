import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const exec = promisify(execFile),
  directory = path.resolve("work/licensing-fixture"),
  out = path.resolve("../../outputs/licensing-0.4.0");
await mkdir(out, { recursive: true });
const ep = JSON.parse(
    await readFile(path.join(directory, "endpoint.json"), "utf8"),
  ),
  base = `http://127.0.0.1:${ep.port}`;
const env = { ...process.env, DEVICE_DECK_HOME: directory };
const request = async (op, args = {}) => {
  const response = await fetch(base + "/v1/operations/" + op, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json() };
};
const api = async (op, args = {}) => {
  const r = await request(op, args);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const client = new Client({ name: "licensing-boundary-proof", version: "1" });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let lease;
try {
  const status = await api("license.status");
  assert.equal(status.tier, "free");
  assert.equal(status.configured, false);
  const cli = JSON.parse(
    (
      await exec(
        process.execPath,
        ["build/devdeck.mjs", "license", "status", "--json"],
        { env },
      )
    ).stdout,
  );
  assert.deepEqual(cli, status);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["build/mcp.mjs"],
      env,
      stderr: "pipe",
    }),
  );
  const mcpStatus = await client.callTool({
    name: "license_status",
    arguments: {},
  });
  assert.deepEqual(JSON.parse(mcpStatus.content[0].text), status);
  const reserved = await api("sessions.reserve", {
    selector: { device: "one" },
    owner: "Licensing QA",
    reason: "Free boundary proof",
  });
  lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
  const args = {
    selector: { device: "two" },
    owner: "Licensing QA",
    reason: "Second device boundary",
  };
  const denied = await request("sessions.reserve", args);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "pro-required");
  await assert.rejects(
    exec(
      process.execPath,
      [
        "build/devdeck.mjs",
        "reserve",
        "--device",
        "two",
        "--owner",
        "Licensing QA",
        "--reason",
        "CLI boundary",
        "--json",
      ],
      { env },
    ),
    (e) => e.code === 1 && JSON.parse(e.stderr).error === "pro-required",
  );
  const mcpDenied = await client.callTool({
    name: "sessions_reserve",
    arguments: args,
  });
  assert.equal(mcpDenied.isError, true);
  assert.equal(JSON.parse(mcpDenied.content[0].text).error, "pro-required");
  assert.equal(
    (await request("recordings.start", { ...lease, mode: "annotated" })).body
      .error,
    "pro-required",
  );
  const { ticket } = await fetch(base + "/v1/browser-ticket", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  }).then((r) => r.json());
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/#ticket=" + ticket);
  const nav = (name) =>
    page
      .locator(".live-sidebar")
      .getByRole("button", { name, exact: true })
      .click();
  await nav("License");
  await expect(
    page.getByRole("heading", { name: "License & Upgrade" }),
  ).toBeVisible();
  await expect(page.locator(".license-tier")).toHaveText("Free");
  await expect(page.getByLabel("License key", { exact: true })).toBeDisabled();
  await expect(page.getByText("Checkout setup is pending.")).toBeVisible();
  await page.screenshot({
    path: path.join(out, "license-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(out, "license-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .locator(".live-sidebar")
    .getByRole("button", { name: /^Devices/ })
    .click();
  await page
    .getByRole("button", { name: "Dismiss for a week", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".license-reminder")).toHaveCount(0);
  await page
    .getByRole("button", { name: "License fixture two", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reserve device", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Owner label").fill("Web QA");
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill("Free boundary proof");
  await dialog
    .getByRole("button", { name: "Reserve device", exact: true })
    .click();
  await expect(page.locator(".live-alert")).toContainText(
    "Free supports one active device session",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    (await api("inventory")).sessions.filter((s) => s.state !== "closed")
      .length,
    1,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, "browser-and-clients.json"),
    JSON.stringify(
      {
        passed: true,
        unconfiguredFree: true,
        statusParity: ["HTTP", "CLI", "MCP"],
        admissionDenied: ["HTTP", "CLI", "MCP", "Web"],
        annotationsDenied: true,
        reminderPersists: true,
        mobileNoOverflow: true,
        pageErrors: errors,
        physicalHardwareUsed: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "Free licensing boundary matches HTTP, CLI, MCP and Web; UI, reminder and mobile checks passed.",
  );
} finally {
  if (lease) await api("sessions.release", lease);
  await client.close();
  await browser.close();
}
