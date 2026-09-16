import { readFile } from "node:fs/promises";
import path from "node:path";
import { DeckError, type Operation } from "./local/types";
import { dataDirectory } from "./local/paths";
import { endpointSchema } from "./hub";
export async function endpoint() {
  return validateEndpoint(JSON.parse(
    await readFile(path.join(dataDirectory(), "endpoint.json"), "utf8"),
  ));
}
export function validateEndpoint(value: unknown) {
  const data = value as Record<string, unknown> | null;
  if (
    !data || typeof data !== "object" ||
    !Number.isInteger(data.port) ||
    Number(data.port) < 1 ||
    Number(data.port) > 65535 ||
    !Number.isSafeInteger(data.pid) || Number(data.pid) <= 1 ||
    typeof data.token !== "string" || !data.token.length
  )
    throw new Error("Invalid local endpoint file.");
  return { ...data, url: `http://127.0.0.1:${data.port}` } as {
    port: number;
    token: string;
    pid: number;
    url: string;
  };
}
export async function callOperation(
  operation: Operation,
  args: unknown = {},
  origin = "CLI",
) {
  const ep = await endpoint();
  const response = await fetch(`${ep.url}/v1/operations/${operation}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
      "X-Device-Deck-Client": origin,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(180000),
    redirect: "error",
  });
  const body = await response.json();
  if (!response.ok)
    throw new DeckError(
      body.error || "service-error",
      body.message || `Device Deck returned ${response.status}`,
      response.status,
      body.details,
    );
  return body;
}
export async function callService(route: "health" | "inventory") {
  if (route === "inventory") return callOperation("inventory");
  const ep = await endpoint();
  const res = await fetch(`${ep.url}/v1/health`, {
    headers: { Authorization: `Bearer ${ep.token}` },
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`Device Deck returned ${res.status}`);
  return res.json();
}
export async function browserUrl(query?: URLSearchParams, address?: string) {
  const ep = await endpoint();
  const origin = address ? endpointSchema.parse(address) : ep.url;
  const res = await fetch(`${ep.url}/v1/browser-ticket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(address ? { address: origin } : {}),
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.message || "Unable to open dashboard.");
  }
  const { ticket } = await res.json();
  return `${origin}/${query?.size ? `?${query}` : ""}#ticket=${ticket}`;
}
