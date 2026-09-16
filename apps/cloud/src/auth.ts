import type { Auth } from "firebase-admin/auth";
import { CloudError } from "./errors";

export interface CloudAuthenticator { authenticate(token: string): Promise<{ uid: string }>; }

export class FirebaseAuthenticator implements CloudAuthenticator {
  constructor(private readonly auth: Pick<Auth, "verifyIdToken">) {}

  async authenticate(token: string) {
    try {
      // true additionally checks token revocation and disabled users against Firebase Auth.
      const identity = await this.auth.verifyIdToken(token, true);
      if (!identity.uid || identity.uid.includes("/") || identity.uid.length > 128) throw new Error("Invalid user ID.");
      return { uid: identity.uid };
    } catch {
      throw new CloudError(401, "Sign in again to continue.");
    }
  }
}
