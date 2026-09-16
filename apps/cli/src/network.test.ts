import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, networkSchema, type Config } from "../../../packages/core/src/local/types";
import { networkCommand, pairCommand } from "./network";

function fixture() {
  let config: Config = configSchema.parse({ schemaVersion: 1, settings: { folder: "./captures" } });
  const saved: Config[] = [];
  const deps = {
    callOperation: async (operation: string, input?: unknown) => {
      if (operation === "config.get") return { config: structuredClone(config), revision: "revision" };
      assert.equal(operation, "config.save");
      const value = input as { config: Config; revision: string };
      assert.equal(value.revision, "revision");
      config = configSchema.parse(value.config);
      saved.push(config);
      return { config, revision: "next" };
    },
    endpoint: async () => ({ url: "http://127.0.0.1:12345", port: 12345, pid: 42, token: "private-local-token" }),
    request: fetch,
  };
  return { deps, saved };
}

test("network CLI enables ordinary access without Tailscale and preserves settings on edits", async () => {
  const { deps, saved } = fixture();
  const result = await networkCommand("enable", { port: "47832", allowHost: "my-machine.example,192.0.2.10", portal: "https://portal.example.com/" }, deps);
  assert.equal(result.restartRequired, true);
  assert.equal(saved[0].network?.host, "0.0.0.0");
  assert.equal(saved[0].port, 47832);
  assert.equal(saved[0].network?.hubOrigin, "https://portal.example.com");
  assert.deepEqual(saved[0].network?.allowedHosts, ["my-machine.example", "192.0.2.10"]);
  assert.equal(saved[0].tailscale, undefined);
  await networkCommand("enable", { host: "192.0.2.10" }, deps);
  assert.equal(saved[1].port, 47832);
  assert.equal(saved[1].network?.hubOrigin, "https://portal.example.com");
  await networkCommand("disable", {}, deps);
  assert.equal(saved[2].network, undefined);
  assert.equal(saved[2].port, 47832);
});

test("network settings reject wildcard trust, insecure portal endpoints and invalid ports", async () => {
  const { deps, saved } = fixture();
  for (const port of ["0", "-1", "65536", "1.5", "abc", ""]) await assert.rejects(networkCommand("enable", { port }, deps));
  await assert.rejects(networkCommand("enable", { cert: "cert.pem" }, deps), /both --cert and --key/);
  await assert.rejects(networkCommand("enable", { portal: "http://public.example" }, deps), /requires HTTPS/);
  await assert.rejects(networkCommand("status", { host: "0.0.0.0" }, deps), /only to network enable/);
  for (const allowedHosts of [["*"], ["*.example.com"], ["example.com/path"], ["user@example.com"], ["https://example.com"]])
    assert.equal(networkSchema.safeParse({ host: "0.0.0.0", allowedHosts }).success, false);
  for (const allowedOrigins of [["*"], ["null"], ["http://example.com/path"], ["http://example.com/"]])
    assert.equal(networkSchema.safeParse({ host: "0.0.0.0", allowedOrigins }).success, false);
  assert.equal(networkSchema.safeParse({ host: "::", allowedHosts: ["[::1]:12345"], hubOrigin: "http://127.0.0.1:5175" }).success, true);
  assert.deepEqual(saved, []);
});

test("pairing CLI sends only local credentials to the loopback daemon and handles failures", async () => {
  const { deps } = fixture();
  const requests: { url: string; init?: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ machineId: "fixture", code: "ABCDEF1234", expiresAt: 123456789 }), { status: 200 });
  };
  const pairing = await pairCommand(false, { ...deps, request });
  assert.equal(pairing.code, "ABCDEF1234");
  assert.equal(requests[0].url, "http://127.0.0.1:12345/v1/hub/pairing-code");
  assert.equal(requests[0].init?.redirect, "error");
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, "Bearer private-local-token");
  assert.equal(requests[0].init?.body, "{}");
  await pairCommand(true, { ...deps, request });
  assert.equal(requests[1].url, "http://127.0.0.1:12345/v1/hub/unpair");
  await assert.rejects(pairCommand(false, { ...deps, request: async () => new Response(JSON.stringify({ error: "portal-not-configured", message: "Set the portal first" }), { status: 409 }) }), /Set the portal first/);
});
