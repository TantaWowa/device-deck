import type { Operation } from "../../../../packages/core/src/local/types";
export async function api<T = any>(operation: Operation, args: unknown = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/v1/operations/${operation}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Device-Deck": "local" },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message || `Service returned ${response.status}`);
  return body;
}
let interruptedTicket: string | null = null;
export async function bootstrap(signal?: AbortSignal) {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket") || interruptedTicket;
  if (ticket) {
    interruptedTicket = ticket;
    history.replaceState(null, "", location.pathname + location.search);
    const r = await fetch("/v1/bootstrap", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    interruptedTicket = null;
    if (!r.ok)
      throw new Error("This launch link expired. Run devdeck ui again.");
  }
}
