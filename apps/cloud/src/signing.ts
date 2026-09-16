import { createPrivateKey, createPublicKey } from "node:crypto";
import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { PAIRING_TTL_SECONDS, publicKeySchema, type HubPublicKey } from "../../../packages/core/src/hub";
import { CloudError } from "./errors";

export interface PortalSigner {
  readonly issuer: string;
  readonly publicKey: HubPublicKey;
  sign(
    claims: { uid: string; machineId: string; pairingId: string; purpose: "pair" | "access" },
    now: number,
    ttlSeconds: number,
  ): Promise<string>;
}

export function publicEd25519Key(input: unknown): HubPublicKey {
  const result = publicKeySchema.safeParse(input);
  if (!result.success) throw new CloudError(400, "An Ed25519 public key is required; never submit private keys.");
  return result.data;
}

export async function createPortalSigner(issuer: string, privateKey: unknown): Promise<PortalSigner> {
  if (!privateKey || typeof privateKey !== "object" || Array.isArray(privateKey))
    throw new Error("PORTAL_SIGNING_KEY_JSON must contain a private Ed25519 JWK.");
  const key = privateKey as JWK;
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.d !== "string")
    throw new Error("PORTAL_SIGNING_KEY_JSON must contain a private Ed25519 JWK.");
  // Derive the public key from the private key instead of publishing unchecked input.
  const privateObject = createPrivateKey({ key, format: "jwk" });
  const publicKey = publicEd25519Key(createPublicKey(privateObject).export({ format: "jwk" }));
  const signingKey = await importJWK({ ...key, alg: "EdDSA" }, "EdDSA");
  return {
    issuer,
    publicKey,
    sign: (claims, now, ttlSeconds) => new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(claims.machineId)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + ttlSeconds)
      .sign(signingKey),
  };
}

export async function verifyPairingReceipt(
  token: string,
  publicKey: HubPublicKey,
  expected: { uid: string; machineId: string; pairingId: string; portalOrigin: string },
  now: number,
): Promise<void> {
  try {
    const key = await importJWK(publicKey, "EdDSA");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      issuer: expected.machineId,
      audience: expected.portalOrigin,
      requiredClaims: ["exp", "iat", "uid", "machineId", "pairingId", "purpose"],
      currentDate: new Date(now),
      maxTokenAge: PAIRING_TTL_SECONDS,
    });
    if (
      payload.uid !== expected.uid || payload.machineId !== expected.machineId ||
      payload.pairingId !== expected.pairingId || payload.purpose !== "paired" ||
      typeof payload.exp !== "number" || typeof payload.iat !== "number" ||
      payload.exp - payload.iat > PAIRING_TTL_SECONDS
    ) throw new Error("Receipt claims do not match this pairing.");
  } catch {
    throw new CloudError(401, "The machine pairing receipt is invalid or expired.");
  }
}
