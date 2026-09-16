import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, tailscaleSchema } from "../../core/src/local/types";
import { validateConfig } from "./index";

const owner = "owner@example.com";
const origin = "https://deck.example-tailnet.ts.net";

test("existing Device Deck configurations leave Tailscale disabled", () => {
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: "./captures" },
  });
  assert.equal(config.tailscale, undefined);
  assert.equal(config.port, 47831);
});

test("Tailscale configuration preserves an exact HTTPS origin and explicit users", () => {
  for (const publicOrigin of [origin, `${origin}:8443`]) {
    const tailscale = { origin: publicOrigin, allowedUsers: [owner, "other@example.com"] };
    assert.deepEqual(tailscaleSchema.parse(tailscale), tailscale);
    const config = configSchema.parse({
      schemaVersion: 1,
      settings: { folder: "./captures" },
      tailscale,
    });
    assert.deepEqual(config.tailscale, tailscale);
  }
});

test("Tailscale configuration rejects noncanonical or untrusted public origins", () => {
  for (const invalid of [
    "http://deck.example-tailnet.ts.net",
    "https://localhost",
    "https://127.0.0.1:47831",
    "https://100.64.0.1",
    "https://example.com",
    "https://ts.net",
    "https://deck.example-tailnet.ts.net.evil.example",
    "https://owner:password@deck.example-tailnet.ts.net",
    `${origin}/`,
    `${origin}/app`,
    `${origin}?mode=remote`,
    `${origin}#ticket=value`,
    ` ${origin}`,
    "https://DECK.example-tailnet.ts.net",
    `${origin}:443`,
    `${origin}:65536`,
    "not-a-url",
  ]) {
    assert.equal(tailscaleSchema.safeParse({ origin: invalid, allowedUsers: [owner] }).success, false, invalid);
  }
});

test("Tailscale configuration requires a nonempty explicit user allowlist", () => {
  for (const allowedUsers of [undefined, [], [""], [" "], ["*"], ["owner@example.com\n"]]) {
    assert.equal(tailscaleSchema.safeParse({ origin, allowedUsers }).success, false, JSON.stringify(allowedUsers));
  }
  assert.equal(tailscaleSchema.safeParse({ origin, allowedUsers: [owner], allowAll: true }).success, false);
});
