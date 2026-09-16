import assert from "node:assert/strict";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Session } from "../packages/core/src/local/types";

type Input = { key?: string; text?: string };
export async function exerciseRemoteInput(
  page: Page,
  output: string,
  fixture: {
    inputs: () => Input[];
    attempts: () => Input[];
    sessions: () => number;
    session: (id: string) => Session;
    reserveOther: () => Promise<Session>;
    endOther: () => Promise<void>;
    holdNext: () => () => void;
    release: () => Promise<void>;
  },
) {
  const row = page
    .locator(".live-table tbody tr")
    .filter({
      has: page.getByRole("button", { name: "Fixture Roku", exact: true }),
    });
  const trigger = row.getByRole("button", {
    name: "Remote · Fixture Roku",
    exact: true,
  });
  const panel = page.getByRole("region", {
    name: "Remote for Fixture Roku",
    exact: true,
  });
  const toggle = panel.locator(".keyboard-toggle");
  const key = (name: string) => panel.locator(`[data-remote-key="${name}"]`);
  const baseline = fixture.inputs().length;
  const reservations = fixture.sessions();
  await trigger.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".remote-component")).toHaveAttribute(
    "data-keyboard-remote",
    "true",
  );
  await key("Up").hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Up");
  await page.screenshot({ path: path.join(output, "remote-key-tooltip.png") });
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await panel.locator(".floating-remote-bar strong").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(tooltip).not.toBeVisible();
  // A capture-phase observer records even brief, per-request disabling of unrelated keys.
  await panel.evaluate((element) => {
    element.setAttribute("data-qa-disabled-flash", "false");
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.attributeName === "disabled" &&
            record.target instanceof HTMLElement &&
            record.target.matches("[data-remote-key]"),
        )
      )
        element.setAttribute("data-qa-disabled-flash", "true");
    });
    observer.observe(element, {
      attributes: true,
      subtree: true,
      attributeFilter: ["disabled"],
    });
  });
  await page.keyboard.down("ArrowUp");
  await expect(key("Up")).toHaveAttribute("data-pressed", "true");
  await expect(
    panel.locator('[data-remote-key][data-pressed="true"]'),
  ).toHaveCount(1);
  await page.screenshot({
    path: path.join(output, "remote-key-highlight.png"),
  });
  await page.keyboard.up("ArrowUp");
  for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft"])
    await page.keyboard.press(k);
  await expect
    .poll(() =>
      fixture
        .inputs()
        .slice(baseline)
        .map((input) => input.key),
    )
    .toEqual(["Up", "Right", "Down", "Left"]);
  assert.equal(
    fixture.sessions(),
    reservations + 1,
    "Rapid first keys must share one reservation",
  );
  await expect(key("Up")).toHaveAttribute("data-pressed", "false");
  await expect(panel).toHaveAttribute("data-qa-disabled-flash", "false");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const beforeFocusedButtons = fixture.inputs().length;
  await key("Down").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      fixture
        .inputs()
        .slice(beforeFocusedButtons)
        .map((input) => input.key),
    )
    .toEqual(["OK", "Play"]);
  const text = panel.getByRole("textbox", {
    name: "Text for Fixture Roku",
    exact: true,
    includeHidden: true,
  });
  await text.fill("hello remote");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const beforeTyping = fixture.inputs().length;
  await page.keyboard.press("ArrowLeft");
  assert.equal(fixture.inputs().length, beforeTyping);
  await text.press("Enter");
  await expect
    .poll(() => fixture.inputs().slice(beforeTyping))
    .toEqual([{ text: "hello remote" }]);
  await expect(text).toHaveValue("");
  await panel.getByRole("button", { name: "Remote menu", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await panel.getByRole("button", { name: "Remote menu", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await page
    .getByRole("searchbox", { name: "Search devices", exact: true })
    .click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await panel.locator(".floating-remote-bar strong").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const beforePaused = fixture.inputs().length;
  await page.keyboard.press("ArrowRight");
  assert.equal(fixture.inputs().length, beforePaused);
  await panel.locator(".floating-remote-bar strong").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await panel.locator(".floating-remote-bar strong").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const releaseHeldInput = fixture.holdNext();
  const beforeClose = fixture.inputs().length;
  const attempts = fixture.attempts().length;
  try {
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => fixture.attempts().length).toBe(attempts + 1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await panel
      .getByRole("button", { name: "Close remote", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
  } finally {
    releaseHeldInput();
  }
  await expect
    .poll(() =>
      fixture
        .inputs()
        .slice(beforeClose)
        .map((input) => input.key),
    )
    .toEqual(["Up"]);
  await trigger.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(key("Left")).toBeDisabled();
  await expect(text).toBeDisabled();
  await expect(panel).toContainText("work or running regression tests");
  await expect(
    panel.getByRole("heading", { name: "Manage your reservation", exact: true }),
  ).toBeVisible();
  const ownedSessionId = await page.evaluate(() => {
    const leases = JSON.parse(localStorage.getItem("deck-local-leases") || "{}");
    return leases.roku.session.id as string;
  });
  const ownedReservation = fixture.session(ownedSessionId);
  await page.keyboard.press("ArrowLeft");
  assert.equal(fixture.inputs().length, beforeClose + 1);
  await page.screenshot({
    path: path.join(output, "remote-owned-reserved-choices.png"),
  });
  await panel
    .getByRole("button", { name: "Override — do not reserve", exact: true })
    .click();
  await expect(panel.locator(".control-override-status")).toContainText(
    "Override active",
  );
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() =>
      fixture
        .inputs()
        .slice(beforeClose)
        .map((input) => input.key),
    )
    .toEqual(["Up", "Left"]);
  assert.equal(fixture.sessions(), reservations + 1);
  assert.deepEqual(fixture.session(ownedSessionId), ownedReservation);
  await expect(panel).not.toHaveClass(/options-open/);
  await panel.getByRole("button", { name: "Stop override", exact: true }).click();
  await expect(key("Left")).toBeDisabled();
  await expect(text).toBeDisabled();
  assert.deepEqual(fixture.session(ownedSessionId), ownedReservation);
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await fixture.release();

  let otherReservation = await fixture.reserveOther();
  let sessionsBeforeOverride = fixture.sessions();
  const leasesBeforeOverride = await page.evaluate(() =>
    localStorage.getItem("deck-local-leases"),
  );
  await page.reload();
  await page
    .locator(".live-sidebar")
    .getByRole("button", { name: /^Devices/ })
    .click();
  await trigger.click();
  await expect(key("Up")).toBeDisabled();
  await expect(text).toBeDisabled();
  const override = panel.getByRole("button", {
    name: "Override — do not reserve",
    exact: true,
  });
  if (!(await override.isVisible()))
    await panel.getByRole("button", { name: "Remote menu", exact: true }).click();
  await expect(override).toBeVisible();
  const takeover = panel.getByRole("button", {
    name: "End current session & reserve…",
    exact: true,
  });
  const overrideBounds = await override.boundingBox();
  const takeoverHeading = panel.getByRole("heading", {
    name: "Or take the reservation",
    exact: true,
  });
  const takeoverBounds = await takeoverHeading.boundingBox();
  const reservedPanelBounds = await panel.boundingBox();
  assert(
    overrideBounds &&
      takeoverBounds &&
      overrideBounds.y + overrideBounds.height <= takeoverBounds.y,
    "The override choice must appear above the reservation takeover options",
  );
  assert(
    reservedPanelBounds &&
      takeoverBounds.y + takeoverBounds.height <=
        reservedPanelBounds.y + reservedPanelBounds.height,
    "The takeover heading must remain visible in the compact reserved remote",
  );
  await expect(takeover).toBeEnabled();
  await page.screenshot({
    path: path.join(output, "remote-reserved-choices.png"),
  });
  await override.click();
  const overrideStatus = panel.locator(".control-override-status");
  await expect(overrideStatus).toHaveAttribute("role", "status");
  await expect(overrideStatus).toContainText("Override active");
  await expect(overrideStatus).toContainText(
    `Reserved by ${otherReservation.owner}`,
  );
  await expect(key("Up")).toBeEnabled();
  await expect(text).toBeEnabled();
  const beforeOverrideInputs = fixture.inputs().length;
  await key("Up").click();
  await page.keyboard.press("ArrowRight");
  await text.fill("override without reserving");
  await text.press("Enter");
  await expect
    .poll(() => fixture.inputs().slice(beforeOverrideInputs))
    .toEqual([
      { key: "Up" },
      { key: "Right" },
      { text: "override without reserving" },
    ]);
  assert.equal(
    fixture.sessions(),
    sessionsBeforeOverride,
    "Override inputs must not create a reservation",
  );
  assert.deepEqual(
    fixture.session(otherReservation.id),
    otherReservation,
    "Override must preserve the original reservation, including owner and expiry",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("deck-local-leases")),
    leasesBeforeOverride,
    "Override must not claim a browser lease",
  );
  await page.screenshot({
    path: path.join(output, "remote-override-active.png"),
  });
  await panel.getByRole("button", { name: "Stop override", exact: true }).click();
  await expect(key("Up")).toBeDisabled();
  await expect(text).toBeDisabled();
  await expect(overrideStatus).toHaveCount(0);
  assert.deepEqual(fixture.session(otherReservation.id), otherReservation);
  await expect(override).toBeVisible();
  await override.click();
  await expect(key("Up")).toBeEnabled();
  await fixture.endOther();
  await expect(overrideStatus).toContainText("Override ended", { timeout: 10000 });
  await expect(overrideStatus).toContainText("Reservation changed");
  await expect(key("Up")).toBeDisabled();
  await expect(text).toBeDisabled();
  const beforeEndedInput = fixture.inputs().length;
  await page.keyboard.press("ArrowRight");
  assert.equal(fixture.inputs().length, beforeEndedInput);
  assert.equal(
    fixture.sessions(),
    sessionsBeforeOverride,
    "An ended override must never silently reserve the now-free device",
  );
  assert.equal(fixture.session(otherReservation.id).state, "closed");
  otherReservation = await fixture.reserveOther();
  sessionsBeforeOverride = fixture.sessions();
  await panel.getByRole("button", { name: "Review options", exact: true }).click();
  await expect(override).toBeVisible({ timeout: 10000 });
  await override.click();
  await expect(key("Up")).toBeEnabled();
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await trigger.click();
  await expect(key("Up")).toBeDisabled();
  await expect(overrideStatus).toHaveCount(0);
  if (!(await override.isVisible()))
    await panel.getByRole("button", { name: "Remote menu", exact: true }).click();
  await expect(override).toBeVisible();
  await panel.getByLabel("Owner", { exact: true }).fill("Fixture new owner");
  await panel
    .getByLabel("Reason", { exact: true })
    .fill("Take the reservation after temporary override");
  await takeover.click();
  const confirmation = panel.getByRole("alertdialog", {
    name: "Confirm session change",
    exact: true,
  });
  await expect(confirmation).toContainText(otherReservation.owner);
  assert.deepEqual(fixture.session(otherReservation.id), otherReservation);
  await confirmation
    .getByRole("button", { name: "End session & take control", exact: true })
    .click();
  await expect
    .poll(() => fixture.session(otherReservation.id).state)
    .toBe("closed");
  await expect.poll(() => fixture.sessions()).toBe(sessionsBeforeOverride + 1);
  const menu = panel.getByRole("button", { name: "Remote menu", exact: true });
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await expect(panel.locator(".control-session-title")).toContainText(
    "Your reservation · Fixture new owner",
  );
  const newLeaseId = await page.evaluate(() => {
    const leases = JSON.parse(localStorage.getItem("deck-local-leases") || "{}");
    return leases.roku?.session.id as string | undefined;
  });
  assert(newLeaseId && newLeaseId !== otherReservation.id);
  assert.equal(fixture.session(newLeaseId).state, "active");
  assert.equal(fixture.session(newLeaseId).owner, "Fixture new owner");
  await panel.getByRole("button", { name: "Remote menu", exact: true }).click();
  const beforeTakeoverInput = fixture.inputs().length;
  await key("Down").click();
  await expect
    .poll(() => fixture.inputs().slice(beforeTakeoverInput))
    .toEqual([{ key: "Down" }]);
  await panel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  await fixture.release();

  // Unsupported USB-only remotes must never arm keyboard capture.
  const captureTrigger = page.getByRole("button", {
    name: "Remote · Auto feed",
    exact: true,
  });
  await captureTrigger.click();
  const capturePanel = page.getByRole("region", {
    name: "Remote for Auto feed",
    exact: true,
  });
  await expect(capturePanel.locator(".keyboard-toggle")).toBeDisabled();
  await expect(capturePanel.locator(".keyboard-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await capturePanel
    .getByRole("button", { name: "Close remote", exact: true })
    .click();
  return [
    "Remote focus automatically controls keyboard lock; native text, Escape, outside focus and unsupported devices remain safe",
    "Tooltips and individual pressed-key highlights work without disabling the remote; rapid keys share one reservation and remain ordered; closing cancels pending inputs",
    "Reopening a remote with a saved own lease warns about interrupting work or tests and requires an explicit override choice; stopping override blocks input again",
    "Reserved remotes offer override above takeover; override sends keys and text without creating or changing a reservation, shows its owner, and resets when stopped or closed",
    "Ending the original reservation disables override input and requires another choice without silently reserving the free device",
    "Existing takeover still requires confirmation, closes the original reservation, and creates a working reservation for the new owner",
  ];
}
