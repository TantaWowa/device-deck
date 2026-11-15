import { readFile } from "node:fs/promises";
import path from "node:path";
import { serviceRequest, validateEndpoint } from "../../../packages/core/src/client";
import { readAccountEndpoint, readSharedHost } from "../../../packages/core/src/shared-host";
import { localMacUsers } from "../../daemon/src/local-accounts";
import { DeckError } from "../../../packages/core/src/local/types";

export async function sharingCommand(action: string, account?: string) {
  if (action === "users") return { users: await localMacUsers() };
  const host = await readSharedHost();
  if (!host) {
    if (action === "status") return { configured: false, enabled: false, isHost: false, authorized: false };
    throw new DeckError("sharing-disabled", "Enable the shared Mac service in Device Deck setup first.", 409);
  }
  const isHost = host.uid === process.getuid!();
  let ep: ReturnType<typeof validateEndpoint>;
  try {
    ep = validateEndpoint(isHost
      ? JSON.parse(await readFile(path.join(host.profile, "endpoint.json"), "utf8"))
      : await readAccountEndpoint(host));
  } catch (error) {
    if (action === "status") return { configured: true, enabled: true, host, isHost, authorized: isHost, running: false, message: (error as Error).message, grants: [] };
    throw error;
  }
  if (!isHost && action !== "status") throw new DeckError("host-account-required", `Manage Mac access while signed in as ${host.username}.`, 403);
  if (!["status", "grant", "revoke"].includes(action)) throw new DeckError("arguments", "Use sharing status, users, grant USER or revoke UID.", 400);
  const route = action === "status" ? (isHost ? "/v1/local-accounts/list" : "/v1/health") : `/v1/local-accounts/${action}`;
  const value = action === "grant" ? { username: account } : action === "revoke" ? { uid: Number(account) } : {};
  try {
    const response = await fetch(ep.url + route, {
      method: action === "status" && !isHost ? "GET" : "POST",
      headers: { Authorization: `Bearer ${ep.token}`, "Content-Type": "application/json", "X-Device-Deck": "local" },
      ...(action === "status" && !isHost ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
    const result = await response.json();
    if (!response.ok) throw new DeckError(result.error, result.message, response.status);
    return action === "status" ? { ...result, configured: true, enabled: true, host, isHost, authorized: true, running: true } : result;
  } catch (error) {
    if (action === "status") return { configured: true, enabled: true, host, isHost, authorized: isHost, running: false, message: (error as Error).message, grants: [] };
    throw error;
  }
}

export async function serviceMaintenanceCommand(action: "prepare-update" | "cancel-update") {
  const response = await serviceRequest(`/v1/service/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) }, "local");
  const result = await response.json();
  if (!response.ok) throw new DeckError(result.error, result.message, response.status);
  return result;
}
