import { useCallback, useEffect, useRef } from "react";
import { InventoryPolling } from "./inventory-polling";

/** Visible/online inventory only. A resumed page performs one read, with no backlog. */
export function useInventoryPolling(read: (signal: AbortSignal, manual: boolean) => Promise<void>, {
  enabled = true, intervalMs, identity,
}: { enabled?: boolean; intervalMs: number; identity?: unknown }) {
  const latest = useRef({ read, intervalMs });
  latest.current = { read, intervalMs };
  const owner = useRef<InventoryPolling | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const demanded = () => !document.hidden && navigator.onLine;
    const polling = new InventoryPolling((signal, manual) => latest.current.read(signal, manual), demanded, () => latest.current.intervalMs);
    owner.current = polling;
    const changed = () => { if (demanded()) void polling.refresh(); else polling.pause(); };
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    changed();
    return () => {
      polling.dispose();
      if (owner.current === polling) owner.current = null;
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, [enabled, identity]);
  return useCallback((manual = false) => owner.current?.refresh(manual) ?? Promise.resolve(), []);
}
