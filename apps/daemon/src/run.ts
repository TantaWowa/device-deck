import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createBrowserCredentials, createService } from "./server";
import { hostWithPort, MachineAuthority } from "./network";
import { DeckService } from "./local/service";
import { dataDirectory } from "../../../packages/core/src/local/paths";
import { atomicWrite, expand } from "../../../packages/config/src";
import { root } from "../../../packages/adapters/src";
import { DeckConnections } from "./decks";
export async function runDaemon(
  licensing?: import("../../../packages/licensing/src").EntitlementService,
) {
  const directory = dataDirectory(),
    lock = path.join(directory, "daemon.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(
      await readFile(path.join(lock, "pid"), "utf8").catch(() => "0"),
    );
    if (!pid)
      throw new Error(
        "Another daemon is starting, or daemon.lock needs inspection.",
      );
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error(`Device Deck already runs as PID ${pid}.`);
    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
  }
  await atomicWrite(path.join(lock, "pid"), String(process.pid));
  const deck = new DeckService(
    directory,
    process.env.DEVICE_DECK_CONFIG,
    undefined,
    undefined,
    licensing,
  );
  let shutdown: (() => Promise<void>) | undefined;
  const servers: ReturnType<typeof createService>[] = [];
  try {
    await deck.init();
    console.error(deck.licensing.status().message);
    const token = randomBytes(32).toString("base64url");
    const network = deck.config.config.network;
    const bindHost = process.env.DEVICE_DECK_HOST || network?.host || "127.0.0.1";
    if (!/^[A-Za-z0-9_.:-]+$/.test(bindHost)) throw new Error("Invalid DEVICE_DECK_HOST.");
    const tls = network?.tls ? {
      cert: await readFile(expand(network.tls.cert, path.dirname(deck.config.file))),
      key: await readFile(expand(network.tls.key, path.dirname(deck.config.file))),
    } : undefined;
    const authority = new MachineAuthority(directory);
    await authority.init();
    const credentials = createBrowserCredentials();
    const decks = new DeckConnections(directory);
    const server = createService(deck, token, path.join(root, "build/web"), { bindHost, tls, authority, credentials, decks });
    servers.push(server);
    const port = Number(
      process.env.DEVICE_DECK_PORT ?? deck.config.config.port,
    );
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid DEVICE_DECK_PORT.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, bindHost, resolve);
    });
    const address = server.address() as { port: number };
    // Preserve a plain HTTP, loopback-only control path for CLI/MCP and key
    // management when the external listener uses TLS or a specific interface.
    let control = server;
    if (tls || !["127.0.0.1", "0.0.0.0"].includes(bindHost)) {
      control = createService(deck, token, path.join(root, "build/web"), { authority, credentials, decks, networkPort: address.port, bindHost });
      servers.push(control);
      await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(0, "127.0.0.1", resolve);
      });
    }
    const controlPort = (control.address() as { port: number }).port;
    await atomicWrite(
      path.join(directory, "endpoint.json"),
      JSON.stringify({
        port: controlPort,
        networkPort: address.port,
        networkHost: bindHost,
        networkProtocol: tls ? "https:" : "http:",
        token,
        pid: process.pid,
        startedAt: Date.now(),
      }),
    );
    console.error(
      `Device Deck is listening at ${tls ? "https" : "http"}://${hostWithPort(bindHost, address.port)}. Local dashboard: http://127.0.0.1:${controlPort}. Open with devdeck ui.`,
    );
    let stopping = false;
    shutdown = async () => {
      if (stopping) return;
      stopping = true;
      for (const listener of servers) listener.close();
      await deck.close();
      for (const listener of servers) listener.closeAllConnections();
      await rm(path.join(directory, "endpoint.json"), { force: true });
      await rm(lock, { recursive: true, force: true });
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        void shutdown!()
          .then(() => process.exit(0))
          .catch((e) => {
            console.error(e);
            process.exit(1);
          });
      });
  } catch (e) {
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    await deck.close().catch(() => {});
    await rm(lock, { recursive: true, force: true });
    throw e;
  }
}
