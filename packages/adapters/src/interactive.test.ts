import test from "node:test";
import assert from "node:assert/strict";
import { idbGestureArgs, idbScreen, startIdbInteractive } from "./interactive";
import { deviceSchema } from "../../core/src/local/types";
import type { run } from "./process";
const udid = "fce8cbf7-e7e4-44b3-8417-d2653d2bf1ad";
const device = deviceSchema.parse({ id: "ios", name: "iPhone", platform: "Apple", kind: "virtual", connection: { type: "simulator", udid, os: "ios" } });
const description = JSON.stringify({ udid, state: "Booted", screen_dimensions: { width: 1170, height: 2532, width_points: 390, height_points: 844 } });
const tap = { type: "tap" as const, x: 585, y: 1266, width: 1170, height: 2532 };

test("idb maps video pixels to points for scaled portrait and rotated landscape frames", () => {
  const screen = idbScreen(description, udid);
  assert.deepEqual(idbGestureArgs(tap, screen, udid), ["ui", "tap", "195", "422", "--udid", udid]);
  assert.deepEqual(idbGestureArgs({ ...tap, x: 422, y: 195, width: 844, height: 390 }, screen, udid), ["ui", "tap", "422", "195", "--udid", udid]);
  assert.deepEqual(idbGestureArgs({ ...tap, type: "swipe", toX: 0, toY: 0, durationMs: 350 }, screen, udid), ["ui", "swipe", "195", "422", "0", "0", "--duration", "0.35", "--udid", udid]);
  assert.deepEqual(idbGestureArgs({ ...tap, type: "longPress", durationMs: 800 }, screen, udid), ["ui", "tap", "195", "422", "--duration", "0.8", "--udid", udid]);
  assert.throws(() => idbGestureArgs({ ...tap, height: 1400 }, screen, udid), /dimensions changed/);
});
test("idb refuses unknown identity, unavailable pixel-to-point geometry and missing helpers", async () => {
  assert.throws(() => idbScreen(description, "another-udid"), /different simulator UDID/);
  assert.throws(() => idbScreen(JSON.stringify({ udid, state: "Booted", screen_dimensions: { width: 1170, height: 2532 } }), udid), /pixels and points/);
  assert.throws(() => idbScreen(description.replace("Booted", "Shutdown"), udid), /Boot the iOS/);
  await assert.rejects(startIdbInteractive(device, "idb", true, undefined, async () => false), /idb and idb_companion/);
});
test("idb advertises only bounded gestures, isolates the UDID and rejects continuous or view-only input", async () => {
  const calls: string[][] = [];
  const execute: typeof run = async (_command, args) => { calls.push(args); return { stdout: Buffer.from(description), stderr: "" }; };
  const source = await startIdbInteractive(device, "idb", true, execute, async () => true);
  assert.deepEqual(source.capabilities, ["tap", "swipe", "longPress"]);
  await source.gesture(tap);
  assert(calls.every((args) => args[args.indexOf("--udid") + 1] === udid));
  await assert.rejects(source.pointer({ ...tap, type: "down", contactId: 1 }), /continuous pointer input/);
  await source.close();
  await assert.rejects(source.gesture(tap), /closed/);
  const viewer = await startIdbInteractive(device, "idb", false, execute, async () => true);
  assert.deepEqual(viewer.capabilities, []);
  await assert.rejects(viewer.gesture(tap), /view-only/);
  await viewer.close();
});
