// Manual CUA preview of the production local UI. All devices and video are synthetic.
// Run: node --import tsx scripts/preview-compact-remotes.ts
// UI edits rebuild automatically; refresh the browser to load them.
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters } from "../packages/adapters/src";
import { available } from "../packages/adapters/src/process";
import { CaptureEngine } from "../packages/capture/src";
import type { Device, DeviceConfig, SourceConfig } from "../packages/core/src/local/types";
import { LocalDevelopmentLicense } from "./local-license";

const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.env.QA_REMOTE_OUTPUT || path.join(root, "outputs/compact-remote-preview"));
for (const tool of ["ffmpeg", "ffprobe"]) {
  assert(await available(tool), `${tool} is required to generate synthetic preview video.`);
}
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), "deck-compact-remote-preview-"));
const webRoot = path.join(directory, "web");
const inputLog = path.join(output, "inputs.jsonl");
await writeFile(inputLog, "");
const devices: DeviceConfig[] = [
  {
    id: "preview-roku", name: "Fixture Roku Ultra", model: "Roku Ultra 4802X",
    platform: "Roku", kind: "physical", inputMode: "remote", visibility: "local",
    connection: { type: "roku", host: "roku.invalid", serial: "FIXTURE-ROKU" },
    captureSourceId: "preview-roku-feed",
  },
  {
    id: "preview-apple", name: "Fixture Apple TV", model: "Apple TV 4K",
    platform: "Apple", kind: "physical", inputMode: "remote", visibility: "local",
    connection: { type: "apple-tv", host: "apple.invalid", identifier: "FIXTURE-APPLE" },
    captureSourceId: "preview-apple-feed",
  },
  {
    id: "preview-fire", name: "Fixture Fire TV", model: "Amazon Fire TV Stick 4K",
    platform: "Android", kind: "physical", inputMode: "remote", visibility: "local",
    connection: { type: "adb", serial: "fixture-only-fire", hardwareId: "FIXTURE-FIRE", port: 5037 },
    captureSourceId: "preview-fire-feed",
  },
];
const sources: SourceConfig[] = devices.map((device) => ({
  id: device.captureSourceId!, name: `${device.name} · synthetic video`, kind: "usb",
  uniqueId: device.id, deviceId: device.id,
}));
const requireFixture = (device: DeviceConfig) => {
  assert(devices.some((fixture) => fixture.id === device.id), "Only preview fixture devices are allowed.");
};
const logInput = (event: unknown) => appendFile(inputLog, `${JSON.stringify({ at: Date.now(), event })}\n`);
let deck: DeckService;
class FixtureAdapters extends Adapters {
  override async diagnostics() { return ["Isolated compact-remote preview: three synthetic feeds; input is logged, never sent to hardware."]; }
  override async discover() { return { devices, sources, diagnostics: [] }; }
  override async inspect(device: DeviceConfig): Promise<Device> {
    requireFixture(device);
    return { ...device, online: true, readiness: "ready", locked: false,
      healthDetail: "Synthetic preview · no hardware connection",
      capabilities: ["preview", "key", "text", "screenshot", "record", "restart"] };
  }
  override async inspectSources(configured: SourceConfig[]) {
    return configured.map((source) => ({ ...source, status: "connected" as const }));
  }
  override async captureCards() { return { sources: sources.map((source) => ({ ...source, status: "connected" as const })), diagnostics: [] }; }
  override async verifyIdentity(device: DeviceConfig) { requireFixture(device); return device; }
  override async input(device: DeviceConfig, input: { key?: string; text?: string }) {
    requireFixture(device);
    await logInput({ type: "input", deviceId: device.id, key: input.key, text: input.text });
  }
  override async wake(device: DeviceConfig) {
    requireFixture(device);
    await logInput({ type: "wake", deviceId: device.id });
    return { method: "Synthetic wake (logged only)" };
  }
  override async restart(device: DeviceConfig) {
    requireFixture(device);
    await logInput({ type: "restart", deviceId: device.id });
  }
  override async screenshot(): Promise<never> { throw new Error("Use the synthetic USB capture source."); }
  override async pair(): Promise<never> { throw new Error("Synthetic devices are already paired."); }
  override async startInteractive(): Promise<never> { throw new Error("This preview contains remote-controlled TVs only."); }
  override async prepareSimulator(): Promise<never> { throw new Error("This preview contains no simulators."); }
  override async simulator(): Promise<never> { throw new Error("This preview contains no simulators."); }
}
// The real USB capture pipeline receives generated MJPEG, never AVFoundation input.
const camera = path.join(directory, "synthetic-camera");
await writeFile(camera, `#!/bin/sh
case "$2" in
  preview-roku) hue=0 ;;
  preview-apple) hue=90 ;;
  preview-fire) hue=180 ;;
  *) exit 64 ;;
esac
exec ffmpeg -hide_banner -loglevel error -re -f lavfi -i "testsrc2=size=640x360:rate=15,hue=h=$hue" -c:v mjpeg -q:v 3 -f mjpeg pipe:1
`, { mode: 0o700 });
const adapters = new FixtureAdapters(() => deck.config.config, async () => {
  throw new Error("Real adapter commands are disabled in the compact-remote preview.");
});
deck = new DeckService(directory, undefined, adapters, new CaptureEngine(adapters, camera), new LocalDevelopmentLicense());
await deck.init();
const config = structuredClone(deck.config.config);
config.port = 0;
config.devices = devices;
config.sources = sources;
config.settings.folder = path.join(directory, "captures");
config.settings.owner = "Preview user";
config.settings.ttl = 240;
config.settings.clipboard = false;
config.settings.captureMode = "clean";
await deck.config.save(config, deck.config.revision);

let initialBuildDone: () => void;
let initialBuildFailed: (error: unknown) => void;
const initialBuild = new Promise<void>((resolve, reject) => {
  initialBuildDone = resolve;
  initialBuildFailed = reject;
});
const watcher = await build({
  root: path.join(root, "apps/web"), logLevel: "warn", clearScreen: false,
  plugins: [{
    name: "compact-remote-preview-entry",
    async writeBundle() {
      await copyFile(path.join(webRoot, "local.html"), path.join(webRoot, "index.html"));
      initialBuildDone();
      console.log("REMOTE_PREVIEW_UI_BUILT Refresh the browser for the latest UI.");
    },
  }],
  build: { outDir: webRoot, emptyOutDir: true, watch: {}, rollupOptions: { input: path.join(root, "apps/web/local.html") } },
});
assert(!Array.isArray(watcher) && "on" in watcher, "Expected the Vite build watcher.");
watcher.on("event", (event) => { if (event.code === "ERROR") initialBuildFailed(event.error); });
await initialBuild;
const token = "synthetic-compact-remote-preview-token";
const server = createService(deck, token, webRoot);
await new Promise<void>((resolve) => server.listen(Number(process.env.QA_REMOTE_PORT || 0), "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const response = await fetch(`${base}/v1/browser-ticket`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
});
assert(response.ok);
const { ticket } = await response.json();
const query = `?view=feeds&layout=grid&sources=${sources.map((source) => source.id).join(",")}`;
const info = { base, url: `${base}/${query}#ticket=${ticket}`, token, directory, webRoot, inputLog, pid: process.pid, fixtureOnly: true };
await writeFile(path.join(output, "fixture.json"), JSON.stringify(info, null, 2));
console.log(`REMOTE_PREVIEW_READY ${JSON.stringify(info)}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await Promise.all([watcher.close(), deck.close(), new Promise<void>((resolve) => server.close(() => resolve()))]);
  await rm(directory, { recursive: true, force: true });
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
