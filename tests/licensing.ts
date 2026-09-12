// Test harness only. No production entry point imports this module.
import {
  generateKeyPairSync,
  sign,
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LicenseManager } from "../packages/licensing/src";
import { FEATURES, type LicensingTrust } from "../packages/licensing/src/trust";
import {
  ProviderUnavailable,
  type Activation,
  type LicenseProvider,
} from "../packages/licensing/src/provider";
export const pair = generateKeyPairSync("ed25519");
export const trust: LicensingTrust = {
  mode: "test",
  accountId: "test-account",
  productId: "test-product",
  proPolicyId: "test-pro",
  trialPolicyId: "test-trial",
  publicKey: pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex"),
};
export const identity = {
  key: "TEST-ONLY-LICENSE-KEY",
  licenseId: "test-license",
  machineId: "test-machine",
  fingerprint: "test-fingerprint",
};
const relation = (type: string, id: string) => ({ data: { type, id } });
export function document(now = Date.now()) {
  const license = {
    type: "licenses",
    id: identity.licenseId,
    attributes: {
      key: identity.key,
      status: "ACTIVE",
      suspended: false,
      metadata: { deviceDeckMode: "test" },
      expiry: new Date(now + 7 * 86400000).toISOString(),
    },
    relationships: {
      account: relation("accounts", trust.accountId),
      product: relation("products", trust.productId),
      policy: relation("policies", trust.proPolicyId),
    },
  };
  const machine = {
    type: "machines",
    id: identity.machineId,
    attributes: { fingerprint: identity.fingerprint },
    relationships: {
      account: relation("accounts", trust.accountId),
      product: relation("products", trust.productId),
      license: relation("licenses", identity.licenseId),
    },
  };
  return {
    data: machine,
    included: [
      license,
      ...Object.values(FEATURES).map((code, i) => ({
        type: "entitlements",
        id: `ent-${i}`,
        attributes: { code },
        relationships: {},
      })),
    ],
    meta: {
      issued: new Date(now - 1000).toISOString(),
      expiry: new Date(now + 3599000).toISOString(),
      ttl: 3600,
    },
  };
}
export function certificate(
  doc: unknown = document(),
  kind = "MACHINE",
  encrypted = true,
) {
  let enc: string;
  if (encrypted) {
    const iv = randomBytes(12),
      secret = createHash("sha256")
        .update(identity.key + (kind === "MACHINE" ? identity.fingerprint : ""))
        .digest();
    const aes = createCipheriv("aes-256-gcm", secret, iv);
    const body = Buffer.concat([aes.update(JSON.stringify(doc)), aes.final()]);
    enc = [body, iv, aes.getAuthTag()]
      .map((x) => x.toString("base64"))
      .join(".");
  } else enc = Buffer.from(JSON.stringify(doc)).toString("base64");
  const sig = sign(
    null,
    Buffer.from(`${kind.toLowerCase()}/${enc}`),
    pair.privateKey,
  ).toString("base64");
  return `-----BEGIN ${kind} FILE-----\n${Buffer.from(JSON.stringify({ enc, sig, alg: encrypted ? "aes-256-gcm+ed25519" : "base64+ed25519" })).toString("base64")}\n-----END ${kind} FILE-----\n`;
}
export class TestProvider implements LicenseProvider {
  mode: "active" | "unavailable" | "invalid" = "active";
  async activate(key: string) {
    if (key !== identity.key) throw new Error("Invalid test key");
    return this.refresh();
  }
  async refresh() {
    if (this.mode === "unavailable")
      throw new ProviderUnavailable("Offline fixture");
    if (this.mode === "invalid") throw new Error("Revoked fixture");
    return { ...identity, certificate: certificate() } as Activation;
  }
  async deactivate() {
    if (this.mode === "unavailable")
      throw new ProviderUnavailable("Offline fixture");
  }
}
export async function licensedManager(
  directory: string,
  provider = new TestProvider(),
) {
  const saved = {
    key: identity.key,
    licenseId: identity.licenseId,
    machineId: identity.machineId,
    certificate: certificate(),
    lastSeen: Date.now(),
  };
  await writeFile(path.join(directory, "license.json"), JSON.stringify(saved), {
    mode: 0o600,
  });
  return {
    manager: new LicenseManager(
      directory,
      trust,
      provider,
      async () => identity.fingerprint,
    ),
    provider,
  };
}
