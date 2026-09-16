// Real browser interaction with inert wake adapters; never sends device traffic.
import assert from "node:assert/strict";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Session } from "../packages/core/src/local/types";

type Lease = { session: Session; leaseToken: string };

export async function exerciseWake(
  page: Page,
  output: string,
  fixture: {
    attempts: () => string[];
    remoteInputs: () => number;
    sessions: () => number;
    session: (id: string) => Session;
    reserve: (owner: string) => Promise<Lease>;
    release: (lease: Lease) => Promise<void>;
    setOnline: (online: boolean) => Promise<void>;
  },
) {
  const listWake = page.getByRole("button", {
    name: "Wake · Fixture Roku",
    exact: true,
  });
  const remote = page.getByRole("button", {
    name: "Remote · Fixture Roku",
    exact: true,
  });
  const panel = page.getByRole("region", {
    name: "Remote for Fixture Roku",
    exact: true,
  });
  const wake = panel.getByRole("button", {
    name: "Wake device",
    exact: true,
    includeHidden: true,
  });
  const close = () =>
    panel.getByRole("button", { name: "Close remote", exact: true }).click();
  const reloadDevices = async () => {
    await page.reload();
    await page
      .locator(".live-sidebar")
      .getByRole("button", { name: /^Devices/ })
      .click();
  };
  const leasesBefore = await page.evaluate(() =>
    localStorage.getItem("deck-local-leases"),
  );
  const expectWake = async (count: number) => {
    await expect.poll(() => fixture.attempts().length).toBe(count);
    assert.equal(fixture.attempts().at(-1), "roku");
  };
  let activeLease: Lease | undefined;
  try {
    let attempts = fixture.attempts().length;
    const sessionsBefore = fixture.sessions();
    await expect(listWake).toBeEnabled();
    await listWake.click();
    await expectWake(++attempts);
    assert.equal(fixture.sessions(), sessionsBefore);
    await expect(panel).toHaveCount(0);

    await remote.click();
    await expect(wake).toBeEnabled();
    await wake.click();
    await expectWake(++attempts);
    assert.equal(
      fixture.sessions(),
      sessionsBefore,
      "Waking a free device must not reserve it from either entry point",
    );
    const remoteInputsBefore = fixture.remoteInputs();
    for (const keyboardKey of ["Enter", "Space"]) {
      await wake.focus();
      await expect(panel.locator(".keyboard-toggle")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await page.keyboard.press(keyboardKey);
      await expectWake(++attempts);
      assert.equal(
        fixture.remoteInputs(),
        remoteInputsBefore,
        `Focused Wake ${keyboardKey} must activate Wake without sending remote keys`,
      );
      assert.equal(fixture.sessions(), sessionsBefore);
    }
    await page.screenshot({ path: path.join(output, "remote-wake.png") });
    await close();

    await expect(
      page.getByRole("button", { name: "Wake · Auto feed", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Remote · Auto feed", exact: true })
      .click();
    const unsupported = page.getByRole("region", {
      name: "Remote for Auto feed",
      exact: true,
    });
    await expect(
      unsupported.getByRole("button", { name: "Wake device", exact: true }),
    ).toBeDisabled();
    await unsupported
      .getByRole("button", { name: "Close remote", exact: true })
      .click();
    assert.equal(fixture.attempts().length, attempts);

    for (const savedOwnLease of [false, true]) {
      activeLease = await fixture.reserve(
        savedOwnLease ? "Fixture saved owner" : "Fixture wake teammate",
      );
      const reservation = structuredClone(activeLease.session);
      if (savedOwnLease)
        await page.evaluate((lease) => {
          const leases = JSON.parse(
            localStorage.getItem("deck-local-leases") || "{}",
          );
          localStorage.setItem(
            "deck-local-leases",
            JSON.stringify({ ...leases, roku: lease }),
          );
        }, activeLease);
      await reloadDevices();
      const leasesAtChoice = await page.evaluate(() =>
        localStorage.getItem("deck-local-leases"),
      );
      const reservedCount = fixture.sessions();
      await listWake.click();
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("work or running regression tests");
      await expect(
        panel.getByRole("heading", {
          name: savedOwnLease ? "Manage your reservation" : "Or take the reservation",
          exact: true,
        }),
      ).toBeVisible();
      await expect(wake).toBeDisabled();
      assert.equal(
        fixture.attempts().length,
        attempts,
        "A reserved list Wake must show a choice before sending anything, including with saved credentials",
      );
      await page.screenshot({
        path: path.join(
          output,
          savedOwnLease ? "wake-owned-reserved-choices.png" : "wake-reserved-choices.png",
        ),
      });
      await panel
        .getByRole("button", { name: "Override — do not reserve", exact: true })
        .click();
      await expect(wake).toBeEnabled();
      assert.equal(
        fixture.attempts().length,
        attempts,
        "Choosing override must not automatically send the pending Wake",
      );
      await wake.click();
      await expectWake(++attempts);
      assert.equal(fixture.sessions(), reservedCount);
      assert.deepEqual(fixture.session(reservation.id), reservation);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("deck-local-leases")),
        leasesAtChoice,
        "Wake override must preserve browser lease credentials",
      );
      await panel
        .getByRole("button", { name: "Stop override", exact: true })
        .click();
      await expect(wake).toBeDisabled();
      await close();
      await remote.click();
      await expect(wake).toBeDisabled();
      assert.equal(
        fixture.attempts().length,
        attempts,
        "Opening the remote directly must require fresh consent before a reserved device can wake",
      );
      await close();
      await fixture.release(activeLease);
      activeLease = undefined;
    }

    await page.evaluate((leases) => {
      if (leases === null) localStorage.removeItem("deck-local-leases");
      else localStorage.setItem("deck-local-leases", leases);
    }, leasesBefore);
    await fixture.setOnline(false);
    await reloadDevices();
    const offlineSessions = fixture.sessions();
    await expect(listWake).toBeEnabled();
    await listWake.click();
    await expectWake(++attempts);
    await remote.click();
    await expect(panel.locator('[data-remote-key="Up"]')).toBeDisabled();
    await expect(wake).toBeEnabled();
    await wake.click();
    await expectWake(++attempts);
    assert.equal(
      fixture.sessions(),
      offlineSessions,
      "Wake attempts on configured offline network devices must not create reservations",
    );
    await close();
  } finally {
    if (activeLease) await fixture.release(activeLease);
    await fixture.setOnline(true);
    await page.evaluate((leases) => {
      if (leases === null) localStorage.removeItem("deck-local-leases");
      else localStorage.setItem("deck-local-leases", leases);
    }, leasesBefore);
    await reloadDevices();
  }
  return [
    "Wake is available on the device list and remote; free devices wake without creating reservations",
    "Focused Wake supports native Enter and Space activation without sending remote keys or creating reservations",
    "Reserved list Wake shows a warning before sending anything, including saved own leases; explicit override then Wake preserves the reservation and credentials",
    "Unsupported Wake controls are disabled; configured offline network devices can still receive a wake attempt from the list and remote",
  ];
}
