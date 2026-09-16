import assert from "node:assert/strict";
import test from "node:test";
import { clampPopup, positionPopup } from "./popup-position";

test("action popups open centered directly above their trigger when space permits", () => {
  assert.deepEqual(
    positionPopup(
      { left: 500, right: 540, top: 500, bottom: 536 },
      { width: 300, height: 302 },
      { width: 1200, height: 800 },
    ),
    { x: 370, y: 190, placement: "above" },
  );
});

test("action popups flip below near the top and clamp to either horizontal edge", () => {
  const size = { width: 300, height: 302 };
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(
    positionPopup({ left: 20, right: 52, top: 40, bottom: 72 }, size, viewport),
    { x: 8, y: 80, placement: "below" },
  );
  assert.deepEqual(
    positionPopup(
      { left: 1160, right: 1192, top: 680, bottom: 712 },
      size,
      viewport,
    ),
    { x: 892, y: 370, placement: "above" },
  );
});

test("popups remain in the viewport when neither side fits or the trigger scrolls away", () => {
  const size = { width: 300, height: 480 };
  const viewport = { width: 390, height: 600 };
  assert.deepEqual(
    positionPopup(
      { left: 330, right: 362, top: 280, bottom: 312 },
      size,
      viewport,
    ),
    { x: 82, y: 112, placement: "below" },
  );
  assert.deepEqual(
    positionPopup(
      { left: 50, right: 82, top: -100, bottom: -68 },
      size,
      viewport,
    ),
    { x: 8, y: 8, placement: "below" },
  );
  assert.deepEqual(clampPopup({ x: 900, y: 800 }, size, viewport), {
    x: 82,
    y: 112,
  });
});
