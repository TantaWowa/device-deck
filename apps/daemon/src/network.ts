import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";
import { z } from "zod";
import { atomicWrite, SerialQueue } from "../../../packages/config/src";
import { DeckError, type Config } from "../../../packages/core/src/local/types";
import { version } from "../../../packages/core/src/version";
import { publicKeySchema, hubClaimsSchema, pairMachineRequestSchema, portalOriginSchema, type MachinePairingStatus, PAIRING_TTL_SECONDS, ACCESS_TTL_SECONDS } from "../../../packages/core/src/hub";

const privateKeySchema = publicKeySchema.extend({ d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const identitySchema = z.object({ id: z.string().uuid(), privateKey: privateKeySchema }).strict();
const bindingSchema = z.object({ issuer: portalOriginSchema, pinnedCloudJWK: publicKeySchema, uid: z.string().min(1).max(128), pairingId: z.string().min(1).max(128) }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest();
const deny = () => new DeckError("invalid-machine-credential", "Machine access has expired or is not authorized. Reconnect from your machines page.", 401);
export type MachineAccess = Readonly<{ issuer: string; machineId: string; uid: string; pairingId: string; expiresAt: number }>;
export const isLoopback = (value = "") => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value);
export const hostWithPort = (host: string, port: number) => `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

/** Host checks protect browser requests from DNS rebinding. Local interface IPs
 * are explicit runtime entries; arbitrary Host or forwarded headers never grant access. */
export function allowedNetworkHosts(network: Config["network"], port: number, bindHost = network?.host || "127.0.0.1", protocol = "http:") {
  const hosts = new Set<string>();
  const add = (host: string) => {
    // Browsers omit :80 / :443 in Host and canonicalize IPv6 literals.
    try {
      const canonical = new URL(`${protocol}//${host}`).host;
      hosts.add(host);
      hosts.add(canonical);
    } catch {}
  };
  for (const host of ["127.0.0.1", "localhost", "::1"]) add(hostWithPort(host, port));
  if (network || !isLoopback(bindHost)) {
    for (const configured of network?.allowedHosts || []) {
      add(configured);
      if (!/:(\d+)$/.test(configured)) add(hostWithPort(configured, port));
    }
    if (!["0.0.0.0", "::"].includes(bindHost)) add(hostWithPort(bindHost, port));
    add(hostWithPort(os.hostname().toLowerCase(), port));
    for (const addresses of Object.values(os.networkInterfaces()))
      for (const address of addresses || []) add(hostWithPort(address.address, port));
  }
  return hosts;
}

