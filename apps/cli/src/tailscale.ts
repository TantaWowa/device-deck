import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callOperation, endpoint } from "../../../packages/core/src/client";
import { DeckError, tailscaleSchema, type Config } from "../../../packages/core/src/local/types";

const exec = promisify(execFile);
type Configuration = { config: Config; revision: string };
export type TailscaleDependencies = {
  run: (args: string[]) => Promise<string>;
  callOperation: typeof callOperation;
  endpoint: () => Promise<{ port: number }>;
};
const defaults: TailscaleDependencies = { run: runTailscale, callOperation, endpoint };

export async function runTailscale(args: string[]) {
  for (const executable of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const { stdout } = await exec(executable, args, {
        timeout: 20000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      });
      return stdout;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      if (failure.code === "ENOENT") continue;
      const detail = [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim().slice(-6000);
      throw new Error(`Tailscale ${failure.killed ? "timed out after 20 seconds" : "failed"}.${detail ? `\n${detail}` : ` ${failure.message}`}`);
    }
  }
  throw new Error("Tailscale CLI was not found. Install and sign in to Tailscale, then retry.");
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tailscale returned an invalid status object. Update Tailscale and retry.");
  return value as Record<string, any>;
}

async function readStatus(deps: TailscaleDependencies, serve = false) {
  const raw = await deps.run(serve ? ["serve", "status", "--json"] : ["status", "--json"]);
  try { return object(JSON.parse(raw)); }
  catch { throw new Error(`Tailscale returned invalid ${serve ? "Serve " : ""}status JSON. Update Tailscale and retry.`); }
}

function httpsPort(value?: string) {
  if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535))
    throw new DeckError("arguments", "Supply --https-port as a port between 1 and 65535.", 400);
  return Number(value || 443);
}

function nodeOrigin(status: Record<string, any>, port: number) {
  if (status.BackendState !== "Running")
    throw new Error("Tailscale is not connected. Sign in and connect Tailscale, then retry.");
  const name = status.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
  if (typeof name !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(name))
    throw new Error("Tailscale has no valid .ts.net hostname for this Mac. Enable MagicDNS and retry.");
  return `https://${name}${port === 443 ? "" : `:${port}`}`;
}

function endpointKey(origin: string) {
  const url = new URL(origin);
  return { port: Number(url.port || 443), key: `${url.hostname}:${url.port || 443}` };
}

type Mapping = { state: "absent" | "ready" | "conflict"; message?: string };
function inspectMapping(raw: Record<string, any>, origin: string, backend: string): Mapping {
  const { port, key } = endpointKey(origin);
  const atPort = (host: string) => host.endsWith(`:${port}`);
  for (const foreground of Object.values(object(raw.Foreground || {}))) {
    if (inspectMapping(object(foreground), origin, backend).state !== "absent")
      return { state: "conflict", message: `Tailscale port ${port} belongs to a foreground Serve session.` };
  }
  if (Object.entries(object(raw.AllowFunnel || {})).some(([host, enabled]) => atPort(host) && enabled))
    return { state: "conflict", message: `Tailscale Funnel is enabled on port ${port}. Disable Funnel on that endpoint before enabling Device Deck.` };
  const tcp = object(raw.TCP || {})[port];
  const web = Object.entries(object(raw.Web || {})).filter(([host]) => atPort(host));
  if (!tcp && !web.length) return { state: "absent" };
  const handlers = web.length === 1 && web[0][0] === key ? object(web[0][1]).Handlers : undefined;
  const proxy = handlers && object(handlers)["/"];
  const validTcp = tcp && object(tcp).HTTPS === true && Object.entries(tcp).every(([name, value]) => name === "HTTPS" || value === false || value === "" || value === 0);
  const validProxy = proxy && Object.keys(object(proxy)).length === 1 && typeof proxy.Proxy === "string" && proxy.Proxy.replace(/\/$/, "") === backend;
  if (validTcp && handlers && Object.keys(handlers).length === 1 && validProxy)
    return { state: "ready" };
  return { state: "conflict", message: `Tailscale port ${port} has another mapping or a stale Device Deck backend. Expected only / → ${backend}. Inspect tailscale serve status and remove that specific old route yourself, or choose an unused --https-port. Other Serve routes will not be changed.` };
}

const disableArgs = (port: number) => ["serve", "--bg", "--yes", `--https=${port}`, "off"];

