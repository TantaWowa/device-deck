import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./process";

test("commands with empty stderr still report a useful failure or timeout", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"]), /Command failed/);
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 100), /Timed out/);
});
