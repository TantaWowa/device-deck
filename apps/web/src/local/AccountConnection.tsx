import { useEffect, useState } from "react";
import { ExternalLink, Link2, RefreshCw } from "lucide-react";
import { machinePairingStatusSchema, type MachinePairingStatus } from "../../../../packages/core/src/hub";
import "./account-connection.css";

/** Status comes from the machine's actual account binding, including over Tailscale. */
export function AccountConnection() {
  const [status, setStatus] = useState<MachinePairingStatus>();
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      setRefreshing(true);
      try {
        const response = await fetch("/v1/hub/status", {
          cache: "no-store", signal: AbortSignal.any([current.signal, AbortSignal.timeout(8000)]),
        });
        if (!response.ok) throw new Error("Account status unavailable");
        const next = machinePairingStatusSchema.parse(await response.json());
        if (!current.signal.aborted) { setStatus(next); setError(false); }
      } catch {
        if (!current.signal.aborted) { setStatus(undefined); setError(true); }
      } finally { if (!current.signal.aborted) setRefreshing(false); }
    };
    const foreground = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = window.setInterval(foreground, 30_000);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [revision]);
  return <div className="account-connection" role="region" aria-label="Parent account">
    <Link2 size={16} aria-hidden="true" />
    <span role="status">{status?.paired ? "Paired to parent account" : status ? "Not paired to an account" : error ? "Account status unavailable" : "Checking account pairing…"}</span>
    {status?.paired && <a href={status.accountUrl} target="_blank" rel="noopener noreferrer">Open account<ExternalLink size={13} aria-hidden="true" /></a>}
    <button type="button" aria-label="Refresh account status" title="Refresh account status" disabled={refreshing} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
  </div>;
}