export async function tailscaleCommand(
  action: string,
  options: { allowUser?: string; httpsPort?: string } = {},
  deps: TailscaleDependencies = defaults,
) {
  if (!["enable", "status", "disable"].includes(action))
    throw new DeckError("arguments", "Use tailscale enable, status or disable.", 400);
  if (action !== "enable" && (options.allowUser !== undefined || options.httpsPort !== undefined))
    throw new DeckError("arguments", "--allow-user and --https-port apply only to tailscale enable.", 400);
  const current: Configuration = await deps.callOperation("config.get");
  const saved = current.config.tailscale;
  if (action === "disable") {
    if (!saved) return { enabled: false, healthy: false, message: "Tailscale access is already disabled." };
    const config = { ...current.config };
    delete config.tailscale;
    // Revoke access before trying to change Serve, including when Tailscale is unavailable.
    await deps.callOperation("config.save", { config, revision: current.revision });
    try {
      const { port } = endpointKey(saved.origin);
      const ep = await deps.endpoint();
      if (nodeOrigin(await readStatus(deps), port) !== saved.origin)
        throw new Error("The configured hostname no longer belongs to this Mac; its Serve mapping was left unchanged.");
      const mapping = inspectMapping(await readStatus(deps, true), saved.origin, `http://127.0.0.1:${ep.port}`);
      if (mapping.state === "conflict") throw new Error(mapping.message);
      if (mapping.state === "ready") {
        await deps.run(disableArgs(port));
        if (inspectMapping(await readStatus(deps, true), saved.origin, `http://127.0.0.1:${ep.port}`).state !== "absent")
          throw new Error("The Serve mapping still exists. Inspect tailscale serve status.");
      }
      return { enabled: false, healthy: false, message: "Tailscale access disabled." };
    } catch (error) {
      throw new Error(`Device Deck access is disabled, but Serve cleanup could not be completed. ${(error as Error).message}`);
    }
  }
  if (action === "status") {
    if (!saved) return { enabled: false, healthy: false, message: "Tailscale access is disabled. Run devdeck tailscale enable." };
    try {
      const ep = await deps.endpoint();
      const { port } = endpointKey(saved.origin);
      if (nodeOrigin(await readStatus(deps), port) !== saved.origin)
        throw new Error("The configured Tailscale hostname no longer belongs to this Mac.");
      const mapping = inspectMapping(await readStatus(deps, true), saved.origin, `http://127.0.0.1:${ep.port}`);
      return { enabled: true, healthy: mapping.state === "ready", url: `${saved.origin}/`, allowedUsers: saved.allowedUsers, message: mapping.state === "ready" ? "Tailscale Serve is ready." : mapping.message || "The Serve mapping is missing. Run devdeck tailscale enable." };
    } catch (error) {
      return { enabled: true, healthy: false, url: `${saved.origin}/`, allowedUsers: saved.allowedUsers, message: (error as Error).message };
    }
  }
  const port = httpsPort(options.httpsPort ?? (saved ? String(endpointKey(saved.origin).port) : undefined));
  const status = await readStatus(deps);
  const origin = nodeOrigin(status, port);
  if (saved && saved.origin !== origin)
    throw new Error("Device Deck is configured for another Tailscale endpoint. Run devdeck tailscale disable before changing its hostname or HTTPS port.");
  const owner = status.Self?.Tags?.length ? undefined : status.User?.[String(status.Self?.UserID)]?.LoginName;
  const allowedUsers = options.allowUser !== undefined ? options.allowUser.split(",").map((user) => user.trim()) : saved?.allowedUsers || (typeof owner === "string" ? [owner] : []);
  if (!allowedUsers.length)
    throw new DeckError("arguments", "Supply --allow-user with one or more unique Tailscale login names separated by commas. Tagged devices require an explicit allowed user.", 400);
  const access = tailscaleSchema.safeParse({ origin, allowedUsers });
  if (!access.success)
    throw new DeckError("arguments", `Invalid Tailscale access settings: ${access.error.issues.map((issue) => issue.message).join("; ")}`, 400);
  const ep = await deps.endpoint();
  const backend = `http://127.0.0.1:${ep.port}`;
  const before = inspectMapping(await readStatus(deps, true), origin, backend);
  if (before.state === "conflict") throw new Error(before.message);
  try {
    if (before.state === "absent")
      await deps.run(["serve", "--bg", "--yes", `--https=${port}`, backend]);
    const after = inspectMapping(await readStatus(deps, true), origin, backend);
    if (after.state !== "ready")
      throw new Error(after.message || "Tailscale did not create the expected HTTPS Serve mapping.");
    if (!saved || JSON.stringify(saved.allowedUsers) !== JSON.stringify(allowedUsers))
      await deps.callOperation("config.save", { config: { ...current.config, tailscale: access.data }, revision: current.revision });
  } catch (error) {
    // Never remove pre-existing routes, and recheck ownership after an uncertain result.
    let cleanup = "";
    if (before.state === "absent") {
      try {
        const state = inspectMapping(await readStatus(deps, true), origin, backend);
        if (state.state === "ready") await deps.run(disableArgs(port));
        else if (state.state === "conflict") cleanup = " Serve changed during setup and was left unchanged; inspect tailscale serve status.";
      } catch { cleanup = " Serve cleanup could not be verified; inspect tailscale serve status."; }
    }
    throw new Error(`Unable to enable Device Deck through Tailscale. ${(error as Error).message}${cleanup}`);
  }
  return { enabled: true, healthy: true, url: `${origin}/`, allowedUsers, message: "Open this URL from another device connected to your tailnet." };
}

export async function tailscaleBrowserUrl(deps: Pick<TailscaleDependencies, "callOperation"> = defaults) {
  const current: Configuration = await deps.callOperation("config.get");
  if (!current.config.tailscale)
    throw new Error("Tailscale access is disabled. Run devdeck tailscale enable first.");
  return `${current.config.tailscale.origin}/`;
}
