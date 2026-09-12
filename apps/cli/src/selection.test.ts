import test from "node:test";
import assert from "node:assert/strict";
import { parseSelector } from "./selection";
test("CLI platform filters accept lowercase and validate all selector values", () => {
  assert.equal(parseSelector({ platform: "roku" }).platform, "Roku");
  assert.equal(parseSelector({ platform: "ANDROID" }).platform, "Android");
  assert.deepEqual(
    parseSelector({ state: "FREE", capabilities: "KEY, record" }).capabilities,
    ["key", "record"],
  );
  for (const values of [
    { platform: "banana" },
    { state: "busy-ish" },
    { capabilities: "fly" },
  ])
    assert.throws(
      () => parseSelector(values),
      (e) => (e as any).code === "arguments",
    );
});
