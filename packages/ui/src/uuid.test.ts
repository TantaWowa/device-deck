import assert from "node:assert/strict";
import test from "node:test";
import { browserUUID } from "./uuid";

test("HTTP dashboard IDs use cryptographic bytes when randomUUID is unavailable", () => {
  let requests = 0;
  const crypto = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      requests++;
      assert.ok(array instanceof Uint8Array);
      assert.equal(array.length, 16);
      array.fill(255);
      return array;
    },
  };
  assert.equal(browserUUID(crypto), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(requests, 1);
  assert.match(browserUUID(), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});
