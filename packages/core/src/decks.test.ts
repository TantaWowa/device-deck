import test from "node:test";
import assert from "node:assert/strict";
import { deckRoute, deckLeaseStorageKey } from "./decks";

test("remote routing and browser credentials are explicit and isolated by Deck", () => {
  assert.equal(deckRoute("/v1/health"), "/v1/health");
  assert.equal(deckRoute("/v1/health", "local"), "/v1/health");
  assert.equal(deckRoute("/v1/health", "ms"), "/v1/decks/ms/v1/health");
  assert.notEqual(deckLeaseStorageKey("ms"), deckLeaseStorageKey());
  assert.notEqual(deckLeaseStorageKey("ms"), deckLeaseStorageKey("ms2"));
  for (const invalid of ["../host", "ms/other", "ms?host=other", "ms#local"])
    assert.throws(() => deckRoute("/v1/health", invalid));
});
