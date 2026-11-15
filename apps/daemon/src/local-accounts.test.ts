import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { deckFixture } from "../../../tests/decks";
import { LocalAccounts } from "./local-accounts";
import { createService } from "./server";

async function fixture() {
  const base = await deckFixture("Shared");
  const credentials = new Map<number, { token: string }>();
  const guestUID = process.getuid!() + 100;
  const accounts = new LocalAccounts(base.directory, { schemaVersion: 1, uid: process.getuid!(), username: "host", home: base.directory, profile: base.directory }, {
    directory: base.directory,
    users: async () => [{ uid: guestUID, username: "ci-runner" }],
    writeCredential: async (uid, value) => { credentials.set(uid, value as { token: string }); },
  });
  const server = createService(base.deck, base.token, "/missing", { accounts, authority: base.authority });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await accounts.start({ port, pid: process.pid, startedAt: Date.now() });
  const grant = await accounts.grant({ uid: guestUID, username: "ci-runner" });
  const guest = credentials.get(guestUID)!.token;
  const request = (route: string, body?: unknown, access = guest, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), "Content-Type": "application/json", "X-Device-Deck": "local", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...base, accounts, grant, guest, guestUID, credentials, request, accountPort: port,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await base.close(); },
  };
}

test("allowed Mac accounts share the host's reservations and cannot administer trust or tools", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.request("/v1/health", undefined, "unauthorized")).status, 401);
  const reserve = { selector: { device: "tv" }, owner: "ci-runner", reason: "Shared account test", ttlMinutes: 5 };
  const response = await f.request("/v1/operations/sessions.reserve", reserve);
  assert.equal(response.status, 200);
  const acquired = await response.json();
  assert.equal((await f.request("/v1/operations/sessions.reserve", reserve, f.token)).status, 409);
  assert.equal(f.deck.store.sessions().length, 1);
  for (const route of ["/v1/local-accounts/list", "/v1/deck-access/grant", "/v1/service/prepare-update"])
    assert.equal((await f.request(route, {})).status, 403);
  const current = await (await f.request("/v1/operations/config.get", {})).json();
  current.config.tools.python = "/tmp/untrusted";
  assert.equal((await f.request("/v1/operations/config.save", current)).status, 403);
  assert.equal((await readFile(path.join(f.directory, "local-accounts.json"), "utf8")).includes(f.guest), false);
  await f.accounts.revoke(f.guestUID);
  assert.equal((await f.request("/v1/operations/inventory", {})).status, 401);
  assert.equal((await f.request("/v1/operations/sessions.release", { sessionId: acquired.session.id, leaseToken: acquired.leaseToken }, f.token)).status, 200);
});

test("account browser tickets retain restrictions and revocation, including already issued cookies", async t => {
  const f = await fixture(); t.after(f.close);
  const ticket = await (await f.request("/v1/browser-ticket", {})).json();
  assert.ok(ticket.ticket);
  const bootstrap = await f.request("/v1/bootstrap", ticket, "");
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
  const browser = { Cookie: cookie };
  assert.equal((await f.request("/v1/operations/inventory", {}, "", browser)).status, 200);
  assert.equal((await f.request("/v1/local-accounts/list", {}, "", browser)).status, 403);
  const pendingTicket = await (await f.request("/v1/browser-ticket", {})).json();
  await f.accounts.revoke(f.guestUID);
  assert.equal((await f.request("/v1/operations/inventory", {}, "", browser)).status, 401);
  assert.equal((await f.request("/v1/bootstrap", pendingTicket, "")).status, 403);
  await f.accounts.grant({ uid: f.guestUID, username: "ci-runner" });
  assert.equal((await f.request("/v1/operations/inventory", {}, "", browser)).status, 401);
});

test("updates drain the shared service without interrupting reservations and block new work until canceled", async t => {
  const f = await fixture(); t.after(f.close);
  const reserve = { selector: { device: "tv" }, owner: "ci-runner", reason: "Update test", ttlMinutes: 5 };
  const acquired = await (await f.request("/v1/operations/sessions.reserve", reserve)).json();
  assert.equal((await f.request("/v1/service/prepare-update", {}, f.token)).status, 409);
  await f.request("/v1/operations/sessions.release", { sessionId: acquired.session.id, leaseToken: acquired.leaseToken });
  assert.equal((await f.request("/v1/service/prepare-update", {}, f.token)).status, 200);
  assert.equal((await f.request("/v1/operations/sessions.reserve", reserve)).status, 503);
  assert.equal((await f.request("/v1/operations/inventory", {})).status, 200);
  assert.equal((await f.request("/v1/service/cancel-update", {}, f.token)).status, 200);
  assert.equal((await f.request("/v1/operations/sessions.reserve", reserve)).status, 200);
});

