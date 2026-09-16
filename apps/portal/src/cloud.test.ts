import assert from "node:assert/strict";
import test from "node:test";
import { createCloudClient } from "./cloud";

test("Firebase ID tokens are sent only to fixed same-origin account API routes", async (t) => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ machines: [] }), { headers: { "Content-Type": "application/json" } });
  });
  let tokens = 0;
  const cloud = createCloudClient({ getIdToken: async () => { tokens++; return "firebase-test-identity"; } });
  assert.deepEqual(await cloud("/machines"), { machines: [] });
  assert.equal(requests[0].url, "/api/v1/machines");
  assert.equal(new Headers(requests[0].init?.headers).get("Authorization"), "Bearer firebase-test-identity");
  assert.equal(requests[0].init?.redirect, "error");
  assert.equal(requests[0].init?.credentials, "omit");
  assert.equal(requests[0].init?.cache, "no-store");
  for (const invalid of ["https://machine.example/v1/health", "//machine.example", "/machines/../../secret", "/machines?redirect=elsewhere", "/v1/operations/remote.input"]) {
    await assert.rejects(cloud(invalid), /Invalid account API path/);
  }
  assert.equal(tokens, 1, "invalid routes must fail before acquiring a Firebase token");
  assert.equal(requests.length, 1);
});

test("logout cancellation prevents an account request after delayed token acquisition", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("{}"); });
  let finish: (value: string) => void = () => {};
  const token = new Promise<string>((resolve) => { finish = resolve; });
  const cloud = createCloudClient({ getIdToken: () => token });
  const controller = new AbortController();
  const result = cloud("/machines", { signal: controller.signal });
  controller.abort(); finish("expired-session-token");
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls, 0);
});
