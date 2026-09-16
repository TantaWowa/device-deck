// Isolated synthetic video + touch fixture. Never discovers or contacts real devices.
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "vite";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters } from "../packages/adapters/src";
import { CaptureEngine } from "../packages/capture/src";
import type { Config, Device, DeviceConfig, SourceConfig } from "../packages/core/src/local/types";
import type { InteractiveSource, VideoProfile } from "../packages/core/src/live";
import { LocalDevelopmentLicense } from "./local-license";

const directory = await mkdtemp(path.join(os.tmpdir(), "deck-live-qa-"));
let config: Config;
const events: unknown[] = [];
const running = new Set(["usb", "android"]);
const source: SourceConfig = { id: "qa-usb", kind: "usb", name: "Synthetic USB feed", uniqueId: "qa-only" };
const helper = path.join(directory, "camera");
await writeFile(helper, '#!/bin/sh\nexec ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc2=size=640x360:rate=15 -c:v mjpeg -q:v 3 -f mjpeg pipe:1\n', { mode: 0o700 });
class FixtureAdapters extends Adapters {
  override async diagnostics() { return []; }
  override async inspect(d: DeviceConfig): Promise<Device> {
    return { ...d, online: running.has(d.id), locked: false, healthDetail: "Synthetic fixture", ...(d.kind === "virtual" ? { simulatorState: running.has(d.id) ? "booted" as const : "shutdown" as const } : {}), capabilities: ["preview", "touch", "key", "text", "screenshot"], gestureCapabilities: d.platform === "Apple" ? ["tap", "swipe", "longPress"] : ["tap", "swipe", "longPress", "drag", "multitouch"] };
  }
  override async inspectSources(sources: SourceConfig[]) { return sources.map((s) => ({ ...s, status: s.kind === "usb" || running.has(s.deviceId || "") ? "connected" as const : "missing" as const })); }
  override async verifyIdentity(d: DeviceConfig) { return d; }
  override async prepareSimulator(d: DeviceConfig) { return d; }
  override async simulator(d: DeviceConfig, action: "launch" | "close") {
    const changed = running.has(d.id) !== (action === "launch");
    if (action === "launch") running.add(d.id); else running.delete(d.id);
    events.push({ type: "simulator", deviceId: d.id, action });
    return { deviceId: d.id, action, state: action === "launch" ? "booted" as const : "shutdown" as const, changed };
  }
  override async screenshot() { return capture.preview(null, source, 0); }
  override async input() { events.push({ type: "key" }); }
  override async startInteractive(d: DeviceConfig, _control = true, profile: VideoProfile = "balanced"): Promise<InteractiveSource> {
    if (d.platform === "Apple") return {
      width: 640, height: 360, capabilities: ["tap", "swipe", "longPress"],
      onFrame: () => () => {}, onClose: () => () => {}, close: async () => {},
      pointer: async () => { throw new Error("Synthetic Apple uses completed gestures only."); },
      gesture: async (gesture) => { events.push({ ...gesture, deviceId: d.id }); },
    };
    const video = await capture.live(null, source, profile);
    return {
      get width() { return video.width; }, get height() { return video.height; },
      onFrame: video.onFrame.bind(video), onClose: video.onClose.bind(video), close: video.close.bind(video),
      capabilities: ["tap", "swipe", "longPress", "drag", "multitouch"],
      pointer: async (event) => { events.push({ ...event, deviceId: d.id }); }, gesture: async (gesture) => { events.push({ ...gesture, deviceId: d.id }); },
    };
  }
}
const adapters = new FixtureAdapters(() => config);
const capture = new CaptureEngine(adapters, helper);
const deck = new DeckService(directory, undefined, adapters, capture, new LocalDevelopmentLicense());
await deck.init();
config = structuredClone(deck.config.config);
config.port = 0;
config.devices = [
  { id: "usb", name: "Synthetic USB", platform: "Other", kind: "physical", model: "QA", visibility: "local", connection: { type: "capture" }, captureSourceId: source.id },
  { id: "android", name: "Synthetic Android", platform: "Android", kind: "physical", model: "QA", visibility: "local", connection: { type: "adb", serial: "qa-only-not-real", hardwareId: "qa-only", port: 5037 }, captureSourceId: "qa-native" },
  { id: "android-sim", name: "Synthetic Android emulator", platform: "Android", kind: "virtual", model: "QA", visibility: "local", connection: { type: "adb", serial: "emulator-5998", avdName: "qa-only-emulator", port: 5037 }, captureSourceId: null },
  { id: "apple-sim", name: "Synthetic Apple simulator", platform: "Apple", kind: "virtual", model: "QA", visibility: "local", connection: { type: "simulator", udid: "ea415a3a-39fa-4dcb-a028-a5260f5156c3", os: "ios" }, captureSourceId: null },
];
config.sources = [source, { id: "qa-native", kind: "native", name: "Synthetic Android screen", deviceId: "android" }];
await deck.config.save(config, deck.config.revision);
const webRoot = path.join(directory, "web");
await build({ root: "apps/web", build: { outDir: webRoot, emptyOutDir: true, rollupOptions: { input: "apps/web/local.html" } } });
await rename(path.join(webRoot, "local.html"), path.join(webRoot, "index.html"));
const token = "synthetic-qa-token";
const server = createService(deck, token, webRoot);
await new Promise<void>((resolve) => server.listen(Number(process.env.QA_LIVE_PORT || 47941), "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const ticket = await fetch(`${base}/v1/browser-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
const evidence = path.resolve("outputs/live-video-qa");
await mkdir(evidence, { recursive: true });
const info = { base, url: `${base}/#ticket=${ticket.ticket}`, directory, token };
await writeFile(path.join(evidence, "fixture.json"), JSON.stringify(info));
const timer = setInterval(() => void writeFile(path.join(evidence, "inputs.json"), JSON.stringify(events, null, 2)), 250);
console.log(`LIVE_QA_READY ${JSON.stringify(info)}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true; clearInterval(timer);
  await deck.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
