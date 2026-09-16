import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { FirebaseAuthenticator } from "./auth";
import { FirestoreMachineStore } from "./firestore-store";
import { cloudServer } from "./http";
import { canonicalEndpoint, CloudService } from "./service";
import { createPortalSigner } from "./signing";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured before starting the portal backend.`);
  return value;
}

async function main() {
  if (process.env.NODE_ENV !== "development" && (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST))
    throw new Error("Firebase emulators are allowed only with explicit NODE_ENV=development.");
  const portalOrigin = canonicalEndpoint(required("PORTAL_ORIGIN"));
  const localDevelopment = process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(portalOrigin).hostname);
  if (!portalOrigin.startsWith("https://") && !localDevelopment) throw new Error("PORTAL_ORIGIN must use HTTPS outside localhost development.");
  const port = Number(process.env.PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535.");
  let privateKey: unknown;
  try { privateKey = JSON.parse(required("PORTAL_SIGNING_KEY_JSON")); }
  catch { throw new Error("PORTAL_SIGNING_KEY_JSON must contain a private Ed25519 JWK."); }
  const signer = await createPortalSigner(portalOrigin, privateKey);
  const app = initializeApp({ projectId: required("FIREBASE_PROJECT_ID"), credential: applicationDefault() });
  const service = new CloudService(new FirestoreMachineStore(getFirestore(app)), signer);
  const server = cloudServer({
    service, auth: new FirebaseAuthenticator(getAuth(app)), portalOrigin,
    onError: (error) => console.error("Portal API request failed:", error instanceof Error ? error.name : "Unknown error"),
  });
  server.listen(port, "0.0.0.0", () => console.log(`Device Deck cloud API listening on port ${port}. Portal: ${portalOrigin}`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Cloud startup failed."); process.exitCode = 1; });
