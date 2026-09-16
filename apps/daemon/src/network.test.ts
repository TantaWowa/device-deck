import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from "jose";
import { machinePairingStatusSchema, publicKeySchema } from "../../../packages/core/src/hub";
import { networkSchema, type Artifact, type Operation } from "../../../packages/core/src/local/types";
import { DeckService } from "./local/service";
import { allowedNetworkHosts, MachineAuthority } from "./network";
import { createBrowserCredentials, createService } from "./server";

const issuer = "https://portal.example.com";
const uid = "owner-id";
const nativeToken = "native-api-test-token";
class HttpDeck extends DeckService {
  calls: Artifact["origin"][] = [];
  override async execute(_operation: Operation, _value: unknown, origin: Artifact["origin"] = "API") {
    this.calls.push(origin);
    return { ok: true };
  }
  override async previewSource() { return Buffer.from([255, 216, 255, 217]); }
}

async function authorityFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-machine-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const keys = await generateKeyPair("EdDSA", { extractable: true });
  const publicKey = publicKeySchema.parse(await exportJWK(keys.publicKey));
  const fetched: string[] = [];
  const request: typeof fetch = async (input, init) => {
    fetched.push(String(input));
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ issuer, publicKey }), { status: 200 });
  };
  const authority = new MachineAuthority(directory, () => now, request);
  const metadata = await authority.metadata();
  const pairingId = randomUUID();
  const sign = (purpose = "access", overrides: Record<string, unknown> = {}, lifetime = purpose === "pair" ? 300 : 60, tokenIssuer = issuer, audience = metadata.id) => {
    const seconds = Math.floor(now / 1000);
    return new SignJWT({ uid, machineId: metadata.id, pairingId, purpose, ...overrides })
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(tokenIssuer).setAudience(audience)
      .setIssuedAt(seconds).setExpirationTime(seconds + lifetime).sign(keys.privateKey);
  };
  const pair = async (overrides: Record<string, unknown> = {}) => {
    const { code } = await authority.issueCode(issuer);
    return authority.pair({ code, token: await sign("pair", overrides) });
  };
  return { authority, directory, metadata, keys, pairingId, fetched, sign, pair, advance: (ms: number) => { now += ms; } };
}

