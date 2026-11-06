import { FEATURES } from "./trust";
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
export interface EntitlementService {
  init(): Promise<void>;
  status(): LicenseStatus;
  activate(key: string): Promise<LicenseStatus>;
  refresh(): Promise<LicenseStatus>;
  deactivate(): Promise<LicenseStatus>;
  close(): void;
}
// Compatibility API for older clients. No keys, provider calls or paid tiers.
export class LicenseManager implements EntitlementService {
  constructor(..._legacyArguments: unknown[]) {}
  async init() {}
  status(): LicenseStatus {
    return { tier: "free", state: "active", configured: true,
      message: "Device Deck is free and open source. All features are enabled.",
      features: Object.values(FEATURES), maxSessions: null };
  }
  async activate(_key: string) { return this.status(); }
  async refresh() { return this.status(); }
  async deactivate() { return this.status(); }
  close() {}
}
export { FEATURES } from "./trust";
