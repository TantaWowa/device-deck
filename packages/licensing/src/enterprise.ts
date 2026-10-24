import { FEATURES } from "./trust";
import type { EntitlementService, LicenseStatus } from "./index";

export class UnlockedEnterpriseLicense implements EntitlementService {
  async init() {}
  status(): LicenseStatus {
    return {
      tier: "enterprise",
      state: "active",
      configured: true,
      licenseId: "enterprise-unlocked",
      message:
        "Monetization disabled. All features and unlimited concurrent device sessions are enabled.",
      features: Object.values(FEATURES),
      maxSessions: null,
    };
  }
  async activate(_key: string) {
    return this.status();
  }
  async refresh() {
    return this.status();
  }
  async deactivate() {
    return this.status();
  }
  close() {}
}
