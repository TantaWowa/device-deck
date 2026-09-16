import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeJwt, importJWK, jwtVerify, SignJWT } from "jose";
import { CloudError } from "./errors";
import { canonicalEndpoint } from "./service";
import { fixture, keys, portalOrigin } from "./test-fixtures";

test("pairing creates an owner-scoped machine and grants only that machine for 60 seconds", async () => {
  const f = await fixture();
  const pending = await f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.publicKey });
  const pairClaims = (await jwtVerify(pending.token, await importJWK(f.signer.publicKey, "EdDSA"), {
    issuer: portalOrigin, audience: f.machineId, currentDate: new Date(f.now()),
  })).payload;
  assert.equal(pairClaims.uid, "alice");
  assert.equal(pairClaims.purpose, "pair");
  assert.equal(pairClaims.exp! - pairClaims.iat!, 300);
  const { machine } = await f.service.completePairing("alice", {
    name: "  Studio  ", endpoint: "HTTPS://100.65.0.1:47831/", receipt: await f.receipt(pending.pairingId),
  });
  assert.equal(machine.name, "Studio");
  assert.equal(machine.endpoint, "https://100.65.0.1:47831");
  assert.equal(machine.pairingId, pending.pairingId);
  assert.deepEqual((await f.service.listMachines("alice")).machines.map((value) => value.id), [f.machineId]);
  assert.deepEqual(await f.service.listMachines("bob"), { machines: [] });
  const grant = await f.service.grant("alice", f.machineId), claims = decodeJwt(grant.token);
  assert.equal(claims.purpose, "access");
  assert.equal(claims.aud, f.machineId);
  assert.equal(claims.uid, "alice");
  assert.equal(claims.exp! - claims.iat!, 60);
  assert.equal(Date.parse(grant.expiresAt), f.now() + 60_000);
  assert.equal("d" in f.service.publicKey().publicKey, false);
});

test("other accounts cannot read, change, remove, or get grants for a machine", async () => {
  const f = await fixture();
  await f.pair();
  for (const operation of [
    () => f.service.getMachine("bob", f.machineId),
    () => f.service.updateMachine("bob", f.machineId, { name: "Hijacked" }),
    () => f.service.deleteMachine("bob", f.machineId),
    () => f.service.grant("bob", f.machineId),
  ]) await assert.rejects(operation, (error: unknown) => error instanceof CloudError && error.status === 404);
  assert.equal((await f.service.getMachine("alice", f.machineId)).machine.name, "Studio");
});

test("pairing requires the expected machine signature, identity and purpose", async () => {
  const f = await fixture();
  const pending = await f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.publicKey });
  const submit = (receipt: string, uid = "alice") => f.service.completePairing(uid, { name: "Studio", endpoint: "http://10.0.0.2:47831", receipt });
  await assert.rejects(() => submit(pending.token), (error: unknown) => error instanceof CloudError && error.status === 401);
  await assert.rejects(() => submit("nonsense"), (error: unknown) => error instanceof CloudError && error.status === 401);
  for (const claims of [{ uid: "bob" }, { machineId: randomUUID() }, { purpose: "access" }]) {
    const receipt = await f.receipt(pending.pairingId, claims);
    await assert.rejects(() => submit(receipt), (error: unknown) => error instanceof CloudError && error.status === 401);
  }
  const wrongKeyReceipt = await f.receipt(pending.pairingId, {}, keys().privateKey);
  await assert.rejects(() => submit(wrongKeyReceipt), (error: unknown) => error instanceof CloudError && error.status === 401);
  const validReceipt = await f.receipt(pending.pairingId);
  await assert.rejects(() => submit(validReceipt, "bob"), (error: unknown) => error instanceof CloudError && error.status === 409);
  await submit(validReceipt);
});

