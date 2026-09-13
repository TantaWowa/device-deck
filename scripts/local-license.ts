// Development entry point only; never imported by the release daemon or bundles.
import {
  FEATURES,
  type EntitlementService,
  type LicenseStatus,
} from "../packages/licensing/src";

export class LocalDevelopmentLicense implements EntitlementService {
  private active = true;
  async init() {}
  status(): LicenseStatus {
    return {
      tier: this.active ? "pro" : "free",
      state: this.active ? "active" : "free",
      configured: true,
      licenseId: "local-development-mock",
      message:
        "Local development activation mock. No Keygen or Lemon Squeezy account is contacted.",
      features: this.active ? Object.values(FEATURES) : [],
      maxSessions: this.active ? null : 1,
    };
  }
  async activate(_key: string) {
    this.active = true;
    return this.status();
  }
  async refresh() {
    return this.status();
  }
  async deactivate() {
    this.active = false;
    return this.status();
  }
  close() {}
}
