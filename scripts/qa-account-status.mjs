// Isolated UI proof: synthetic pairing responses only; never reads or changes host pairing.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const directory = await mkdtemp(path.join(os.tmpdir(), "deck-account-qa-"));
const output = path.resolve("outputs/account-qa");
await mkdir(output, { recursive: true });
let status = { paired: false }, responseStatus = 200;
let browser;
const results = { passed: false, cases: [] };
const server = createServer(async (request, response) => {
  if (request.url === "/v1/hub/status") {
    response.writeHead(responseStatus, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(status));
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{font-family:system-ui;margin:20px;background:#f4f7fa}main{max-width:1100px;margin:auto}h1{font-size:22px}</style><main><div id="root"></div><h1>Local workspace</h1></main><script type="module" src="/app.js"></script>');
  } else if (["/app.js", "/app.css"].includes(request.url)) {
    response.setHeader("Content-Type", request.url.endsWith("css") ? "text/css" : "text/javascript");
    response.end(await readFile(path.join(directory, request.url.slice(1))));
  } else { response.writeHead(404); response.end(); }
});
try {
  await build({ stdin: { contents: 'import React from "react";import {createRoot} from "react-dom/client";import {AccountConnection} from "./apps/web/src/local/AccountConnection";createRoot(document.getElementById("root")).render(<AccountConnection/>);', resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "esm", jsx: "automatic", outfile: path.join(directory, "app.js") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const account = page.getByRole("region", { name: "Parent account", exact: true });
  await expect(account).toContainText("Not paired to an account");
  await expect(account.getByRole("link")).toHaveCount(0);
  results.cases.push("unpaired-has-no-account-link");

  status = { paired: true, accountUrl: "https://portal.example.test/app/" };
  await account.getByRole("button", { name: "Refresh account status", exact: true }).click();
  await expect(account).toContainText("Paired to parent account");
  const link = account.getByRole("link", { name: "Open account", exact: true });
  await expect(link).toHaveAttribute("href", status.accountUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await page.screenshot({ path: path.join(output, "account-paired-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "account-paired-mobile.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  results.cases.push("paired-link-refresh-and-mobile-layout");

  status = { paired: false };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(account).toContainText("Not paired to an account");
  await expect(account.getByRole("link")).toHaveCount(0);
  results.cases.push("focus-refresh-removes-unpaired-link");

  status = { paired: true, accountUrl: "javascript:alert(1)" };
  await account.getByRole("button", { name: "Refresh account status", exact: true }).click();
  await expect(account).toContainText("Account status unavailable");
  await expect(account.getByRole("link")).toHaveCount(0);
  results.cases.push("invalid-account-url-is-never-linked");
  status = { paired: true, accountUrl: "https://portal.example.test/app/" };
  await account.getByRole("button", { name: "Refresh account status", exact: true }).click();
  await expect(link).toBeVisible();
  responseStatus = 503;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(account).toContainText("Account status unavailable");
  await expect(account.getByRole("link")).toHaveCount(0);
  results.cases.push("unavailable-status-clears-stale-pairing-link");
  assert.deepEqual(errors, []);
  results.passed = true;
} catch (error) {
  results.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Account UI QA: ${results.passed ? "PASS" : "FAIL"} (${results.cases.length} cases)`);
}
