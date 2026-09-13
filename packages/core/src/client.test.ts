import test from "node:test";
import assert from "node:assert/strict";
import { validateEndpoint } from "./client";

test("local endpoint rejects process-group PIDs and non-loopback URL overrides", () => {
  for (const pid of [-1, 0, 1, 2.5, "100", null, undefined, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateEndpoint({ port: 12345, token: "local-token", pid }), /Invalid local endpoint/);
  for (const value of [null, {}, "invalid", { port: 12345, pid: 100, token: "" }])
    assert.throws(() => validateEndpoint(value), /Invalid local endpoint/);
  const ep = validateEndpoint({ port: 12345, token: "local-token", pid: 100, url: "https://example.com" });
  assert.equal(ep.url, "http://127.0.0.1:12345");
  assert.equal(ep.pid, 100);
});
