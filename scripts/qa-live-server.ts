// Isolated synthetic video + touch fixture. Never discovers or contacts real devices.
import { mkdtemp, mkdir, writeFile, rename, rm, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "vite";
import { DeckService } from "../apps/daemon/src/local/service";
import { createService } from "../apps/daemon/src/server";
import { Adapters } from "../packages/adapters/src";
import { CaptureEngine } from "../packages/capture/src";
import { run } from "../packages/adapters/src/process";
import type { Config, Device, DeviceConfig, SourceConfig } from "../packages/core/src/local/types";
import type { InteractiveSource, VideoProfile } from "../packages/core/src/live";
import { LocalDevelopmentLicense } from "./local-license";

const directory = await mkdtemp(path.join(os.tmpdir(), "deck-live-qa-"));
const capturesMode = process.env.QA_CAPTURES === "1";
const phoneControlsMode = process.env.QA_PHONE_CONTROLS === "1";
const formFactorMode = process.env.QA_FORM_FACTOR === "1";
let config: Config;
const events: unknown[] = [];
const running = new Set(["usb", "android"]);
if (phoneControlsMode) running.add("apple-sim");
const booting = new Set<string>();
const source: SourceConfig = { id: "qa-usb", kind: "usb", name: "Synthetic USB feed", uniqueId: "qa-only" };
const helper = path.join(directory, "camera");
await writeFile(helper, '#!/bin/sh\nexec ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc2=size=640x360:rate=15 -c:v mjpeg -q:v 3 -f mjpeg pipe:1\n', { mode: 0o700 });
class FixtureAdapters extends Adapters {
  override async diagnostics() { return []; }
  override async inspect(d: DeviceConfig): Promise<Device> {
    const starting = booting.has(d.id), online = running.has(d.id) && !starting;
    return { ...d, online, readiness: starting ? "starting" : online ? "ready" : "offline", locked: false, healthDetail: starting ? "Booting synthetic device" : "Synthetic fixture", ...(d.kind === "virtual" ? { simulatorState: starting ? "starting" as const : online ? "booted" as const : "shutdown" as const } : {}), capabilities: online ? ["preview", ...(d.id === "usb" ? [] : ["touch" as const]), "key", "text", "screenshot", ...(capturesMode && d.id === "usb" ? ["record" as const] : [])] : [], gestureCapabilities: d.platform === "Apple" ? ["tap", "swipe", "longPress"] : ["tap", "swipe", "longPress", "drag", "multitouch"] };
  }
  override async inspectSources(sources: SourceConfig[]) { return sources.map((s) => ({ ...s, status: s.kind === "usb" || running.has(s.deviceId || "") ? "connected" as const : "missing" as const })); }
  override async verifyIdentity(d: DeviceConfig) { return d; }
  override async prepareSimulator(d: DeviceConfig) { return d; }
  override async simulator(d: DeviceConfig, action: "launch" | "close") {
    const changed = running.has(d.id) !== (action === "launch");
    events.push({ type: "simulator", deviceId: d.id, action });
    if (action === "launch") {
      if (changed) {
        booting.add(d.id);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        booting.delete(d.id);
      }
      running.add(d.id);
    } else running.delete(d.id);
    return { deviceId: d.id, action, state: action === "launch" ? "booted" as const : "shutdown" as const, changed };
  }
  override async screenshot() { return capture.preview(null, source, 0); }
  override async input(device: DeviceConfig, input: { key?: string; text?: string; x?: number; y?: number }) { events.push({ type: "key", deviceId: device.id, key: input.key, text: input.text, x: input.x, y: input.y }); }
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
      pointer: async (event) => {
        // The phone-button QA deliberately races a key against an unfinished
        // gesture to prove ordering across the data channel and HTTP API.
        if (phoneControlsMode && event.type === "down") await new Promise((resolve) => setTimeout(resolve, 250));
        events.push({ ...event, deviceId: d.id });
      }, gesture: async (gesture) => { events.push({ ...gesture, deviceId: d.id }); },
    };
  }
}
const adapters = new FixtureAdapters(() => config);
// The synthetic Apple screen uses the same generated video as the other test
// devices. It must never start idb against a real simulator during browser QA.
class FixtureCapture extends CaptureEngine {
  override live(d: DeviceConfig | null, s: SourceConfig, profile: VideoProfile = "balanced") {
    return super.live(d?.connection.type === "simulator" && d.connection.os === "ios" ? null : d,
      d?.connection.type === "simulator" && d.connection.os === "ios" ? source : s, profile);
  }
}
const capture = new FixtureCapture(adapters, helper);
const deck = new DeckService(directory, undefined, adapters, capture, new LocalDevelopmentLicense());
await deck.init();
config = structuredClone(deck.config.config);
config.port = 0;
config.settings.folder = path.join(directory, "captures");
config.settings.captureMode = "clean";
config.settings.clipboard = false;
config.devices = [
  { id: "usb", name: "Synthetic USB", platform: "Other", kind: "physical", model: "QA", visibility: "local", inputMode: "remote", connection: { type: "capture" }, captureSourceId: source.id },
  { id: "android", name: "Synthetic Android", platform: "Android", kind: "physical", model: "QA", visibility: "local", connection: { type: "adb", serial: "qa-only-not-real", hardwareId: "qa-only", port: 5037 }, captureSourceId: "qa-native" },
  { id: "android-sim", name: "Synthetic Android emulator", platform: "Android", kind: "virtual", model: "QA", visibility: "local", connection: { type: "adb", serial: "emulator-5998", avdName: "qa-only-emulator", port: 5037 }, captureSourceId: null },
  { id: "apple-sim", name: "Synthetic Apple simulator", platform: "Apple", kind: "virtual", model: "QA", visibility: "local", connection: { type: "simulator", udid: "ea415a3a-39fa-4dcb-a028-a5260f5156c3", os: "ios" }, captureSourceId: null },
];
config.sources = [source, { id: "qa-native", kind: "native", name: "Synthetic Android screen", deviceId: "android" }];
if (formFactorMode) {
  running.add("other");
  config.devices.push({ id: "other", name: "Synthetic Other", platform: "Other", kind: "physical", model: "QA camera", visibility: "local", connection: { type: "capture" }, captureSourceId: "qa-other" });
  config.sources.push({ id: "qa-other", kind: "usb", name: "Synthetic Other feed", uniqueId: "qa-only-other" });
}
if (phoneControlsMode) {
  config.devices.find((device) => device.id === "apple-sim")!.captureSourceId = "qa-ios";
  config.sources.push({ id: "qa-ios", kind: "native", name: "Synthetic iPhone screen", deviceId: "apple-sim" });
}
await deck.config.save(config, deck.config.revision);
if (capturesMode) {
  await mkdir(config.settings.folder, { recursive: true });
  const image = path.join(directory, "fixture.png"), video = path.join(directory, "fixture.mp4");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", image]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
  const seedNames = ["Alpha screenshot", "Bravo recording", "Charlie screenshot", "Delta screenshot", "Trashed screenshot"];
  if (formFactorMode) seedNames.push("Echo screenshot");
  for (let index = 0; index < seedNames.length; index++) {
    const recording = index === 1, id = `seed-${index}`, file = path.join(config.settings.folder, `${id}.${recording ? "mp4" : "png"}`);
    await copyFile(recording ? video : image, file);
    const artifact = { id, deviceId: index % 2 ? "android" : "usb", sessionId: "synthetic-history", owner: "Capture QA", sourceId: index % 2 ? "qa-native" : source.id, name: seedNames[index], path: file, logPath: `${file}.json`, kind: recording ? "recording" as const : "screenshot" as const, mode: "clean" as const, tags: [index % 2 ? "regression" : "payments"], createdAt: Date.now() - (index + 1) * 60_000, duration: recording ? 1 : 0, bytes: (await stat(file)).size, status: "completed" as const, origin: "API" as const, ...(index === 4 ? { deletedAt: Date.now() } : {}) };
    if (index === 5) { artifact.deviceId = "other"; artifact.sourceId = "qa-other"; }
    deck.store.putArtifact(artifact);
    await writeFile(artifact.logPath, JSON.stringify({ schemaVersion: 1, artifact, inputs: [] }));
  }
}
const webRoot = path.join(directory, "web");
await build({ root: "apps/web", build: { outDir: webRoot, emptyOutDir: true, rollupOptions: { input: "apps/web/local.html" } } });
await rename(path.join(webRoot, "local.html"), path.join(webRoot, "index.html"));
const token = "synthetic-qa-token";
const server = createService(deck, token, webRoot);
await new Promise<void>((resolve) => server.listen(Number(process.env.QA_LIVE_PORT || 47941), "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const ticket = await fetch(`${base}/v1/browser-ticket`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
const evidence = path.resolve(process.env.QA_LIVE_OUTPUT || (capturesMode ? "outputs/capture-qa" : "outputs/live-video-qa"));
await mkdir(evidence, { recursive: true });
const info = { base, url: `${base}/#ticket=${ticket.ticket}`, directory, token, capturesMode, phoneControlsMode, formFactorMode, pid: process.pid };
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
