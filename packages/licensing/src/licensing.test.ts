import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyCertificate } from "./certificate";
import { LicenseManager } from "./index";
import { KeygenProvider } from "./provider";
import {
  certificate,
  document,
  identity,
  trust,
  licensedManager,
} from "../../../tests/licensing";
test("signed encrypted machine/license files enforce signature, product, machine, license, features and bounded expiry", () => {
  const now = Date.now();
  assert.equal(
    verifyCertificate(certificate(document(now)), trust, identity, now).tier,
    "pro",
  );
  const trial = document(now);
  (trial.included[0].relationships as any).policy.data.id =
    trust.trialPolicyId!;
  assert.equal(
    verifyCertificate(certificate(trial), trust, identity, now).tier,
    "trial",
  );
  const licenseDoc = document(now);
  const machine = licenseDoc.data;
  licenseDoc.data = licenseDoc.included[0] as any;
  licenseDoc.included = [machine as any, ...licenseDoc.included.slice(1)];
  assert.equal(
    verifyCertificate(certificate(licenseDoc, "LICENSE"), trust, identity, now)
      .licenseId,
    identity.licenseId,
  );
  for (const mutate of [
    (d: any) => (d.included[0].relationships.product.data.id = "wrong-product"),
    (d: any) => (d.data.attributes.fingerprint = "another-mac"),
    (d: any) => (d.data.relationships.license.data.id = "other-license"),
    (d: any) => (d.included[0].attributes.key = "other-key"),
    (d: any) => (d.included[0].attributes.suspended = true),
    (d: any) => (d.included[0].attributes.metadata.deviceDeckMode = "live"),
    (d: any) => (d.included[0].attributes.expiry = new Date(now).toISOString()),
    (d: any) => d.included.pop(),
    (d: any) => (d.meta.expiry = new Date(now).toISOString()),
    (d: any) => {
      d.meta.ttl = 172800;
      d.meta.expiry = new Date(now + 172799000).toISOString();
    },
    (d: any) => (d.meta.issued = new Date(now + 1).toISOString()),
    (d: any) => (d.included[0].relationships.policy.data.id = "unknown-policy"),
  ]) {
    const d = document(now);
    mutate(d);
    assert.throws(() =>
      verifyCertificate(certificate(d), trust, identity, now),
    );
  }
  const proof = certificate(document(now));
  assert.throws(() =>
    verifyCertificate(
      proof,
      { ...trust, publicKey: "0".repeat(64) },
      identity,
      now,
    ),
  );
  const lines = proof.trim().split("\n"),
    envelope = JSON.parse(Buffer.from(lines[1], "base64").toString());
  envelope.sig = Buffer.alloc(64).toString("base64");
  lines[1] = Buffer.from(JSON.stringify(envelope)).toString("base64");
  assert.throws(() =>
    verifyCertificate(lines.join("\n"), trust, identity, now),
  );
});
test("offline cache is bounded; authoritative rejection removes Pro; writable config cannot grant access", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-license-"));
  const { manager, provider } = await licensedManager(dir);
  try {
    await manager.init();
    assert.equal(manager.status().tier, "pro");
    provider.mode = "unavailable";
    await manager.refresh();
    assert.equal(manager.status().state, "offline");
    assert.equal(manager.status().tier, "pro");
    provider.mode = "invalid";
    await manager.refresh();
    assert.equal(manager.status().tier, "free");
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "license.json"), "utf8"))
        .certificate,
      "",
    );
    await writeFile(
      path.join(dir, "license.json"),
      JSON.stringify({
        tier: "pro",
        paid: true,
        owner: "George",
        features: ["*"],
      }),
    );
    const fresh = new LicenseManager(dir, null);
    await fresh.init();
    assert.equal(fresh.status().tier, "free");
    fresh.close();
    assert.equal(
      JSON.stringify(manager.status()).includes(identity.key),
      false,
    );
  } finally {
    manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("online validation rejects truthy/expired success, mismatched nonce, wrong product and malformed responses", async () => {
  for (const mode of [
    "truthy",
    "expired",
    "nonce",
    "product",
    "errors",
    "missing",
  ]) {
    const transport = async (_url: any, init: any) => {
      const { meta } = JSON.parse(init.body),
        d = document().included[0];
      const response: any = {
        data: d,
        meta: { ...meta, valid: true, code: "VALID" },
      };
      if (mode === "truthy") response.meta.valid = "true";
      if (mode === "expired") response.meta.code = "EXPIRED";
      if (mode === "nonce") response.meta.nonce++;
      if (mode === "product")
        (d.relationships as any).product.data.id = "wrong-product";
      if (mode === "errors") response.errors = [];
      if (mode === "missing") delete response.data;
      return Response.json(response);
    };
    await assert.rejects(
      new KeygenProvider(trust, transport as typeof fetch).activate(
        identity.key,
        identity.fingerprint,
      ),
    );
  }
});
