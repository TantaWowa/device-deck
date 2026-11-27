import { Agent } from "undici";

// Fetch normally stops waiting for response headers after five minutes.
// Maintenance operations have their own absolute deadline, including the response body.
const longRequests = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function requestDeadline(timeoutMs: number, parent?: AbortSignal | null) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return {
    signal: parent ? AbortSignal.any([deadline, parent]) : deadline,
    ...(timeoutMs >= 300_000 ? { dispatcher: longRequests } : {}),
  };
}