export class MachineAuthority {
  private identity?: z.infer<typeof identitySchema>;
  private binding?: z.infer<typeof bindingSchema>;
  private loading?: Promise<void>;
  private bindingChanges = new SerialQueue();
  private revocation = 0;
  private challenge?: { hash: Buffer; expiresAt: number; attempts: number; issuer: string; publicKey: z.infer<typeof publicKeySchema> };
  constructor(readonly directory: string, private readonly now = Date.now, private readonly request = fetch) {}
  async init() {
    if (!this.loading) this.loading = this.load();
    await this.loading;
  }
  private async load() {
    const file = path.join(this.directory, "machine.json");
    try { this.identity = identitySchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const keys = await generateKeyPair("EdDSA", { extractable: true });
      this.identity = { id: randomUUID(), privateKey: privateKeySchema.parse(await exportJWK(keys.privateKey)) };
      await atomicWrite(file, JSON.stringify(this.identity));
    }
    await chmod(file, 0o600);
    try {
      const bindingFile = path.join(this.directory, "hub-binding.json");
      this.binding = bindingSchema.parse(JSON.parse(await readFile(bindingFile, "utf8")));
      await chmod(bindingFile, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async metadata() {
    await this.init();
    const { d: _private, ...publicKey } = this.identity!.privateKey;
    return { id: this.identity!.id, name: os.hostname().slice(0, 120), version, publicKey };
  }
  async pairingStatus(): Promise<MachinePairingStatus> {
    await this.init();
    return this.binding
      ? { paired: true, accountUrl: `${this.binding.issuer}/app/` }
      : { paired: false };
  }
  async issueCode(issuer: string | undefined) {
    await this.init();
    if (!issuer) throw new DeckError("portal-not-configured", "Configure a portal with devdeck network enable --portal https://your-portal first.", 409);
    if (!portalOriginSchema.safeParse(issuer).success)
      throw new DeckError("invalid-portal", "The configured portal must use HTTPS or loopback HTTP for development.");
    const response = await this.request(`${issuer}/api/v1/public-key`, { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new DeckError("portal-unavailable", "Could not retrieve the configured portal's signing key.", 502);
    const data = await response.json();
    if (data.issuer !== undefined && data.issuer !== issuer) throw new DeckError("invalid-portal", "The portal signing issuer does not match its configured origin.");
    const publicKey = publicKeySchema.parse(data.publicKey);
    await importJWK(publicKey, "EdDSA");
    const code = randomBytes(5).toString("hex").toUpperCase();
    const expiresAt = this.now() + PAIRING_TTL_SECONDS * 1000;
    this.challenge = { hash: hash(code), expiresAt, attempts: 0, issuer, publicKey };
    return { machineId: this.identity!.id, code, expiresAt, portal: issuer };
  }
  private async verify(token: string, publicKey: JWK, issuer: string, purpose: "pair" | "access", lifetime: number) {
    const { payload } = await jwtVerify(token, await importJWK(publicKey, "EdDSA"), {
      algorithms: ["EdDSA"], issuer, audience: this.identity!.id,
      currentDate: new Date(this.now()), requiredClaims: ["iat", "exp", "uid", "machineId", "pairingId", "purpose"],
    });
    const now = Math.floor(this.now() / 1000);
    hubClaimsSchema.parse(payload);
    if (payload.purpose !== purpose || payload.machineId !== this.identity!.id ||
      typeof payload.uid !== "string" || !payload.uid || payload.uid.length > 128 ||
      typeof payload.pairingId !== "string" || !payload.pairingId || payload.pairingId.length > 128 ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
      payload.iat! > now || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > lifetime)
      throw deny();
    return payload;
  }
  async pair(input: unknown) {
    await this.init();
    const { code, token } = pairMachineRequestSchema.parse(input);
    const challenge = this.challenge;
    if (!challenge || challenge.expiresAt <= this.now() || ++challenge.attempts > 8 ||
      !timingSafeEqual(hash(code.trim().toUpperCase()), challenge.hash))
      throw new DeckError("invalid-pairing-code", "Pairing code is invalid or expired. Run devdeck pair on the machine for a new code.", 403);
    // Consume before asynchronous signature verification so concurrent claims cannot replay the code.
    this.challenge = undefined;
    const revocation = this.revocation;
    let payload: JWTPayload;
    try { payload = await this.verify(token, challenge.publicKey, challenge.issuer, "pair", PAIRING_TTL_SECONDS); }
    catch { throw deny(); }
    const binding = bindingSchema.parse({ issuer: challenge.issuer, pinnedCloudJWK: challenge.publicKey, uid: payload.uid, pairingId: payload.pairingId });
    await this.bindingChanges.run(async () => {
      if (revocation !== this.revocation) throw deny();
      await atomicWrite(path.join(this.directory, "hub-binding.json"), JSON.stringify(binding));
      if (revocation === this.revocation) this.binding = binding;
    });
    if (revocation !== this.revocation) throw deny();
    const now = Math.floor(this.now() / 1000);
    const receipt = await new SignJWT({ uid: binding.uid, machineId: this.identity!.id, pairingId: binding.pairingId, purpose: "paired" })
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(this.identity!.id).setAudience(binding.issuer)
      .setIssuedAt(now).setExpirationTime(now + PAIRING_TTL_SECONDS)
      .sign(await importJWK(this.identity!.privateKey, "EdDSA"));
    return { receipt };
  }
  async authorizeClaims(token: string): Promise<MachineAccess | undefined> {
    await this.init();
    const binding = this.binding;
    if (!binding) return undefined;
    try {
      const payload = await this.verify(token, binding.pinnedCloudJWK, binding.issuer, "access", ACCESS_TTL_SECONDS);
      if (this.binding !== binding || payload.uid !== binding.uid || payload.pairingId !== binding.pairingId) return undefined;
      return { issuer: binding.issuer, machineId: this.identity!.id, uid: binding.uid, pairingId: binding.pairingId, expiresAt: payload.exp! * 1000 };
    } catch { return undefined; }
  }
  async authorize(token: string) { return Boolean(await this.authorizeClaims(token)); }
  async unpair() {
    await this.init();
    this.revocation++;
    this.binding = undefined;
    this.challenge = undefined;
    await this.bindingChanges.run(() => rm(path.join(this.directory, "hub-binding.json"), { force: true }));
    return { paired: false };
  }
}
