import test from "node:test";
import assert from "node:assert/strict";
import { completedGesture, framePoint, PointerQueue } from "../../web/src/local/live-input";
import { gestureInputSchema, type PointerInput } from "../../../packages/core/src/live";

test("contain coordinates reject horizontal and vertical letterboxes and account for viewport offset", () => {
  const rect = { left: 100, top: 50, width: 400, height: 400 };
  assert.equal(framePoint(rect, 1920, 1080, 300, 100), null);
  assert.deepEqual(framePoint(rect, 1920, 1080, 300, 250), { x: 960, y: 540, width: 1920, height: 1080 });
  assert.equal(framePoint(rect, 1080, 1920, 110, 250), null);
  assert.deepEqual(framePoint(rect, 1080, 1920, 300, 250), { x: 540, y: 960, width: 1080, height: 1920 });
  assert.equal(framePoint(rect, 0, 1920, 300, 250), null);
  assert.equal(framePoint(rect, 1080, 1920, Infinity, 250), null);
});

test("touch boundaries preserve order while each contact keeps only its latest movement", () => {
  const sent: PointerInput[] = [];
  const queue = new PointerQueue((event) => { sent.push(event); return true; });
  const event = (type: PointerInput['type'], contactId: number, x = 1): PointerInput => ({ type, contactId, x, y: 1, width: 100, height: 200 });
  queue.push(event("move", 1));
  queue.push(event("down", 1));
  for (let i = 0; i < 1000; i++) queue.push(event("move", 1, i));
  assert.equal(queue.size, 1);
  queue.push(event("down", 2));
  queue.push(event("move", 2, 20));
  queue.push(event("move", 1, 30));
  queue.push(event("up", 1, 40));
  queue.push(event("cancel", 2));
  assert.deepEqual(sent.map(({ type, contactId, x }) => [type, contactId, x]), [
    ["down", 1, 1], ["move", 1, 999], ["down", 2, 1], ["move", 2, 20], ["move", 1, 30], ["up", 1, 40], ["cancel", 2, 1],
  ]);
  queue.push(event("move", 1));
  assert.equal(queue.size, 0);
});

test("cancellation clears unsent moves and transport failure never replays input", () => {
  const sent: string[] = [];
  let ready = true;
  const queue = new PointerQueue((event) => { if (!ready) return false; sent.push(event.type); return true; });
  const point = { contactId: 1, x: 1, y: 1, width: 100, height: 200 };
  queue.push({ type: "down", ...point });
  queue.push({ type: "move", ...point });
  queue.reset();
  queue.flush();
  assert.deepEqual(sent, ["down"]);
  queue.push({ type: "down", ...point });
  queue.push({ type: "move", ...point });
  ready = false;
  assert.equal(queue.flush(), false);
  ready = true;
  queue.push({ type: "up", ...point });
  assert.deepEqual(sent, ["down", "down"]);
});

test("discrete iOS gestures distinguish taps, long presses and bounded swipes", () => {
  const start = { x: 10, y: 20, width: 1080, height: 1920 };
  assert.deepEqual(gestureInputSchema.parse(completedGesture(start, start, 100)), { type: "tap", ...start });
  assert.equal(gestureInputSchema.parse(completedGesture(start, { ...start, y: 900 }, 1)).type, "swipe");
  assert.equal(completedGesture(start, start, 800).type, "longPress");
  assert.deepEqual(completedGesture(start, { ...start, y: 900 }, 8000), { type: "swipe", ...start, toX: 10, toY: 900, durationMs: 5000 });
});