test("machine identity persists privately, pairing proves possession, and access grants stay isolated", async (t) => {
  const f = await authorityFixture(t);
  assert.equal((await stat(path.join(f.directory, "machine.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await new MachineAuthority(f.directory).metadata(), f.metadata);
  const { receipt } = await f.pair();
  assert.deepEqual(f.fetched, [`${issuer}/api/v1/public-key`]);
  const { payload } = await jwtVerify(receipt, await importJWK(f.metadata.publicKey, "EdDSA"), { algorithms: ["EdDSA"], issuer: f.metadata.id, audience: issuer });
  assert.equal(payload.purpose, "paired");
  assert.equal(payload.uid, uid);
  assert.equal(payload.pairingId, f.pairingId);
  assert.equal((await stat(path.join(f.directory, "hub-binding.json"))).mode & 0o777, 0o600);
  assert.equal(await f.authority.authorize(await f.sign()), true);
  for (const overrides of [{ uid: "other-user" }, { machineId: randomUUID() }, { pairingId: randomUUID() }, { purpose: "pair" }])
    assert.equal(await f.authority.authorize(await f.sign("access", overrides)), false);
  assert.equal(await f.authority.authorize(await f.sign("access", {}, 61)), false);
  assert.equal(await f.authority.authorize(await f.sign("access", {}, 60, "https://untrusted.example")), false);
  assert.equal(await f.authority.authorize(await f.sign("access", {}, 60, issuer, randomUUID())), false);
  assert.equal(await f.authority.authorize("not-a-jwt"), false);
  const grant = await f.sign();
  f.advance(61000);
  assert.equal(await f.authority.authorize(grant), false);
});

test("pairing codes are single-use, expire, cap guesses, and reject unrelated signatures", async (t) => {
  const f = await authorityFixture(t);
  const challenge = await f.authority.issueCode(issuer);
  const pairToken = await f.sign("pair");
  const outcomes = await Promise.allSettled([
    f.authority.pair({ code: challenge.code, token: pairToken }),
    f.authority.pair({ code: challenge.code, token: pairToken }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  await assert.rejects(f.authority.pair({ code: challenge.code, token: pairToken }), /invalid or expired/);
  const expires = await f.authority.issueCode(issuer);
  f.advance(300000);
  await assert.rejects(f.authority.pair({ code: expires.code, token: await f.sign("pair") }), /invalid or expired/);
  const guessed = await f.authority.issueCode(issuer);
  for (let attempt = 0; attempt < 8; attempt++)
    await assert.rejects(f.authority.pair({ code: "wrong", token: await f.sign("pair") }), /invalid or expired/);
  await assert.rejects(f.authority.pair({ code: guessed.code, token: await f.sign("pair") }), /invalid or expired/);
  for (const token of [await f.sign("pair", { machineId: randomUUID() }), await f.sign("pair", {}, 301), await f.sign("access")]) {
    const issued = await f.authority.issueCode(issuer);
    await assert.rejects(f.authority.pair({ code: issued.code, token }), /not authorized/);
  }
  const other = await generateKeyPair("EdDSA");
  const issued = await f.authority.issueCode(issuer);
  const forged = await new SignJWT({ uid, machineId: f.metadata.id, pairingId: f.pairingId, purpose: "pair" })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(issuer).setAudience(f.metadata.id).setIssuedAt().setExpirationTime("5m").sign(other.privateKey);
  await assert.rejects(f.authority.pair({ code: issued.code, token: forged }), /not authorized/);
});

test("re-pairing revokes old grants and explicit local unpair survives restart", async (t) => {
  const f = await authorityFixture(t);
  await f.pair();
  const prior = await f.sign();
  assert.equal(await f.authority.authorize(prior), true);
  const replacement = randomUUID();
  await f.pair({ pairingId: replacement });
  assert.equal(await f.authority.authorize(prior), false);
  const next = await f.sign("access", { pairingId: replacement });
  assert.equal(await f.authority.authorize(next), true);
  const persisted = JSON.parse(await readFile(path.join(f.directory, "hub-binding.json"), "utf8"));
  assert.equal(persisted.pairingId, replacement);
  await f.authority.unpair();
  assert.equal(await f.authority.authorize(next), false);
  assert.equal(await new MachineAuthority(f.directory).authorize(next), false);
});

test("account status follows the actual private binding through pairing, restart and unpair", async (t) => {
  const f = await authorityFixture(t);
  assert.deepEqual(await f.authority.pairingStatus(), { paired: false });
  await f.authority.issueCode(issuer);
  assert.deepEqual(await f.authority.pairingStatus(), { paired: false }, "A pairing challenge is not a completed account binding.");
  await f.pair();
  const expected = { paired: true, accountUrl: `${issuer}/app/` };
  assert.deepEqual(await f.authority.pairingStatus(), expected, "Public status contains no account ID, signing key or credential.");
  assert.deepEqual(machinePairingStatusSchema.parse(await new MachineAuthority(f.directory).pairingStatus()), expected);
  await f.authority.unpair();
  assert.deepEqual(await f.authority.pairingStatus(), { paired: false });
  assert.deepEqual(await new MachineAuthority(f.directory).pairingStatus(), { paired: false });
});

test("persisted pairing issuers and browser account links reject unsafe or unrelated addresses", async (t) => {
  const f = await authorityFixture(t);
  await f.pair();
  const file = path.join(f.directory, "hub-binding.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  for (const invalid of ["javascript:alert(1)", "http://portal.example.com", "https://user:secret@portal.example.com", `${issuer}/other`, `${issuer}?redirect=elsewhere`, `${issuer}#fragment`]) {
    await writeFile(file, JSON.stringify({ ...saved, issuer: invalid }));
    await assert.rejects(new MachineAuthority(f.directory).pairingStatus());
  }
  for (const accountUrl of ["javascript:alert(1)", "http://portal.example.com/app/", `${issuer}/app/?redirect=elsewhere`, `${issuer}/other`])
    assert.equal(machinePairingStatusSchema.safeParse({ paired: true, accountUrl }).success, false);
  assert.equal(machinePairingStatusSchema.safeParse({ paired: true, accountUrl: "http://127.0.0.1:5175/app/" }).success, true);
  assert.equal(machinePairingStatusSchema.safeParse({ paired: false, accountUrl: `${issuer}/app/` }).success, false);
  assert.equal(machinePairingStatusSchema.safeParse({ paired: true, accountUrl: `${issuer}/app/`, uid }).success, false);
});

test("portal trust is configured locally, canonical HTTPS, and never supplied by the browser", async (t) => {
  const f = await authorityFixture(t);
  for (const invalid of [undefined, "http://portal.example.com", "https://portal.example.com/path", "https://user@portal.example.com"])
    await assert.rejects(f.authority.issueCode(invalid));
  assert.deepEqual(f.fetched, []);
  const challenge = await f.authority.issueCode(issuer);
  await assert.rejects(f.authority.pair({ code: challenge.code, token: await f.sign("pair"), publicKey: f.metadata.publicKey }), /Unrecognized key/);
});

type ResponseData = { status: number; headers: IncomingHttpHeaders; body: Buffer };
async function httpFixture(t: TestContext) {
  const f = await authorityFixture(t);
  const deck = new HttpDeck(f.directory);
  deck.config.config.network = networkSchema.parse({ host: "0.0.0.0", allowedHosts: ["device.test"], hubOrigin: issuer });
  await writeFile(path.join(f.directory, "index.html"), "<h1>Device Deck</h1>");
  const credentials = createBrowserCredentials();
  const server = createService(deck, nativeToken, f.directory, { authority: f.authority, credentials });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const request = (route: string, headers: OutgoingHttpHeaders = {}, method = "GET", body?: unknown, target = "127.0.0.1") => new Promise<ResponseData>((resolve, reject) => {
    const req = http.request({ hostname: target, port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { ...f, deck, server, request, port };
}

test("account status requires authentication and is available to local browsers and verified Tailscale users", async (t) => {
  const f = await httpFixture(t);
  const route = "/v1/hub/status";
  const native = { Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" };
  assert.equal((await f.request(route)).status, 401);
  const unpaired = await f.request(route, native);
  assert.equal(unpaired.status, 200);
  assert.equal(unpaired.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(unpaired.body.toString()), { paired: false }, "Configured hubOrigin alone must not show an account link.");
  const ticket = JSON.parse((await f.request("/v1/browser-ticket", native, "POST", {})).body.toString()).ticket;
  const bootstrap = await f.request("/v1/bootstrap", { "Content-Type": "application/json" }, "POST", { ticket });
  const browser = { Cookie: bootstrap.headers["set-cookie"]![0].split(";")[0] };
  assert.equal((await f.request(route, browser)).status, 200);
  await f.pair();
  const grant = { Authorization: `Bearer ${await f.sign()}` };
  const expected = { paired: true, accountUrl: `${issuer}/app/` };
  for (const headers of [native, browser, grant]) {
    const response = await f.request(route, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), expected);
  }
  f.deck.config.config.network!.hubOrigin = "https://another-portal.example";
  assert.deepEqual(JSON.parse((await f.request(route, native)).body.toString()), expected, "A config change cannot relabel an existing binding.");
  f.deck.config.config.tailscale = { origin: "https://machine.tailnet.ts.net", allowedUsers: ["owner@example.com"] };
  const tailscale = { Host: "machine.tailnet.ts.net", "X-Forwarded-Proto": "https", "Tailscale-User-Login": "owner@example.com" };
  assert.equal((await f.request(route, { Host: tailscale.Host })).status, 403);
  assert.deepEqual(JSON.parse((await f.request(route, tailscale)).body.toString()), expected);
  assert.equal((await f.request("/v1/hub/unpair", native, "POST", {})).status, 200);
  for (const headers of [browser, tailscale])
    assert.deepEqual(JSON.parse((await f.request(route, headers)).body.toString()), { paired: false });
  assert.equal((await f.request(route, grant)).status, 401);
});

test("ordinary IP/port and custom hosts work with authentication and exact CORS rules", async (t) => {
  const f = await httpFixture(t);
  const host = `device.test:${f.port}`;
  assert.equal((await f.request("/", { Host: host })).status, 200);
  assert.equal((await f.request("/v1/health", { Host: host })).status, 401);
  assert.equal((await f.request("/v1/health", { Host: host, Authorization: `Bearer ${nativeToken}` })).status, 200);
  assert.equal((await f.request("/v1/health", { Host: "random.example", Authorization: `Bearer ${nativeToken}` })).status, 403);
  assert.equal((await f.request("/v1/machine", { Host: host, Origin: "https://evil.example" })).status, 403);
  const identity = await f.request("/v1/machine", { Host: host, Origin: issuer });
  assert.equal(identity.status, 200);
  assert.deepEqual(JSON.parse(identity.body.toString()), f.metadata);
  assert.equal(identity.headers["access-control-allow-origin"], issuer);
  const preflight = { Host: host, Origin: issuer, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,x-device-deck,content-type,range" };
  assert.equal((await f.request("/v1/operations/inventory", preflight, "OPTIONS")).status, 204);
  assert.equal((await f.request("/v1/operations/inventory", { ...preflight, Origin: "https://evil.example" }, "OPTIONS")).status, 403);
  assert.equal((await f.request("/v1/operations/inventory", { ...preflight, "Access-Control-Request-Headers": "x-untrusted" }, "OPTIONS")).status, 403);
  await f.pair();
  const grant = await f.sign();
  const headers = { Host: host, Origin: issuer, Authorization: `Bearer ${grant}`, "Content-Type": "application/json", "X-Device-Deck": "local", "X-Device-Deck-Client": "Agent" };
  assert.equal((await f.request("/v1/operations/inventory", headers, "POST", {})).status, 200);
  assert.deepEqual(f.deck.calls, ["Web"]);
  assert.equal((await f.request("/v1/operations/config.save", headers, "POST", { config: { ...f.deck.config.config, network: { host: "0.0.0.0", hubOrigin: "https://attacker.example" } } })).status, 403);
  assert.deepEqual(f.deck.calls, ["Web"], "A portal credential cannot change the machine's portal trust");
  assert.equal((await f.request("/v1/source-preview/one", headers)).status, 200);
  assert.equal((await f.request("/v1/source-preview/one", { ...headers, Authorization: `Bearer ${await f.sign("access", { uid: "other" })}` })).status, 401);
  assert.equal((await f.request("/v1/hub/pairing-code", headers, "POST", {})).status, 403);
});

test("a delayed POST body cannot dispatch operations after its hub grant expires or is revoked", async (t) => {
  for (const reason of ["expiry", "revocation"] as const) await t.test(reason, async (t) => {
    const f = await httpFixture(t);
    await f.pair();
    const grant = await f.sign();
    let sawAuthorization!: () => void;
    const authorized = new Promise<void>((resolve) => { sawAuthorization = resolve; });
    const authorize = f.authority.authorize.bind(f.authority);
    f.authority.authorize = async (token) => {
      const valid = await authorize(token);
      if (valid) sawAuthorization();
      return valid;
    };
    let request!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      request = http.request({
        hostname: "127.0.0.1", port: f.port, method: "POST", path: "/v1/operations/inventory",
        headers: { Host: `device.test:${f.port}`, Origin: issuer, Authorization: `Bearer ${grant}`, "X-Device-Deck": "local", "Content-Type": "application/json", "Content-Length": "2" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode || 0));
        res.on("error", reject);
      });
      request.on("error", reject);
      request.flushHeaders();
    });
    await authorized;
    if (reason === "expiry") f.advance(61000);
    else await f.authority.unpair();
    request.end("{}");
    assert.equal(await response, 401);
    assert.deepEqual(f.deck.calls, []);
  });
});

test("network Host allowlists handle default ports and canonical IPv6 without widening explicit ports", () => {
  const network = networkSchema.parse({ host: "0.0.0.0", allowedHosts: ["EXAMPLE.test:80", "[2001:db8:0:0::1]:443", "[2001:db8::2]"] });
  assert.deepEqual(network.allowedHosts, ["example.test:80", "[2001:db8::1]:443", "[2001:db8::2]"]);
  const httpHosts = allowedNetworkHosts(network, 80);
  assert.equal(httpHosts.has("127.0.0.1"), true);
  assert.equal(httpHosts.has("127.0.0.1:80"), true);
  assert.equal(httpHosts.has("example.test"), true);
  assert.equal(httpHosts.has("[2001:db8::2]"), true);
  const httpsHosts = allowedNetworkHosts(network, 443, "0.0.0.0", "https:");
  assert.equal(httpsHosts.has("127.0.0.1"), true);
  assert.equal(httpsHosts.has("[2001:db8::1]"), true);
  assert.equal(httpsHosts.has("example.test:443"), false);
  assert.equal(httpsHosts.has("example.test"), false);
});

test("default-port loopback Host remains native and accepts canonical browser Origin", async (t) => {
  const f = await httpFixture(t);
  // Use an ephemeral socket while exercising the same Host processing as :80;
  // tests need no privileged listener or assumption that port 80 is available.
  const address = f.server.address();
  assert.ok(address && typeof address !== "string");
  f.server.address = () => ({ ...address, port: 80 });
  const headers = { Host: "127.0.0.1", Origin: "http://127.0.0.1", Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" };
  assert.equal((await f.request("/v1/browser-ticket", headers, "POST", {})).status, 200);
  assert.equal((await f.request("/v1/browser-ticket", { ...headers, Host: "127.0.0.1:80" }, "POST", {})).status, 200);
  assert.equal((await f.request("/v1/hub/pairing-code", headers, "POST", {})).status, 200);
});

test("a separate loopback control listener issues login tickets for the external listener", async (t) => {
  const f = await authorityFixture(t);
  const deck = new HttpDeck(f.directory);
  deck.config.config.network = networkSchema.parse({ host: "127.0.0.1", allowedHosts: ["machine.example"] });
  const credentials = createBrowserCredentials();
  const external = createService(deck, nativeToken, f.directory, { authority: f.authority, credentials });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalPort = (external.address() as { port: number }).port;
  const control = createService(deck, nativeToken, f.directory, { authority: f.authority, credentials, networkPort: externalPort });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlPort = (control.address() as { port: number }).port;
  t.after(async () => {
    for (const server of [external, control]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const issued = await fetch(`http://127.0.0.1:${controlPort}/v1/browser-ticket`, {
    method: "POST", headers: { Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ address: `http://127.0.0.1:${externalPort}` }),
  });
  assert.equal(issued.status, 200);
  const { ticket } = await issued.json();
  const login = await fetch(`http://127.0.0.1:${externalPort}/v1/bootstrap`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.ok(cookie.startsWith(`deck_${externalPort}=`));
  assert.equal((await fetch(`http://127.0.0.1:${externalPort}/v1/health`, { headers: { Cookie: cookie } })).status, 200);
});

test("native launch tickets target the selected network host and remain single-use", async (t) => {
  const f = await httpFixture(t);
  const native = { Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" };
  const host = `device.test:${f.port}`;
  const issue = await f.request("/v1/browser-ticket", native, "POST", { address: `http://${host}` });
  assert.equal(issue.status, 200);
  const ticket = JSON.parse(issue.body.toString()).ticket;
  const login = await f.request("/v1/bootstrap", { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" }, "POST", { ticket });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0].split(";")[0];
  assert.ok(cookie);
  assert.equal((await f.request("/v1/health", { Host: host, Cookie: cookie })).status, 200);
  assert.equal((await f.request("/v1/health", { Cookie: cookie })).status, 401);
  assert.equal((await f.request("/v1/bootstrap", { Host: host, "Content-Type": "application/json" }, "POST", { ticket })).status, 403);
  assert.equal((await f.request("/v1/browser-ticket", native, "POST", { address: "http://untrusted.example" })).status, 400);
  assert.equal((await f.request("/v1/hub/pairing-code", { ...native, Host: host }, "POST", {})).status, 403);
});

test("Tailscale identity headers cannot authorize direct network peers", async (t) => {
  const f = await httpFixture(t);
  f.deck.config.config.tailscale = { origin: "https://machine.tailnet.ts.net", allowedUsers: ["owner@example.com"] };
  const address = Object.values(os.networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
  if (!address) { t.skip("No external IPv4 interface available"); return; }
  const headers = { Host: "machine.tailnet.ts.net", "X-Forwarded-Proto": "https", "Tailscale-User-Login": "owner@example.com" };
  assert.equal((await f.request("/v1/health", headers, "GET", undefined, address)).status, 403);
  assert.equal((await f.request("/v1/health", { Authorization: `Bearer ${nativeToken}` }, "GET", undefined, address)).status, 200);
  assert.equal((await f.request("/v1/hub/pairing-code", { Host: `127.0.0.1:${f.port}`, Authorization: `Bearer ${nativeToken}`, "Content-Type": "application/json" }, "POST", {}, address)).status, 403);
});
