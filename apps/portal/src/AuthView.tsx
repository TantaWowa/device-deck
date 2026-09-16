import React, { useState } from "react";
import { ArrowRight, Monitor, Radio, ShieldCheck } from "lucide-react";
import {
  createUserWithEmailAndPassword, GoogleAuthProvider, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, type Auth,
} from "firebase/auth";
import { authMessage } from "./firebase";

export function AuthView({ auth, setupError }: { auth?: Auth; setupError?: string }) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "reset") {
        await sendPasswordResetEmail(auth, email.trim());
        setNotice("If that email has an account, a password reset link is on its way.");
      } else if (mode === "signup") await createUserWithEmailAndPassword(auth, email.trim(), password);
      else await signInWithEmailAndPassword(auth, email.trim(), password);
      setPassword("");
    } catch (failure) { setError(authMessage(failure)); }
    finally { setBusy(false); }
  };
  const google = async () => {
    if (!auth || busy) return;
    setBusy(true); setError("");
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (failure) {
      if (typeof failure === "object" && failure && "code" in failure && failure.code === "auth/popup-blocked") {
        try { await signInWithRedirect(auth, new GoogleAuthProvider()); }
        catch (redirectFailure) { setError(authMessage(redirectFailure)); }
      } else setError(authMessage(failure));
    } finally { setBusy(false); }
  };
  const changeMode = (next: typeof mode) => { setMode(next); setError(""); setNotice(""); setPassword(""); };
  return <main className="auth-layout">
    <section className="auth-story">
      <a className="brand" href="/"><span className="brand-icon"><Monitor size={24} /></span>Device Deck<span className="brand-tag">CONNECT</span></a>
      <div className="auth-story-content">
        <span className="eyebrow">YOUR DEVICE LAB, WITHIN REACH</span>
        <h1>One place.<br />Every screen.</h1>
        <p>Bring your Device Deck machines together. See live feeds, take control, and keep your testing moving—from your desk or your phone.</p>
        <div className="auth-machine-art" aria-hidden="true">
          <div className="art-screen"><div className="art-horizon" /><span className="art-live"><i /> LIVE VIEW</span><span className="art-screen-caption">Your next great release.</span></div>
          <div className="art-remote"><span /><div className="art-dpad">●</div><small>● &nbsp; ● &nbsp; ●</small></div>
          <div className="art-status"><Radio size={18} /><span>Connected to your machines<small>Direct from this browser</small></span></div>
        </div>
      </div>
      <p className="auth-footnote"><ShieldCheck size={17} />Your live feeds stay between your browser and your machine.</p>
    </section>
    <section className="auth-entry">
      <div className="auth-card">
        <span className="eyebrow">DEVICE DECK ACCOUNT</span>
        <h2>{mode === "signup" ? "Make room for your machines." : mode === "reset" ? "Let's get you back in." : "Welcome back."}</h2>
        <p>{mode === "signup" ? "Create an account, then pair your first machine." : mode === "reset" ? "We'll email you a link to choose a new password." : "Sign in to pick up where you left off."}</p>
        {setupError && <div className="notice error" role="alert">{setupError}<button className="text-button" onClick={() => location.reload()}>Try again</button></div>}
        {!setupError && !auth && <div className="notice" role="status">Connecting to sign-in…</div>}
        {mode !== "reset" && <><button className="google-button" onClick={() => void google()} disabled={!auth || busy}><span className="google-g" aria-hidden="true">G</span>Continue with Google</button><div className="auth-divider"><span>or use your email</span></div></>}
        <form onSubmit={(event) => void submit(event)}>
          <label>Email address<input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={busy} /></label>
          {mode !== "reset" && <label>Password<input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={mode === "signup" ? 6 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : "Your password"} disabled={busy} /></label>}
          {mode === "login" && <button type="button" className="text-button forgot-password" onClick={() => changeMode("reset")}>Forgot password?</button>}
          {error && <p className="notice error" role="alert">{error}</p>}
          {notice && <p className="notice success" role="status">{notice}</p>}
          <button className="primary full-width" disabled={!auth || busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}<ArrowRight size={18} /></button>
        </form>
        <p className="auth-switch">{mode === "login" ? <>New to Device Deck? <button className="text-button" onClick={() => changeMode("signup")}>Create an account</button></> : <button className="text-button" onClick={() => changeMode("login")}>Back to sign in</button>}</p>
      </div>
      <footer>Connect over your local network or VPN.<br />Device Deck must be running on each machine.</footer>
    </section>
  </main>;
}
