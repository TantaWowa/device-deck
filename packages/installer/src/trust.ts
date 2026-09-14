import { releaseTrust } from "../../licensing/src/trust";
import distribution from "../../../config/releases/distribution.json";
export type InstallerTrust = {
  accountId: string;
  productId: string;
  metadataPublicKey: string;
};
// Reviewed release signing key and Keygen identities belong in compiled code.
// No environment, local JSON, CLI flag or download supplies a trust anchor.
export const installerTrust: InstallerTrust = {
  accountId: releaseTrust.accountId,
  productId: releaseTrust.productId,
  metadataPublicKey: distribution.publicKey,
};
