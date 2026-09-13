import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createService } from "./server";
import { DeckService } from "./local/service";
import { dataDirectory } from "../../../packages/core/src/local/paths";
import { atomicWrite } from "../../../packages/config/src";
import { root } from "../../../packages/adapters/src";
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
  try {
    await deck.init();
    const token = randomBytes(32).toString("base64url");
    const server = createService(deck, token, path.join(root, "build/web"));
    const port = Number(
      process.env.DEVICE_DECK_PORT ?? deck.config.config.port,
    );
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid DEVICE_DECK_PORT.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const address = server.address() as { port: number };
    await atomicWrite(
      path.join(directory, "endpoint.json"),
      JSON.stringify({
        port: address.port,
        token,
        pid: process.pid,
        startedAt: Date.now(),
      }),
    );
    console.error(
      `Device Deck is ready at http://127.0.0.1:${address.port}. Open with devdeck ui.`,
    );
    let stopping = false;
    shutdown = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await deck.close();
      server.closeAllConnections();
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
    await rm(lock, { recursive: true, force: true });
    throw e;
  }
}
