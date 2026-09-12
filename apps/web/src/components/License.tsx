import { useState } from "react";
import type { LicenseStatus } from "../../../../packages/licensing/src";
import "./workspace.css";
const date = (time?: number) =>
  time ? new Date(time).toLocaleString() : "Not active";
export function License({
  status,
  act,
}: {
  status: LicenseStatus;
  act: (
    action: "activate" | "refresh" | "deactivate",
    key?: string,
  ) => Promise<unknown>;
}) {
  const [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (action: "activate" | "refresh" | "deactivate") => {
    setBusy(true);
    setError("");
    try {
      await act(action, key);
      setKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="license-page">
      <div className="workspace-heading">
        <div>
          <h1>License & Upgrade</h1>
          <p>
            One license for this Mac, across the browser, terminal and agents.
          </p>
        </div>
        <strong className="license-tier">
          {status.tier === "trial"
            ? "Pro trial"
            : status.tier === "pro"
              ? "Pro"
              : "Free"}
        </strong>
      </div>
      <p className="license-message" role="status">
        {status.message}
      </p>
      <div className="license-plans">
        <article>
          <h2>Free</h2>
          <p>
            Inventory, remote input and basic capture with one active device
            session.
          </p>
          <p>
            Keep using reports and reading or exporting your existing captures.
          </p>
        </article>
        <article>
          <h2>Pro</h2>
          <p>
            Concurrent device sessions and recording annotations through every
            interface.
          </p>
          <p>A trial uses a time-limited license issued by Device Deck.</p>
          {status.checkoutUrl ? (
            <a
              className="license-checkout"
              href={status.checkoutUrl}
              target="_blank"
              rel="noreferrer"
            >
              Upgrade with Lemon Squeezy ↗
            </a>
          ) : (
            <span>Checkout setup is pending.</span>
          )}
        </article>
      </div>
      <div className="license-details">
        <h2>Activate a license</h2>
        <p>
          Paste your purchased, trial or complimentary license key. All use the
          same verification.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("activate");
          }}
        >
          <label>
            License key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={busy || !status.configured}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !status.configured || !key.trim()}
            type="submit"
          >
            Activate on this Mac
          </button>
        </form>
        {error && (
          <p role="alert" className="workspace-error">
            {error}
          </p>
        )}
        <dl>
          <dt>License</dt>
          <dd>{status.licenseId || "No license activated"}</dd>
          <dt>License expires</dt>
          <dd>{date(status.licenseExpiry)}</dd>
          <dt>Offline access ends</dt>
          <dd>{date(status.offlineUntil)}</dd>
          <dt>Machine fingerprint</dt>
          <dd>
            <code>
              {status.fingerprint || "Available after provider setup"}
            </code>
          </dd>
        </dl>
        <div className="license-actions">
          <button
            disabled={busy || !status.licenseId}
            onClick={() => void run("refresh")}
          >
            Refresh license
          </button>
          <button
            disabled={busy || !status.licenseId}
            onClick={() => void run("deactivate")}
          >
            Deactivate this Mac
          </button>
        </div>
        <p>
          Deactivation or expiry returns to Free. Existing work keeps its
          current lease. New concurrent sessions and recording annotations
          require Pro; your saved captures remain available.
        </p>
      </div>
    </section>
  );
}
export function LicenseReminder({
  status,
  open,
}: {
  status: LicenseStatus;
  open: () => void;
}) {
  const [hidden, setHidden] = useState(() => {
    try {
      return (
        Number(localStorage.getItem("deck-upgrade-reminder-after") || 0) >
        Date.now()
      );
    } catch {
      return false;
    }
  });
  if (hidden || status.tier !== "free") return null;
  return (
    <aside className="license-reminder">
      <span>
        Using Free · one active device session. Pro adds concurrency and
        recording annotations.
      </span>
      <button onClick={open}>View license</button>
      <button
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(
              "deck-upgrade-reminder-after",
              String(Date.now() + 7 * 86400000),
            );
          } catch {}
        }}
      >
        Dismiss for a week
      </button>
    </aside>
  );
}
