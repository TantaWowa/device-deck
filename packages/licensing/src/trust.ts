export type LicensingTrust = {
  mode: "test" | "live";
  accountId: string;
  productId: string;
  publicKey: string;
  proPolicyId: string;
  trialPolicyId?: string;
  checkoutUrl?: string;
};
// Release-owned public trust anchors. Set through a reviewed source change after
// provisioning Device Deck's own product. Never read these from user config/env.
// An unconfigured build runs Free; it cannot activate any paid or trial license.
export const releaseTrust: LicensingTrust | null = null;
export const OFFLINE_SECONDS = 24 * 60 * 60;
export const FEATURES = {
  concurrent: "DEVICE_DECK_CONCURRENT_SESSIONS",
  annotations: "DEVICE_DECK_RECORDING_ANNOTATIONS",
} as const;
