import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Adapters } from "../packages/adapters/src";
import { CaptureEngine, type RecordingHandle } from "../packages/capture/src";
import { LicenseManager } from "../packages/licensing/src";
import type { Device, DeviceConfig, SourceConfig } from "../packages/core/src/local/types";
import { DeckService } from "../apps/daemon/src/local/service";
import { DeckConnections } from "../apps/daemon/src/decks";
import { createService } from "../apps/daemon/src/server";
import { MachineAuthority } from "../apps/daemon/src/network";

export const fixtureImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

export async function deckFixture(name: string, webRoot = "/missing") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-sharing-"));
  let deck: DeckService;
  const inputs: string[] = [];
  class FixtureAdapters extends Adapters {
    async diagnostics() { return []; }
    async inspect(device: DeviceConfig): Promise<Device> {
      return { ...device, online: true, locked: false, healthDetail: "Isolated fixture", capabilities: ["key", "preview", "screenshot", "record"] };
    }
    async inspectSources(sources: SourceConfig[]) { return sources.map((source) => ({ ...source, status: "connected" as const })); }
    async captureCards(sources: SourceConfig[]) { return { sources: await this.inspectSources(sources), diagnostics: [], observation: { observedAt: Date.now(), refreshing: false, stale: false, error: null, nextRefreshAt: 0 } }; }
    async input(device: DeviceConfig) { inputs.push(device.id); }
  }
  class FixtureCapture extends CaptureEngine {
    async preview() { return fixtureImage; }
    async screenshot(_device: DeviceConfig, _source: SourceConfig, file: string) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, fixtureImage); return fixtureImage.length;
    }
    async startRecording(id: string, device: DeviceConfig, _source: SourceConfig, file: string): Promise<RecordingHandle> {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from("fixture recording bytes"));
      let finish: (reason: string | undefined) => void = () => {};
      return { id, deviceId: device.id, path: file, startedAt: Date.now(), startedMono: performance.now(),
        ended: new Promise((resolve) => { finish = resolve; }),
        stop: async () => { finish(undefined); return { duration: 1, bytes: 23 }; },
      };
    }
    async closeSource() {}
    async close() {}
  }
  const adapters = new FixtureAdapters(() => deck.config.config);
  deck = new DeckService(directory, undefined, adapters, new FixtureCapture(adapters), new LicenseManager(directory, null));
  await deck.init();
  const config = structuredClone(deck.config.config);
  config.settings.folder = path.join(directory, "captures");
  config.sources = [{ id: "card", name: `${name} HDMI`, kind: "usb", uniqueId: `${name}-hardware` }];
  config.devices = [{ id: "tv", name: `${name} TV`, platform: "Roku", kind: "physical", model: "fixture", visibility: "local", connection: { type: "roku", host: "fixture.invalid", serial: name }, captureSourceId: "card" }];
  await deck.execute("config.save", { config, revision: deck.config.revision });
  const connections = new DeckConnections(directory);
  const authority = new MachineAuthority(directory);
  await authority.init();
  const token = randomBytes(32).toString("base64url");
  const server = createService(deck, token, webRoot, { decks: connections, authority });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const address = `http://127.0.0.1:${port}`;
  await writeFile(path.join(directory, "endpoint.json"), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  return {
    deck, directory, address, token, connections, authority, inputs, server,
    request: (route: string, body?: unknown, access = token, headers: Record<string, string> = {}) => fetch(address + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "X-Device-Deck": "local", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deck.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function pairedDecks(webRoot?: string) {
  const host = await deckFixture("Host", webRoot);
  const local = await deckFixture("Local", webRoot);
  const close = async () => { await local.close(); await host.close(); };
  try {
    const grant = await host.connections.grant("ms2");
    await local.connections.add({ name: "ms", address: host.address, token: grant.token }, (await local.authority.metadata()).id);
    return { host, local, grant, close };
  } catch (error) { await close(); throw error; }
}
