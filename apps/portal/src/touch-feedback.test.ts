import test from "node:test";
import assert from "node:assert/strict";
import { framePoint } from "../../web/src/local/live-input";
import { TouchFeedback, touchFeedbackPoint } from "../../web/src/local/touch-feedback";

test("touch feedback matches contained portrait and landscape coordinates at every preview size", () => {
  for (const [width, height] of [[720, 1280], [1920, 1080]]) {
    for (const [boxWidth, boxHeight] of [[400, 400], [354, 200], [900, 506]]) {
      const rect = { left: 80, top: 60, width: boxWidth, height: boxHeight };
      for (const [x, y] of [[0, 0], [width / 2, height / 2], [width - 1, height - 1]]) {
        const point = { x, y, width, height };
        const rendered = touchFeedbackPoint(boxWidth, boxHeight, point)!;
        const input = framePoint(rect, width, height, rendered.x + rect.left, rendered.y + rect.top)!;
        assert.ok(input);
        assert.ok(Math.abs(input.x - x) < 0.000001);
        assert.ok(Math.abs(input.y - y) < 0.000001);
      }
    }
  }
  assert.equal(touchFeedbackPoint(0, 100, { x: 0, y: 0, width: 720, height: 1280 }), null);
  assert.equal(touchFeedbackPoint(100, 100, { x: NaN, y: 0, width: 720, height: 1280 }), null);
});

test("long swipes retain their origin and endpoint without unbounded rendering work", () => {
  const feedback = new TouchFeedback();
  const point = { x: 10, y: 20, width: 720, height: 1280 };
  feedback.start(1, point);
  for (let x = 11; x < 700; x++) feedback.move(1, { ...point, x });
  const [trace] = feedback.snapshot();
  assert.ok(trace.points.length <= 64);
  assert.deepEqual(trace.points[0], point);
  assert.equal(trace.points.at(-1)?.x, 699);
  assert.equal(trace.phase, "active");
  assert.equal(feedback.prune(99999), false);
});

test("individual contact releases fade independently and never revive after cancellation or frame rotation", () => {
  const feedback = new TouchFeedback();
  const point = { x: 10, y: 20, width: 720, height: 1280 };
  feedback.start(1, point);
  feedback.start(2, { ...point, x: 400 });
  feedback.finish(1, "released", 100);
  feedback.move(1, { ...point, x: 600 });
  assert.equal(feedback.snapshot()[0].points.length, 1);
  assert.equal(feedback.prune(649), false);
  assert.equal(feedback.prune(650), true);
  assert.deepEqual(feedback.snapshot().map(({ contactId }) => contactId), [2]);
  feedback.cancelActive(700);
  assert.equal(feedback.snapshot()[0].phase, "cancelled");
  assert.equal(feedback.prune(1350), true);
  feedback.start(1, point);
  feedback.move(1, { ...point, width: 1280, height: 720 });
  assert.deepEqual(feedback.snapshot(), []);
  feedback.start(1, point);
  feedback.finish(1, "rejected", 2000);
  assert.equal(feedback.snapshot()[0].phase, "rejected");
  feedback.clear();
  feedback.move(1, point);
  assert.deepEqual(feedback.snapshot(), []);
});
