import test from "node:test";
import assert from "node:assert/strict";
import { selectFeeds, feedQuery } from "./feeds";
import type { Source } from "../../../packages/core/src/local/types";
const cards: Source[] = [
  {
    id: "one",
    name: "UGREEN",
    kind: "usb",
    uniqueId: "hw-one",
    status: "connected",
  },
  {
    id: "two",
    name: "UGREEN",
    kind: "usb",
    uniqueId: "hw-two",
    status: "connected",
  },
  {
    id: "three",
    name: "USB Video",
    kind: "usb",
    uniqueId: "hw-three",
    status: "missing",
  },
  {
    id: "native",
    name: "Simulator",
    kind: "native",
    deviceId: "sim",
    status: "connected",
  },
];
test("feed selection defaults to connected USB inputs and preserves explicit order", () => {
  assert.deepEqual(
    selectFeeds(cards).map((s) => s.id),
    ["one", "two"],
  );
  assert.deepEqual(
    selectFeeds(cards, "hw-two,ONE,two,USB Video").map((s) => s.id),
    ["two", "one", "three"],
  );
  assert.throws(() => selectFeeds(cards, "UGREEN"), /ambiguous/);
  assert.throws(() => selectFeeds(cards, "native"), /No USB feed/);
  assert.throws(() => selectFeeds(cards, "missing"), /No USB feed/);
  assert.throws(() => selectFeeds(cards, "one,"), /each selection/);
  assert.throws(() => selectFeeds([]), /No connected USB feeds/);
});
test("feed links carry layout and exact stable source selection", () => {
  const query = new URLSearchParams(
    feedQuery(["USB & one", "two"], true).toString(),
  );
  assert.equal(query.get("view"), "feeds");
  assert.equal(query.get("sources"), "USB & one,two");
  assert.equal(query.get("layout"), "grid");
  assert.equal(feedQuery(["one"], false).get("layout"), "single");
});
