import configured from "../../../config/releases/keygen.json";
declare const __DEVICE_DECK_RELEASE_MODE__: "live" | "test";
export const releaseMode = typeof __DEVICE_DECK_RELEASE_MODE__ === "undefined" ? "live" : __DEVICE_DECK_RELEASE_MODE__;
export type LicensingTrust = {
  mode: "test" | "live";
  accountId: string;
  productId: string;
  publicKey: string;
  proPolicyId: string;
  trialPolicyId?: string;
  checkoutUrl?: string;
};
// Reviewed public configuration is compiled into the release. Runtime config,
// environment variables and downloaded files cannot change these trust anchors.
export const releaseTrust: LicensingTrust = { ...configured[releaseMode], mode: releaseMode };
export const OFFLINE_SECONDS = 24 * 60 * 60;
export const FEATURES = {
  concurrent: "DEVICE_DECK_CONCURRENT_SESSIONS",
  annotations: "DEVICE_DECK_RECORDING_ANNOTATIONS",
} as const;
