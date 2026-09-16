import path from "node:path";
import { callOperation, endpoint } from "../../../packages/core/src/client";
import { endpointSchema } from "../../../packages/core/src/hub";
import { DeckError, networkSchema, type Config } from "../../../packages/core/src/local/types";

export type NetworkOptions = { host?: string; port?: string; allowHost?: string; allowOrigin?: string; portal?: string; cert?: string; key?: string };
type Dependencies = { callOperation: typeof callOperation; endpoint: typeof endpoint; request: typeof fetch };
const defaults: Dependencies = { callOperation, endpoint, request: fetch };
const entries = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean);

export async function networkCommand(action: string, options: NetworkOptions = {}, deps: Dependencies = defaults) {
  if (!["enable", "disable", "status"].includes(action)) throw new DeckError("arguments", "Use network enable, disable or status.");
  if (action !== "enable" && Object.values(options).some((value) => value !== undefined))
    throw new DeckError("arguments", "Network settings apply only to network enable.");
  const current: { config: Config; revision: string } = await deps.callOperation("config.get");
  if (action === "status") {
    const live = await deps.endpoint();
    return { network: current.config.network || null, configuredPort: current.config.port, localUrl: live.url, message: "Network binding and TLS changes take effect after restarting Device Deck." };
  }
  const config = structuredClone(current.config);
  if (action === "disable") {
    delete config.network;
  } else {
    if ((options.cert === undefined) !== (options.key === undefined))
      throw new DeckError("arguments", "Supply both --cert and --key for HTTPS.");
    const port = Number(options.port ?? (config.port || 47831));
    if ((options.port !== undefined && !/^\d+$/.test(options.port)) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new DeckError("arguments", "Supply --port as an integer from 1 to 65535.");
    config.port = port;
    config.network = networkSchema.parse({
      ...config.network,
      host: options.host ?? config.network?.host ?? "0.0.0.0",
      allowedHosts: entries(options.allowHost) ?? config.network?.allowedHosts ?? [],
      allowedOrigins: entries(options.allowOrigin)?.map((value) => endpointSchema.parse(value)) ?? config.network?.allowedOrigins ?? [],
      ...(options.portal !== undefined ? { hubOrigin: endpointSchema.parse(options.portal) } : {}),
      ...(options.cert !== undefined ? { tls: { cert: path.resolve(options.cert), key: path.resolve(options.key!) } } : {}),
    });
  }
  await deps.callOperation("config.save", { config, revision: current.revision });
  return {
    enabled: Boolean(config.network), network: config.network || null, port: config.port, restartRequired: true,
    message: "Saved. Finish active sessions, then run devdeck stop and devdeck start to apply the listening address, port or TLS changes.",
  };
}

export async function pairCommand(revoke = false, deps: Pick<Dependencies, "endpoint" | "request"> = defaults) {
  const ep = await deps.endpoint();
  const response = await deps.request(`${ep.url}/v1/hub/${revoke ? "unpair" : "pairing-code"}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${ep.token}`, "Content-Type": "application/json" }, body: "{}",
  });
  const body = await response.json();
  if (!response.ok) throw new DeckError(body.error || "pairing-failed", body.message || "Could not configure machine pairing.", response.status);
  return body;
}
