import test from "node:test";
import assert from "node:assert/strict";
import { ControlStream } from "./control-stream";
import type { InteractiveSource, PointerInput } from "../../../packages/core/src/live";

function fixture(validate = async () => {}) {
  const events: PointerInput[] = [];
  const errors: Error[] = [];
  const source: InteractiveSource = {
    width: 100, height: 200, capabilities: ["tap", "drag", "multitouch"],
    onFrame: () => () => {}, onClose: () => () => {}, close: async () => {},
    pointer: async (event) => { events.push(event); }, gesture: async () => {},
  };
  return { events, errors, source, control: new ControlStream(source, validate, (error) => errors.push(error)) };
}
const pointer = (type: PointerInput["type"], x = 1, contactId = 1) => ({ type: "pointer", event: { type, x, y: 1, width: 100, height: 200, contactId } });

test("moves arrive before up; coalescing preserves contact and down/up order", async () => {
  const { events, control } = fixture();
  control.send(pointer("down"));
  await control.settled();
  for (let x = 2; x < 80; x++) control.send(pointer("move", x));
  await control.settled();
  assert.equal(events.at(-1)?.type, "move");
  assert.equal(events.at(-1)?.x, 79);
  assert.ok(events.length < 10);
  control.send(pointer("down", 20, 2));
  control.send(pointer("up", 79));
  control.send(pointer("up", 20, 2));
  await control.settled();
  assert.deepEqual(events.slice(-3).map((e) => [e.type, e.contactId]), [["down", 2], ["up", 1], ["up", 2]]);
  await control.close();
});

test("lease loss cancels held contacts and drops queued input", async () => {
  let valid = true;
  const { control, events, errors } = fixture(async () => { if (!valid) throw new Error("Lease ended"); });
  control.send(pointer("down")); await control.settled();
  valid = false;
  control.send(pointer("move", 20)); control.send(pointer("up", 20));
  await assert.rejects(control.settled(), /Lease ended/);
  assert.deepEqual(events.map((e) => e.type), ["down", "cancel"]);
  assert.equal(errors.length, 1);
  await control.close();
});

test("cancel while authorization is pending never dispatches the stale down", async () => {
  let proceed!: () => void;
  const { control, events } = fixture(() => new Promise<void>((resolve) => { proceed = resolve; }));
  control.send(pointer("down"));
  const cancelling = control.cancel();
  proceed(); await cancelling;
  assert.equal(events.filter((e) => e.type !== "cancel").length, 0);
  await control.close();
});

test("unsupported continuous gestures reject without injecting a contact", async () => {
  const { control, source, events } = fixture();
  source.capabilities = ["tap", "swipe"];
  control.send(pointer("down"));
  await assert.rejects(control.settled(), /completed gestures/);
  assert.equal(events.filter((e) => e.type === "down").length, 0);
});

test("malformed input and queue overflow never create unbounded movement", async () => {
  const { control } = fixture();
  assert.throws(() => control.send(pointer("down", 120)), /outside/);
  assert.throws(() => control.send({ type: "pointer", event: { ...pointer("down").event, contactId: -1 } }));
  for (let i = 0; i < 65; i++) control.send(pointer(i % 2 ? "up" : "down"));
  assert.throws(() => control.send(pointer("down")), /quickly/);
  await control.close();
});
