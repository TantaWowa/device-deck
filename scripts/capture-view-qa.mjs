// Shared local/portal browser checks against synthetic QA_CAPTURES media only.
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";

export async function captureViewCase({ page, openLibrary, output, label, otherCaptureIds = [] }) {
  const files = [], thumbnails = [];
  // Force a fresh network response even when earlier capture-toasts mounted the
  // library and populated the browser's thumbnail cache.
  const thumbnailPattern = "**/v1/artifacts/*/thumbnail*";
  const freshThumbnail = (route) => route.continue();
  await page.route(thumbnailPattern, freshThumbnail);
  const request = (request) => {
    if (/\/v1\/artifacts\/[^/]+\/(?:file|clean)(?:\?|$)/.test(request.url())) files.push(request.url());
  };
  const response = (response) => {
    if (/\/v1\/artifacts\/[^/]+\/thumbnail(?:\?|$)/.test(response.url()))
      thumbnails.push({ url: response.url(), status: response.status(), type: response.headers()["content-type"] });
  };
  page.on("request", request); page.on("response", response);
  const library = page.getByRole("region", { name: "Capture library", exact: true });
  const tileIds = () => library.locator(".capture-tile[data-capture-id]").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-capture-id")));
  try {
    await page.reload();
    await openLibrary();
    await expect(library.getByRole("button", { name: "Tiled view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(library.locator(".capture-tiles")).toBeVisible();
    const decoded = [];
    for (const [id, name] of [["seed-0", "Alpha screenshot"], ["seed-1", "Bravo recording"]]) {
      const card = library.locator(`.capture-tile[data-capture-id="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      const thumbnail = card.getByRole("img", { name: `Preview of ${name}`, exact: true });
      await expect.poll(() => thumbnail.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
      const dimensions = await thumbnail.evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
      assert.ok(dimensions.width <= 480 && dimensions.height <= 270);
      decoded.push({ id, ...dimensions });
    }
    assert.ok(thumbnails.some((item) => item.url.includes("/seed-0/thumbnail") && item.status === 200 && item.type.startsWith("image/jpeg")));
    assert.ok(thumbnails.some((item) => item.url.includes("/seed-1/thumbnail") && item.status === 200 && item.type.startsWith("image/jpeg")));
    await page.screenshot({ path: path.join(output, `${label}-capture-tiles-desktop.png`), fullPage: true });

    await library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true }).check();
    const formFactors = [["TV", ["seed-0", "seed-2"]], ["Phone & tablet", ["seed-1", "seed-3"]], ["Other", otherCaptureIds]];
    for (const [value, expected] of formFactors) {
      await library.getByRole("group", { name: "Filter capture device type", exact: true }).getByRole("button", { name: value, exact: true }).click();
      await expect.poll(async () => (await tileIds()).filter((id) => id.startsWith("seed-")).sort()).toEqual(expected);
      await library.getByRole("button", { name: "List view", exact: true }).click();
      await expect.poll(() => library.locator("tbody tr[data-capture-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-capture-id")).filter((id) => id.startsWith("seed-")).sort())).toEqual(expected);
      await expect(library.getByRole("group", { name: "Filter capture device type", exact: true }).getByRole("button", { name: value, exact: true })).toHaveAttribute("aria-pressed", "true");
      await library.getByRole("button", { name: "Tiled view", exact: true }).click();
    }
    await library.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true })).not.toBeChecked();
    const selectedFilters = [["platform", "Android"], ["device type", "Phone & tablet"], ["environment", "Real"], ["connection", "Online"], ["availability", "Available"], ["visibility", "Local"], ["type", "Recordings"]];
    for (const [group, value] of selectedFilters)
      await library.getByRole("group", { name: `Filter capture ${group}`, exact: true }).getByRole("button", { name: value, exact: true }).click();
    await library.getByRole("combobox", { name: "Capture device", exact: true }).selectOption("android");
    await expect.poll(tileIds).toEqual(["seed-1"]);
    await library.getByRole("button", { name: "List view", exact: true }).click();
    await expect(library.locator('tbody tr[data-capture-id="seed-1"]')).toHaveCount(1);
    for (const [group, value] of selectedFilters)
      await expect(library.getByRole("group", { name: `Filter capture ${group}`, exact: true }).getByRole("button", { name: value, exact: true })).toHaveAttribute("aria-pressed", "true");
    await library.getByRole("button", { name: "Tiled view", exact: true }).click();
    await expect.poll(tileIds).toEqual(["seed-1"]);
    for (const [group, absent, present] of [["environment", "Sim", "Real"], ["connection", "Offline", "Online"], ["availability", "Locked", "Available"], ["visibility", "Shared", "Local"]]) {
      await library.getByRole("group", { name: `Filter capture ${group}`, exact: true }).getByRole("button", { name: absent, exact: true }).click();
      await expect.poll(tileIds).toEqual([]);
      await library.getByRole("group", { name: `Filter capture ${group}`, exact: true }).getByRole("button", { name: present, exact: true }).click();
      await expect.poll(tileIds).toEqual(["seed-1"]);
    }
    await library.getByRole("button", { name: "Reset filters", exact: true }).click();

    await library.getByRole("searchbox", { name: "Search captures", exact: true }).fill("payments");
    await library.getByRole("combobox", { name: "Sort captures by", exact: true }).selectOption("name");
    const ascending = library.getByRole("button", { name: "Sort ascending", exact: true });
    if (await ascending.count()) await ascending.click();
    await library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true }).check();
    await expect.poll(tileIds).toEqual(["seed-0", "seed-2"]);
    await library.getByRole("button", { name: "List view", exact: true }).click();
    await expect(library.getByRole("searchbox", { name: "Search captures", exact: true })).toHaveValue("payments");
    await expect(library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true })).toBeChecked();
    await expect(library.getByRole("columnheader", { name: "Name", exact: true })).toHaveAttribute("aria-sort", "ascending");
    await expect.poll(() => library.locator("tbody tr[data-capture-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-capture-id")))).toEqual(["seed-0", "seed-2"]);
    await library.getByRole("button", { name: "Tiled view", exact: true }).click();
    await expect.poll(tileIds).toEqual(["seed-0", "seed-2"]);
    await expect(library.getByRole("checkbox", { name: "Select Alpha screenshot", exact: true })).toBeChecked();
    await library.getByRole("button", { name: "Clear selection", exact: true }).click();
    await library.getByRole("button", { name: "Clear capture search", exact: true }).click();

    await library.getByRole("button", { name: "List view", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("deck-captures-view"))).toBe("list");
    const missingThumbnail = "**/v1/artifacts/seed-2/thumbnail*";
    await page.route(missingThumbnail, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Synthetic missing thumbnail" }) }));
    const transientThumbnail = "**/v1/artifacts/seed-3/thumbnail*";
    let transientAttempts = 0;
    await page.route(transientThumbnail, (route) => ++transientAttempts === 1
      ? route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ message: "Synthetic thumbnail queue full" }) })
      : route.continue());
    await page.reload();
    await openLibrary();
    await expect(library.getByRole("button", { name: "List view", exact: true })).toHaveAttribute("aria-pressed", "true");
    const recovered = library.locator('tr[data-capture-id="seed-3"]');
    await recovered.scrollIntoViewIfNeeded();
    await expect.poll(() => recovered.getByRole("img", { name: "Preview of Delta screenshot", exact: true }).evaluate((image) => image.complete && image.naturalWidth > 0), { timeout: 10_000 }).toBe(true);
    assert.equal(transientAttempts, 2, "A transient queue failure must recover without switching views.");
    await page.unroute(transientThumbnail);
    await library.getByRole("button", { name: "Tiled view", exact: true }).click();
    const missing = library.locator('.capture-tile[data-capture-id="seed-2"]');
    await missing.scrollIntoViewIfNeeded();
    await expect(missing).toContainText("Preview unavailable");
    assert.equal(await missing.locator("img").count(), 0, "A missing thumbnail must not leave a broken image.");
    await expect(missing.getByRole("button", { name: "Preview Charlie screenshot", exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, `${label}-capture-tiles-mobile.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(geometry.document <= geometry.viewport + 1, "Tiled captures must not overflow the mobile page.");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.unroute(missingThumbnail);
    await library.getByRole("button", { name: "List view", exact: true }).click();
    await page.screenshot({ path: path.join(output, `${label}-capture-list-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, `${label}-capture-list-mobile.png`), fullPage: true });
    const listGeometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(listGeometry.document <= listGeometry.viewport + 1, "List captures must not overflow the mobile page.");
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual(files, [], "Browsing capture thumbnails must never download full screenshots or recordings.");
    return { name: `${label}-capture-tiles-and-list`, passed: true, decodedThumbnails: decoded, boundedJpegRequests: thumbnails.filter((item) => item.status === 200).length, matchingDeviceFilters: selectedFilters.map(([group]) => group), missingThumbnailFallback: true, transientThumbnailRecovered: transientAttempts === 2, viewPersisted: true, filterSortSelectionPreserved: true, mobile: geometry, mobileList: listGeometry, fullFileRequests: files.length };
  } finally { page.off("request", request); page.off("response", response); await page.unroute(thumbnailPattern, freshThumbnail); }
}
