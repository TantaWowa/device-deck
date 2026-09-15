import assert from "node:assert/strict";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

type Input = { key?: string; text?: string };
export async function exerciseRemoteInput(
  page: Page,
  output: string,
  fixture: {
    inputs: () => Input[];
    attempts: () => Input[];
    sessions: () => number;
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
  await expect(panel).not.toHaveClass(/options-open/);
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
  ];
}
