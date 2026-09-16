import { initializeApp, type FirebaseOptions } from "firebase/app";
import { browserSessionPersistence, connectAuthEmulator, getAuth, getRedirectResult, setPersistence } from "firebase/auth";

export async function initializePortalAuth() {
  const key = "device-deck-public-firebase-config";
  let config: FirebaseOptions & { portalOrigin?: string; authEmulatorUrl?: string };
  try {
    const response = await fetch("/app/firebase-config.json", { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Account sign-in is not configured yet. The portal needs its Firebase web configuration.");
    config = await response.json();
    if (config.apiKey && config.authDomain && config.projectId && config.appId) {
      try { localStorage.setItem(key, JSON.stringify(config)); } catch { /* Public configuration cache is optional. */ }
    }
  } catch (failure) {
    let saved: string | null = null;
    try { saved = localStorage.getItem(key); } catch {}
    if (!saved) throw failure;
    config = JSON.parse(saved);
  }
  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId)
    throw new Error("Account sign-in configuration is incomplete.");
  if (config.portalOrigin && config.portalOrigin !== location.origin) {
    const canonical = new URL(config.portalOrigin);
    if (canonical.protocol !== "https:" || canonical.origin !== config.portalOrigin ||
      ![`${config.projectId}.firebaseapp.com`, `${config.projectId}.web.app`].includes(canonical.hostname))
      throw new Error("The portal's canonical sign-in address is invalid.");
    location.replace(`${canonical.origin}${location.pathname.startsWith("/app/") ? location.pathname : "/app/"}${location.search}${location.hash}`);
    throw new Error("Opening the sign-in address…");
  }
  const app = initializeApp(config);
  const auth = getAuth(app);
  if (config.authEmulatorUrl) {
    const emulator = new URL(config.authEmulatorUrl);
    if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(emulator.hostname) || emulator.protocol !== "http:" ||
      emulator.username || emulator.password || emulator.search || emulator.hash || emulator.pathname !== "/")
      throw new Error("Authentication emulator is only available in local development.");
    connectAuthEmulator(auth, emulator.origin, { disableWarnings: true });
  }
  await setPersistence(auth, browserSessionPersistence);
  await getRedirectResult(auth);
  return auth;
}

export function authMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    "auth/invalid-credential": "The email or password was not recognised.",
    "auth/email-already-in-use": "An account already uses this email. Sign in or reset your password.",
    "auth/weak-password": "Choose a password with at least six characters.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/popup-closed-by-user": "The sign-in window was closed. Try again when you're ready.",
    "auth/cancelled-popup-request": "Finish sign-in in the open window.",
    "auth/unauthorized-domain": "This portal address is not enabled for sign-in yet.",
    "auth/operation-not-allowed": "This sign-in method has not been enabled yet.",
    "auth/network-request-failed": "Sign-in could not connect. Check your internet connection.",
    "auth/too-many-requests": "Too many attempts. Wait a moment before trying again.",
  };
  return messages[code] || (error instanceof Error ? error.message : "Sign-in could not be completed.");
}
