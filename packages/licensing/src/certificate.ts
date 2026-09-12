import {
  createDecipheriv,
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { z } from "zod";
import { FEATURES, OFFLINE_SECONDS, type LicensingTrust } from "./trust";
const resource = z.object({
  type: z.string(),
  id: z.string().min(1),
  attributes: z.record(z.unknown()),
  relationships: z
    .record(z.object({ data: z.unknown().optional() }).passthrough())
    .default({}),
});
export type Resource = z.infer<typeof resource>;
export function relationship(item: Resource, name: string, type: string) {
  const value = item.relationships[name]?.data;
  return z.object({ type: z.literal(type), id: z.string().min(1) }).parse(value)
    .id;
}
export function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Missing or invalid license timestamp.");
  return Date.parse(value);
}
export function checkLicense(
  value: unknown,
  trust: LicensingTrust,
  key: string,
  now: number,
  allowInactive = false,
) {
  const license = resource.parse(value);
  if (
    license.type !== "licenses" ||
    relationship(license, "account", "accounts") !== trust.accountId ||
    relationship(license, "product", "products") !== trust.productId ||
    license.attributes.key !== key
  )
    throw new Error("License identity does not match this product.");
  const policy = relationship(license, "policy", "policies");
  if (
    z
      .object({ deviceDeckMode: z.literal(trust.mode) })
      .safeParse(license.attributes.metadata).success !== true
  )
    throw new Error("License billing mode does not match this release.");
  if (
    policy !== trust.proPolicyId &&
    (!trust.trialPolicyId || policy !== trust.trialPolicyId)
  )
    throw new Error("License policy does not grant Device Deck Pro.");
  const expiry = timestamp(license.attributes.expiry);
  if (
    expiry <= now ||
    license.attributes.suspended !== false ||
    !["ACTIVE", "EXPIRING", ...(allowInactive ? ["INACTIVE"] : [])].includes(
      String(license.attributes.status),
    )
  )
    throw new Error("License is expired, suspended or inactive.");
  return {
    license,
    expiry,
    tier:
      policy === trust.trialPolicyId ? ("trial" as const) : ("pro" as const),
  };
}
function base64(value: string) {
  if (
    !value.length ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Invalid certificate encoding.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error("Invalid certificate encoding.");
  return decoded;
}
export type Grant = {
  licenseId: string;
  machineId: string;
  tier: "trial" | "pro";
  issued: number;
  validUntil: number;
  licenseExpiry: number;
  features: string[];
};
export function verifyCertificate(
  certificate: string,
  trust: LicensingTrust,
  identity: {
    key: string;
    fingerprint: string;
    licenseId: string;
    machineId: string;
  },
  now = Date.now(),
): Grant {
  if (certificate.length > 1024 * 1024)
    throw new Error("Certificate is too large.");
  const match =
    /^-----BEGIN (MACHINE|LICENSE) FILE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END \1 FILE-----\r?\n?$/.exec(
      certificate,
    );
  if (!match) throw new Error("Invalid certificate envelope.");
  const kind = match[1].toLowerCase();
  const envelope = z
    .object({
      enc: z.string(),
      sig: z.string(),
      alg: z.enum(["base64+ed25519", "aes-256-gcm+ed25519"]),
    })
    .strict()
    .parse(
      JSON.parse(base64(match[2].replace(/[\r\n]/g, "")).toString("utf8")),
    );
  if (!/^[a-fA-F0-9]{64}$/.test(trust.publicKey))
    throw new Error("Invalid release public key.");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(trust.publicKey, "hex"),
    ]),
    type: "spki",
    format: "der",
  });
  if (
    !verify(
      null,
      Buffer.from(`${kind}/${envelope.enc}`),
      publicKey,
      base64(envelope.sig),
    )
  )
    throw new Error("Certificate signature is invalid.");
  let plaintext: Buffer;
  if (envelope.alg === "base64+ed25519") plaintext = base64(envelope.enc);
  else {
    const parts = envelope.enc.split(".");
    if (parts.length !== 3) throw new Error("Invalid encrypted certificate.");
    const [ciphertext, iv, tag] = parts.map(base64);
    if (iv.length !== 12 || tag.length !== 16)
      throw new Error("Invalid encrypted certificate.");
    const secret = createHash("sha256")
      .update(identity.key + (kind === "machine" ? identity.fingerprint : ""))
      .digest();
    const aes = createDecipheriv("aes-256-gcm", secret, iv);
    aes.setAuthTag(tag);
    plaintext = Buffer.concat([aes.update(ciphertext), aes.final()]);
  }
  const document = z
    .object({
      data: resource,
      included: z.array(resource).default([]),
      meta: z.object({
        issued: z.string(),
        expiry: z.string(),
        ttl: z.number().int().positive(),
      }),
    })
    .parse(JSON.parse(plaintext.toString("utf8")));
  const issued = timestamp(document.meta.issued),
    expiry = timestamp(document.meta.expiry);
  if (
    issued > now ||
    expiry <= now ||
    expiry <= issued ||
    document.meta.ttl > OFFLINE_SECONDS ||
    expiry - issued > document.meta.ttl * 1000 ||
    expiry - issued > OFFLINE_SECONDS * 1000
  )
    throw new Error(
      "Certificate is expired or outside its permitted offline lifetime.",
    );
  const all = [document.data, ...document.included];
  if (new Set(all.map((x) => `${x.type}/${x.id}`)).size !== all.length)
    throw new Error("Ambiguous certificate resources.");
  const machine = all.find(
    (x) => x.type === "machines" && x.id === identity.machineId,
  );
  const rawLicense = all.find(
    (x) => x.type === "licenses" && x.id === identity.licenseId,
  );
  if (
    !machine ||
    !rawLicense ||
    (kind === "machine"
      ? document.data !== machine
      : document.data !== rawLicense) ||
    machine.attributes.fingerprint !== identity.fingerprint ||
    relationship(machine, "license", "licenses") !== identity.licenseId ||
    relationship(machine, "product", "products") !== trust.productId ||
    relationship(machine, "account", "accounts") !== trust.accountId
  )
    throw new Error("Certificate is for another machine or license.");
  const checked = checkLicense(rawLicense, trust, identity.key, now);
  // Included entitlement records are inside the signed checkout document. Only
  // the single matching license is accepted; extra licenses cannot contribute.
  if (all.filter((x) => x.type === "licenses").length !== 1)
    throw new Error("Ambiguous certificate license.");
  const features = all
    .filter((x) => x.type === "entitlements")
    .map((x) => z.string().parse(x.attributes.code));
  if (!Object.values(FEATURES).every((code) => features.includes(code)))
    throw new Error("Certificate lacks required Pro entitlements.");
  return {
    licenseId: identity.licenseId,
    machineId: machine.id,
    tier: checked.tier,
    issued,
    validUntil: Math.min(expiry, checked.expiry),
    licenseExpiry: checked.expiry,
    features,
  };
}
