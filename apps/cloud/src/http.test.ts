import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { DecodedIdToken } from "firebase-admin/auth";
import { FirebaseAuthenticator } from "./auth";
import { CloudError } from "./errors";
import { cloudServer } from "./http";
import { fixture, portalOrigin } from "./test-fixtures";

test("Firebase authentication checks revoked tokens and disabled accounts", async () => {
  const calls: unknown[][] = [];
  const identity: DecodedIdToken = {
    uid: "alice", sub: "alice", aud: "project", iss: "https://securetoken.google.com/project",
    auth_time: 1, iat: 1, exp: 2, firebase: { identities: {}, sign_in_provider: "google.com" },
  };
  const auth = new FirebaseAuthenticator({
    verifyIdToken: async (token, checkRevoked) => {
      calls.push([token, checkRevoked]);
      if (token !== "valid") throw new Error("auth/user-disabled");
      return identity;
    },
  });
  assert.deepEqual(await auth.authenticate("valid"), { uid: "alice" });
  await assert.rejects(() => auth.authenticate("revoked"), (error: unknown) => error instanceof CloudError && error.status === 401);
  assert.deepEqual(calls, [["valid", true], ["revoked", true]]);
});

test("HTTP API requires an authenticated owner, supports machine CRUD, and permits only the portal origin", async () => {
  const f = await fixture();
  const server = cloudServer({
    service: f.service, portalOrigin,
    auth: { authenticate: async (token) => {
      if (!["alice", "bob"].includes(token)) throw new CloudError(401, "Sign in again.");
      return { uid: token };
    } },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (pathname: string, options: RequestInit = {}, token = "alice") => fetch(`${base}${pathname}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const publicKeyResponse = await fetch(`${base}/api/v1/public-key`);
    assert.deepEqual(await publicKeyResponse.json(), f.service.publicKey());
    assert.equal((await fetch(`${base}/api/v1/machines`)).status, 401);
    assert.equal((await send("/api/v1/machines", {}, "revoked")).status, 401);
    assert.equal((await send("/api/v1/machines", { headers: { Origin: "https://attacker.test" } })).status, 403);
    const preflight = await fetch(`${base}/api/v1/machines`, { method: "OPTIONS", headers: { Origin: portalOrigin, "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), portalOrigin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    assert.equal((await send("/api/v1/pairings", { method: "GET" })).status, 405);
    const begin = await send("/api/v1/pairings", { method: "POST", body: JSON.stringify({ machineId: f.machineId, publicKey: f.machineKeys.publicKey }) });
    assert.equal(begin.status, 201);
    const pending = await begin.json() as { pairingId: string };
    const complete = await send("/api/v1/machines", { method: "POST", body: JSON.stringify({ name: "Studio", endpoint: "https://private-machine.test:47831", receipt: await f.receipt(pending.pairingId) }) });
    assert.equal(complete.status, 201);
    assert.equal((await send(`/api/v1/machines/${f.machineId}`, {}, "bob")).status, 404);
    const list = await send("/api/v1/machines", { headers: { Origin: portalOrigin } });
    assert.equal(list.headers.get("access-control-allow-origin"), portalOrigin);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.equal((await list.json() as { machines: unknown[] }).machines.length, 1);
    assert.equal((await send(`/api/v1/machines/${f.machineId}`, { method: "PATCH", body: JSON.stringify({ name: "Office", endpoint: "https://changed-machine.test:5555" }) })).status, 200);
    assert.equal((await send(`/api/v1/machines/${f.machineId}/grant`, { method: "POST" })).status, 200);
    assert.equal((await send(`/api/v1/machines/${f.machineId}/grant`, { method: "POST" }, "bob")).status, 404);
    assert.equal((await send(`/api/v1/machines/${f.machineId}`, { method: "DELETE" })).status, 204);
    assert.equal((await send(`/api/v1/machines/${f.machineId}/grant`, { method: "POST" })).status, 404);
    assert.equal((await send("/api/v1/missing")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP JSON bodies have size, encoding, content-type and schema bounds", async () => {
  const f = await fixture();
  const server = cloudServer({ service: f.service, portalOrigin, auth: { authenticate: async () => ({ uid: "alice" }) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/pairings`;
  const send = (body: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { Authorization: "Bearer alice", "Content-Type": "application/json", ...headers }, body });
  try {
    assert.equal((await send("{" )).status, 400);
    assert.equal((await send("{}", { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await send("{}", { "Content-Encoding": "gzip" })).status, 415);
    assert.equal((await send("{}" )).status, 400);
    assert.equal((await send(JSON.stringify({ machineId: "../../alice", publicKey: f.machineKeys.publicKey }))).status, 400);
    assert.equal((await send(JSON.stringify({ machineId: f.machineId, publicKey: f.machineKeys.publicKey, uid: "bob" }))).status, 400);
    assert.equal((await send(JSON.stringify({ machineId: f.machineId, publicKey: f.machineKeys.publicKey, padding: "x".repeat(17_000) }))).status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