test("a restarting service rotates account credentials and delayed requests cannot outlive revocation", async t => {
  const f = await fixture(); t.after(f.close);
  await f.accounts.start({ port: f.accountPort, pid: process.pid, startedAt: Date.now() });
  const current = f.credentials.get(f.guestUID)!.token;
  assert.notEqual(current, f.guest);
  assert.equal((await f.request("/v1/health")).status, 401);
  assert.equal((await f.request("/v1/health", undefined, current)).status, 200);
  let didAuthorize!: () => void;
  const authorized = new Promise<void>(resolve => { didAuthorize = resolve; });
  const authorize = f.accounts.authorize.bind(f.accounts);
  f.accounts.authorize = async token => { const grant = await authorize(token); if (grant) didAuthorize(); return grant; };
  let request!: http.ClientRequest;
  const response = new Promise<number>((resolve, reject) => {
    request = http.request({ hostname: "127.0.0.1", port: f.accountPort, method: "POST", path: "/v1/operations/inventory",
      headers: { Authorization: `Bearer ${current}`, "X-Device-Deck": "local", "Content-Type": "application/json", "Content-Length": "2" },
    }, response => { response.resume(); response.on("end", () => resolve(response.statusCode || 0)); response.on("error", reject); });
    request.on("error", reject); request.flushHeaders();
  });
  await authorized;
  await f.accounts.revoke(f.guestUID);
  request.end("{}");
  assert.equal(await response, 401);
});

test("startup drops deleted and reassigned account grants while retaining valid users", async t => {
  const f = await fixture(); t.after(f.close);
  const host = f.accounts.host!;
  const deletedUID = f.guestUID + 1, renamedUID = f.guestUID + 2, reusedNameUID = f.guestUID + 3;
  const deleted = await f.accounts.grant({ uid: deletedUID, username: "deleted-runner" });
  const renamed = await f.accounts.grant({ uid: renamedUID, username: "old-runner-name" });
  const reused = await f.accounts.grant({ uid: reusedNameUID, username: "reused-name" });
  const oldTokens = [f.guest, ...[deletedUID, renamedUID, reusedNameUID].map(uid => f.credentials.get(uid)!.token)];
  const access = path.join(f.directory, "access");
  await mkdir(access);
  for (const uid of [deletedUID, renamedUID, reusedNameUID]) await writeFile(path.join(access, `${uid}.json`), "stale credential");
  const written: number[] = [];
  let replacementToken = "";
  const restarted = new LocalAccounts(f.directory, host, {
    directory: f.directory,
    users: async () => [
      { uid: f.guestUID, username: "ci-runner" },
      { uid: renamedUID, username: "new-owner-of-uid" },
      { uid: reusedNameUID + 1, username: "reused-name" },
    ],
    writeCredential: async (uid, value) => {
      // Invalid accounts are already revoked and their files removed when
      // the first surviving credential is refreshed.
      for (const grant of [deleted, renamed, reused]) assert.equal(await restarted.active(grant.id), false);
      for (const staleUID of [deletedUID, renamedUID, reusedNameUID])
        await assert.rejects(readFile(path.join(access, `${staleUID}.json`)), { code: "ENOENT" });
      written.push(uid); replacementToken = (value as { token: string }).token;
    },
  });
  await restarted.start({ port: f.accountPort, pid: process.pid, startedAt: Date.now() });
  assert.deepEqual(written, [f.guestUID]);
  assert.deepEqual((await restarted.list()).grants.map(g => g.username), ["ci-runner"]);
  for (const token of oldTokens) assert.equal(await restarted.authorize(token), undefined);
  assert.equal((await restarted.authorize(replacementToken))?.uid, f.guestUID);
});

test("startup does not hide access-directory or ACL failures for retained accounts", async t => {
  const f = await fixture(); t.after(f.close);
  const permissionError = Object.assign(new Error("ACL update denied"), { code: "EACCES" });
  const restarted = new LocalAccounts(f.directory, f.accounts.host, {
    directory: f.directory,
    users: async () => [{ uid: f.guestUID, username: "ci-runner" }],
    writeCredential: async () => { throw permissionError; },
  });
  await assert.rejects(restarted.start({ port: f.accountPort, pid: process.pid, startedAt: Date.now() }), error => error === permissionError);
  assert.equal((await restarted.list()).grants.length, 1);
  const directoryError = new Error("Local account directory unavailable");
  const unavailable = new LocalAccounts(f.directory, f.accounts.host, {
    directory: f.directory, users: async () => { throw directoryError; },
  });
  await assert.rejects(unavailable.start({ port: f.accountPort, pid: process.pid, startedAt: Date.now() }), error => error === directoryError);
});
