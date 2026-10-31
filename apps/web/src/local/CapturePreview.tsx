import React, { useCallback } from "react";
import { api, serviceUrl } from "./api";
import { LivePreview } from "./LivePreview";

/** Local preview adapter. Video is continuous; snapshots are an explicit fallback. */
export function CapturePreview({ name, endpoint, active = true }: {
  name: string;
  endpoint: string;
  active?: boolean;
  /** Retained for older callers; live video does not poll on a timer. */
  intervalMs?: number;
}) {
  const sourceId = endpoint.startsWith("/v1/source-preview/") ? decodeURIComponent(endpoint.slice("/v1/source-preview/".length)) : undefined;
  const deviceId = endpoint.startsWith("/v1/preview/") ? decodeURIComponent(endpoint.slice("/v1/preview/".length)) : undefined;
  const getSnapshot = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(serviceUrl(endpoint), { signal, cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.message || `Snapshot returned ${response.status}.`);
    }
    return response.blob();
  }, [endpoint]);
  return <LivePreview key={deviceId || sourceId} name={name} deviceId={deviceId} sourceId={sourceId} operation={api} getSnapshot={getSnapshot} active={active} />;
}
