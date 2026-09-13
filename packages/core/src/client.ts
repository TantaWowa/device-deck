import { readFile } from "node:fs/promises";
import path from "node:path";
import { DeckError, type Operation } from "./local/types";
import { dataDirectory } from "./local/paths";
export async function endpoint() {
  const data = JSON.parse(
    await readFile(path.join(dataDirectory(), "endpoint.json"), "utf8"),
  );
  if (
    !Number.isInteger(data.port) ||
    data.port < 1 ||
    data.port > 65535 ||
    typeof data.token !== "string"
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
export async function browserUrl(query?: URLSearchParams) {
  const ep = await endpoint();
  const res = await fetch(`${ep.url}/v1/browser-ticket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    redirect: "error",
  });
  if (!res.ok) throw new Error("Unable to open local dashboard.");
  const { ticket } = await res.json();
  return `${ep.url}/${query?.size ? `?${query}` : ""}#ticket=${ticket}`;
}
