import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, SerialQueue } from "../../config/src";
import { verifyCertificate, type Grant } from "./certificate";
import {
  KeygenProvider,
  ProviderUnavailable,
  type LicenseProvider,
  type Activation,
} from "./provider";
import { releaseTrust, FEATURES, type LicensingTrust } from "./trust";
export type LicenseStatus = {
  tier: "free" | "trial" | "pro" | "enterprise";
  state: "free" | "active" | "offline" | "expired" | "invalid" | "unconfigured";
  configured: boolean;
  message: string;
  fingerprint?: string;
  licenseId?: string;
  licenseExpiry?: number;
  offlineUntil?: number;
  features: string[];
  checkoutUrl?: string;
  maxSessions: number | null;
};
const stored = z
  .object({
    key: z.string().min(1).max(4096),
    licenseId: z.string().min(1),
    machineId: z.string().min(1),
    certificate: z.string().max(1024 * 1024),
    lastSeen: z.number().finite().nonnegative(),
  })
  .strict();
export interface EntitlementService {
  init(): Promise<void>;
  status(): LicenseStatus;
  activate(key: string): Promise<LicenseStatus>;
  refresh(): Promise<LicenseStatus>;
  deactivate(): Promise<LicenseStatus>;
  close(): void;
}
async function macFingerprint() {
  if (process.platform !== "darwin")
    throw new Error("License activation currently supports macOS only.");
  const { stdout } = await promisify(execFile)(
    "/usr/sbin/ioreg",
    ["-rd1", "-c", "IOPlatformExpertDevice"],
    { timeout: 5000 },
  );
  const uuid = /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/.exec(stdout)?.[1];
  if (!uuid)
    throw new Error("Could not read this Mac's stable hardware identity.");
  return createHash("sha256")
    .update(`device-deck:machine:v1:${uuid.toLowerCase()}`)
    .digest("hex");
}
export class LicenseManager implements EntitlementService {
  private activation?: Activation;
  private grant?: Grant;
  private fingerprint?: string;
  private message = "Free includes one device session and basic capture.";
  private state: LicenseStatus["state"] = "free";
  private highWater = Date.now();
  private bootWall = Date.now();
  private bootMono = performance.now();
  private serial = new SerialQueue();
  private timer?: ReturnType<typeof setInterval>;
  private nextRefresh = 0;
  private provider?: LicenseProvider;
  constructor(
    private directory: string,
    private trust: LicensingTrust | null = releaseTrust,
    provider?: LicenseProvider,
    private identify = macFingerprint,
    private now: () => number = Date.now,
  ) {
    this.provider = provider || (trust ? new KeygenProvider(trust) : undefined);
    this.bootWall = this.highWater = this.now();
  }
  private file() {
    return path.join(this.directory, "license.json");
  }
  private clock() {
    this.highWater = Math.max(
      this.highWater,
      this.now(),
      this.bootWall + performance.now() - this.bootMono,
    );
    return this.highWater;
  }
  async init() {
    if (!this.trust) {
      this.state = "unconfigured";
      this.message =
        "This review build has no provider configuration. Free is available; activation and checkout await setup.";
      return;
    }
    try {
      this.fingerprint = await this.identify();
      try {
        const data = stored.parse(
          JSON.parse(await readFile(this.file(), "utf8")),
        );
        this.highWater = Math.max(this.highWater, data.lastSeen);
        this.activation = data;
        this.grant = this.verify(data);
        this.state = "offline";
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          this.state = "invalid";
          this.message =
            "Saved license proof is invalid or expired. Refresh or activate again.";
        }
      }
      if (this.activation) await this.refresh();
      this.timer = setInterval(() => {
        if (this.activation && this.clock() >= this.nextRefresh)
          void this.refresh().catch(() => {});
      }, 60000);
      this.timer.unref();
    } catch (e) {
      this.message = (e as Error).message;
      this.state = "invalid";
    }
  }
  private verify(activation: Activation) {
    if (!this.trust || !this.fingerprint)
      throw new Error("Licensing is not configured on this Mac.");
    return verifyCertificate(
      activation.certificate,
      this.trust,
      { ...activation, fingerprint: this.fingerprint },
      this.clock(),
    );
  }
  status(): LicenseStatus {
    const valid = this.grant && this.grant.validUntil > this.clock();
    return {
      tier: valid ? this.grant!.tier : "free",
      state: this.grant && !valid ? "expired" : this.state,
      configured: Boolean(this.trust && this.fingerprint),
      fingerprint: this.fingerprint,
      message:
        this.grant && !valid
          ? "License access expired. Free remains available; stop, release and existing captures are preserved."
          : this.message,
      licenseId: this.activation?.licenseId,
      licenseExpiry: this.grant?.licenseExpiry,
      offlineUntil: this.grant?.validUntil,
      features: valid ? [...this.grant!.features] : [],
      maxSessions:
        valid && this.grant!.features.includes(FEATURES.concurrent) ? null : 1,
      checkoutUrl: this.trust?.checkoutUrl,
    };
  }
  private async save() {
    if (this.activation)
      await atomicWrite(
        this.file(),
        JSON.stringify({ ...this.activation, lastSeen: this.clock() }) + "\n",
      );
  }
  activate(key: string) {
    return this.serial.run(async () => {
      if (!this.provider || !this.fingerprint)
        throw new Error(
          "Provider setup is pending. This build cannot activate a license.",
        );
      const activation = await this.provider.activate(
        z.string().trim().min(1).max(4096).parse(key),
        this.fingerprint,
      );
      const grant = this.verify(activation);
      this.activation = activation;
      this.grant = grant;
      this.state = "active";
      this.message = "License verified by Keygen.";
      this.nextRefresh = this.clock() + 6 * 3600000;
      await this.save();
      return this.status();
    });
  }
  refresh() {
    return this.serial.run(async () => {
      if (!this.activation || !this.provider || !this.fingerprint)
        return this.status();
      this.nextRefresh = this.clock() + 5 * 60000;
      try {
        const activation = await this.provider.refresh(
          this.activation,
          this.fingerprint,
        );
        const grant = this.verify(activation);
        this.activation = activation;
        this.grant = grant;
        this.state = "active";
        this.message = "License verified by Keygen.";
        this.nextRefresh = this.clock() + 6 * 3600000;
        await this.save();
      } catch (e) {
        if (e instanceof ProviderUnavailable) {
          this.state = "offline";
          this.message = e.message;
        } else {
          this.grant = undefined;
          this.activation.certificate = "";
          this.state = "invalid";
          this.message =
            "Keygen did not validate this license. Free remains available.";
          await this.save();
        }
      }
      return this.status();
    });
  }
  deactivate() {
    return this.serial.run(async () => {
      // Retain the key/proof if the request fails so the user can retry remotely.
      if (this.activation && this.provider)
        await this.provider.deactivate(this.activation);
      await rm(this.file(), { force: true });
      this.activation = undefined;
      this.grant = undefined;
      this.state = this.trust ? "free" : "unconfigured";
      this.message = "License deactivated on this Mac. Free remains available.";
      return this.status();
    });
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
export { FEATURES } from "./trust";
