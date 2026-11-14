// Live check for simulator input through the daemon's idb path, including stale
// companion recovery. Sends real input to whatever is on screen of an already
// booted simulator; it never boots, shuts down or reserves anything.
// npm run qa:simulator-input -- --udid UDID --os ios|tvos [--rounds 20] [--idb PATH] [--include-lock]
import { parseArgs } from "node:util";
import { simulatorInputArgs } from "../packages/adapters/src";
import { IdbInput, listUserProcesses } from "../packages/adapters/src/idb-input";
import { idbGestureArgs, idbScreen } from "../packages/adapters/src/interactive";
import { run } from "../packages/adapters/src/process";

const { values } = parseArgs({ options: {
  udid: { type: "string" }, os: { type: "string" }, rounds: { type: "string", default: "20" },
  idb: { type: "string", default: "idb" }, "include-lock": { type: "boolean", default: false },
} });
const { udid, idb } = values, os = values.os, rounds = Number(values.rounds);
if (!udid || (os !== "ios" && os !== "tvos") || !Number.isInteger(rounds) || rounds < 1) {
  console.error("Usage: npm run qa:simulator-input -- --udid UDID --os ios|tvos [--rounds 20] [--idb PATH] [--include-lock]");
  process.exit(2);
}
let recoveries = 0;
// Same helper the daemon uses; only the process listing is wrapped to count companion restarts.
const input = new IdbInput({ listProcesses: async () => { recoveries++; return listUserProcesses(); } });
const connection = { udid, os } as const;
const send = (args: string[], timeout?: number) => input.run(idb, args, { timeout });
const remote = (value: { key?: string; text?: string; x?: number; y?: number }) => () => send(simulatorInputArgs(connection, value));
const gesture = (type: "swipe" | "longPress") => async () => {
  // As in startIdbInteractive: describe, then map a frame-space gesture to points.
  const screen = idbScreen((await run(idb, ["describe", "--udid", udid, "--json"])).stdout.toString(), udid);
  const { width, height } = screen, x = Math.round(width / 2);
  const g = type === "swipe"
    ? { type, x, y: Math.round(height * 0.6), toX: x, toY: Math.round(height * 0.4), durationMs: 300, width, height }
    : { type, x, y: Math.round(height / 2), durationMs: 800, width, height };
  await send(idbGestureArgs(g, screen, udid), 15000);
};
const inputs: [string, () => Promise<unknown>][] = os === "ios"
  ? [["tap", remote({ x: 10, y: 10 })], ["swipe", gesture("swipe")], ["long-press", gesture("longPress")],
      ["text", remote({ text: "a" })], ["Home", remote({ key: "Home" })],
      ...(values["include-lock"] ? [["Lock", remote({ key: "Lock" })], ["SideButton", remote({ key: "SideButton" })]] as [string, () => Promise<unknown>][] : [])]
  : ["Up", "Down", "Left", "Right", "Select", "OK", "Back", "Home", "Play"].map((key) => [key, remote({ key })]);
const rows: { input: string; ok: number; failed: number; lastError?: string }[] = [];
for (const [name, action] of inputs) {
  const row = { input: name, ok: 0, failed: 0, lastError: undefined as string | undefined };
  for (let i = 0; i < rounds; i++) {
    try { await action(); row.ok++; }
    catch (error) { row.failed++; row.lastError = (error as Error).message.slice(0, 160); }
  }
  rows.push(row);
}
console.table(rows);
console.log(`Companion restarts: ${recoveries}${recoveries ? " (stale HID connection recovered)" : ""}`);
const health = input.health(udid);
if (!health.available) console.log(`Input unavailable: ${health.reason}`);
process.exit(rows.some((row) => row.failed) ? 1 : 0);