test("pairing receipts are one-use even when requests race", async () => {
  const f = await fixture();
  const pending = await f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.publicKey });
  const input = { name: "Studio", endpoint: "http://10.0.0.2:47831", receipt: await f.receipt(pending.pairingId) };
  const results = await Promise.allSettled([f.service.completePairing("alice", input), f.service.completePairing("alice", input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(() => f.service.completePairing("alice", input), (error: unknown) => error instanceof CloudError && error.status === 409);
});

test("receipts reject wrong issuer, audience, expiration and excessive lifetime", async () => {
  const f = await fixture();
  const pending = await f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.publicKey });
  const seconds = Math.floor(f.now() / 1000);
  for (const options of [
    { issuer: randomUUID() }, { audience: "https://other-portal.test" },
    { iat: seconds - 301, exp: seconds - 1 }, { exp: seconds + 301 }, { iat: seconds + 10 },
  ]) {
    const receipt = await new SignJWT({ uid: "alice", machineId: f.machineId, pairingId: pending.pairingId, purpose: "paired" })
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(options.issuer || f.machineId)
      .setAudience(options.audience || portalOrigin).setIssuedAt(options.iat ?? seconds)
      .setExpirationTime(options.exp ?? seconds + 300)
      .sign(await importJWK(f.machineKeys.privateKey, "EdDSA"));
    await assert.rejects(() => f.service.completePairing("alice", { name: "Studio", endpoint: "https://machine.test", receipt }), (error: unknown) => error instanceof CloudError && error.status === 401);
  }
});

test("expired pairings cannot register machines", async () => {
  const f = await fixture();
  const pending = await f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.publicKey });
  const receipt = await f.receipt(pending.pairingId);
  f.advance(300_000);
  await assert.rejects(() => f.service.completePairing("alice", { name: "Studio", endpoint: "http://10.0.0.2:47831", receipt }), (error: unknown) => error instanceof CloudError && error.status === 409);
  assert.deepEqual(await f.service.listMachines("alice"), { machines: [] });
});

test("editing an endpoint preserves machine identity and removal stops new grants", async () => {
  const f = await fixture();
  const { machine: original } = await f.pair();
  const grant = await f.service.grant("alice", f.machineId);
  f.advance(1000);
  const { machine } = await f.service.updateMachine("alice", f.machineId, { name: "Office", endpoint: "http://192.168.1.40:9000/" });
  assert.equal(machine.id, original.id);
  assert.equal(machine.createdAt, original.createdAt);
  assert.equal(machine.pairingId, original.pairingId);
  assert.equal(machine.endpoint, "http://192.168.1.40:9000");
  assert.notEqual(machine.updatedAt, original.updatedAt);
  await f.service.deleteMachine("alice", f.machineId);
  await assert.rejects(() => f.service.grant("alice", f.machineId), (error: unknown) => error instanceof CloudError && error.status === 404);
  f.advance(59_000);
  await assert.rejects(() => jwtVerify(grant.token, f.signer.publicKey, { currentDate: new Date(f.now()), algorithms: ["EdDSA"] }), /exp/);
});

test("machine addresses accept independent networking and reject credentials or non-origin URLs", () => {
  for (const [input, expected] of [
    ["http://100.94.9.50:47831", "http://100.94.9.50:47831"],
    ["https://machine.example.test:443/", "https://machine.example.test"],
    ["http://[fd7a:115c:a1e0::1]:47831", "http://[fd7a:115c:a1e0::1]:47831"],
    ["http://localhost:47831", "http://localhost:47831"],
  ]) assert.equal(canonicalEndpoint(input), expected);
  for (const input of [
    "javascript:alert(1)", "file:///etc/passwd", "ftp://machine.test", "https://user:pass@machine.test",
    "https://machine.test/path", "https://machine.test?token=secret", "https://machine.test/#secret", "not an address",
    "https:machine.test", "https://machine.test\\other", "http://0.0.0.0:47831", "http://[::]:47831",
  ]) assert.throws(() => canonicalEndpoint(input), CloudError);
});

test("machine creation cannot smuggle credentials or ownership and private keys are rejected", async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.beginPairing("alice", { machineId: f.machineId, publicKey: f.machineKeys.privateKey }), CloudError);
  await f.pair();
  for (const input of [{ uid: "bob" }, { publicKey: keys().publicKey }, { pairingId: randomUUID() }, {}])
    await assert.rejects(() => f.service.updateMachine("alice", f.machineId, input), CloudError);
});
