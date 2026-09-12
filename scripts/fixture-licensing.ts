// Isolated test harness: real entitlement manager, inert device adapters.
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters, root } from "../packages/adapters/src";
import { CaptureEngine } from "../packages/capture/src";
import type {
  DeviceConfig,
  Device,
  SourceConfig,
} from "../packages/core/src/local/types";
const directory = path.resolve("work/licensing-fixture");
await mkdir(directory, { recursive: true });
class InertAdapters extends Adapters {
  async diagnostics() {
    return [];
  }
  async inspect(d: DeviceConfig): Promise<Device> {
    return {
      ...d,
      online: true,
      locked: false,
      healthDetail: "Licensing test fixture",
      capabilities: ["key"],
    };
  }
  async inspectSources(sources: SourceConfig[]) {
    return sources.map((s) => ({ ...s, status: "connected" as const }));
  }
  async input() {}
}
class InertCapture extends CaptureEngine {
  async closeSource() {}
  async close() {}
  async preview(): Promise<Buffer> {
    throw new Error("No physical frames in this fixture");
  }
}
let deck: DeckService;
const adapters = new InertAdapters(() => deck.config.config);
deck = new DeckService(
  directory,
  undefined,
  adapters,
  new InertCapture(adapters),
);
await deck.init();
if (!deck.config.config.devices.length) {
  const config = structuredClone(deck.config.config);
  config.settings.folder = path.join(directory, "captures");
  for (const id of ["one", "two"]) {
    config.devices.push({
      id,
      name: `License fixture ${id}`,
      platform: "Android",
      kind: "virtual",
      model: "Inert test fixture",
      visibility: "local",
      connection: { type: "adb", serial: `fixture-${id}`, port: 5037 },
      captureSourceId: null,
    });
  }
  await deck.execute("config.save", { config, revision: deck.config.revision });
}
const token = randomBytes(32).toString("base64url"),
  server = createService(deck, token, path.join(root, "build/web"));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
await writeFile(
  path.join(directory, "endpoint.json"),
  JSON.stringify({
    port: (server.address() as any).port,
    pid: process.pid,
    token,
  }),
  { mode: 0o600 },
);
console.log("Isolated Free licensing fixture ready.");
async function close() {
  server.close();
  await deck.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
