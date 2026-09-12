// Isolated browser fixture. Never registered by the production daemon or packaged app.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters, root } from "../packages/adapters/src";
import { CaptureEngine } from "../packages/capture/src";
import { mergeCaptureCards } from "../packages/core/src/capture-cards";
import type {
  DeviceConfig,
  SourceConfig,
  Config,
  Device,
} from "../packages/core/src/local/types";
const directory = path.resolve("work/range-card-fixture");
await mkdir(directory, { recursive: true });
const detected = [
  { uniqueId: "fixture-usb-a", name: "Fixture Cam Link" },
  { uniqueId: "fixture-usb-c", name: "Fixture spare HDMI" },
];
class FixtureAdapters extends Adapters {
  async diagnostics() {
    return [];
  }
  async inspect(d: DeviceConfig): Promise<Device> {
    return {
      ...d,
      online: true,
      locked: false,
      healthDetail: "Browser fixture",
      capabilities: ["key"],
    };
  }
  async inspectSources(sources: SourceConfig[]) {
    return sources.map((s) => ({
      ...s,
      status:
        s.uniqueId === "fixture-usb-b"
          ? ("missing" as const)
          : ("connected" as const),
    }));
  }
  async captureCards(sources: SourceConfig[]) {
    return {
      sources: mergeCaptureCards(sources, detected, (id) => id),
      diagnostics: [
        "Browser fixture inventory. No physical capture card is being accessed.",
      ],
    };
  }
  async input() {}
}
let deck: DeckService;
const adapters = new FixtureAdapters(() => deck.config.config);
class FixtureCapture extends CaptureEngine {
  async closeSource() {}
  async close() {}
  async preview() {
    throw new Error("Browser fixture has no hardware frames.");
  }
}
deck = new DeckService(
  directory,
  undefined,
  adapters,
  new FixtureCapture(adapters),
);
await deck.init();
if (!deck.config.config.devices.length) {
  const config = structuredClone(deck.config.config);
  config.sources = [
    {
      id: "saved-a",
      name: "Fixture Cam Link",
      kind: "usb",
      uniqueId: "fixture-usb-a",
    },
    {
      id: "saved-b",
      name: "Fixture disconnected HDMI",
      kind: "usb",
      uniqueId: "fixture-usb-b",
    },
  ];
  config.devices = ["desk", "spare", "busy"].map((id) => ({
    id,
    name: `Fixture ${id} TV`,
    platform: "Roku",
    kind: "physical",
    model: "Browser fixture only",
    visibility: "local",
    connection: { type: "roku", host: "192.0.2.1", serial: id },
    captureSourceId:
      id === "desk" ? "saved-a" : id === "busy" ? "saved-b" : null,
  }));
  config.port = 0;
  await deck.execute("config.save", { config, revision: deck.config.revision });
  for (const [i, days] of [0, 1, 4, 15].entries()) {
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
    const r = deck.store.reserve(
      i % 2 ? "spare" : "desk",
      null,
      null,
      "Fixture history",
      "Range proof",
      15,
    );
    const s = r.session;
    s.createdAt = start.getTime() - 3600000;
    s.endedAt = start.getTime() + 3600000;
    s.state = "closed";
    deck.store.putSession(s);
  }
  const held = deck.store.reserve(
    "busy",
    "saved-b",
    "usb:fixture-usb-b",
    "Fixture agent",
    "Reserved binding proof",
    240,
  );
  await writeFile(
    path.join(directory, "fixture-lease.json"),
    JSON.stringify({ sessionId: held.session.id, leaseToken: held.leaseToken }),
    { mode: 0o600 },
  );
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
console.log("Isolated card/report fixture ready.");
async function close() {
  server.close();
  await deck.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
