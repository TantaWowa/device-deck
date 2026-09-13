import type { Operation } from "../../../../packages/core/src/local/types";
export async function api(operation: Operation, args: unknown = {}) {
  const response = await fetch(`/v1/operations/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Deck": "local" },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message || `Service returned ${response.status}`);
  return body;
}
export async function bootstrap() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (ticket) {
    history.replaceState(null, "", location.pathname + location.search);
    const r = await fetch("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (!r.ok)
      throw new Error("This launch link expired. Run devdeck ui again.");
  }
}
