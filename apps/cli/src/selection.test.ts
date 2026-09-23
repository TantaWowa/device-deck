import test from "node:test";
import assert from "node:assert/strict";
import { parseSelector } from "./selection";
test("CLI platform filters accept lowercase and validate all selector values", () => {
  assert.equal(parseSelector({ platform: "roku" }).platform, "Roku");
  assert.equal(parseSelector({ platform: "ANDROID" }).platform, "Android");
  const selector = parseSelector({ state: "FREE", capabilities: "KEY, record", kind: "virtual", "form-factor": "phone", tags: "ci, nightly" });
  assert.equal(selector.state, "free");
  assert.equal(selector.kind, "virtual");
  assert.equal(selector.formFactor, "phone");
  assert.deepEqual(selector.capabilities, ["key", "record"]);
  assert.deepEqual(selector.tags, ["ci", "nightly"]);
  for (const values of [
    { platform: "banana" },
    { state: "busy-ish" },
    { capabilities: "fly" },
    { kind: "imaginary" },
    { "form-factor": "tablet" },
  ])
    assert.throws(
      () => parseSelector(values),
      (e) => (e as any).code === "arguments",
    );
});
