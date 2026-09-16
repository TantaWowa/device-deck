import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { createConnection, type Socket } from "node:net";
import type { DeviceConfig } from "../../core/src/local/types";
import { DeckError } from "../../core/src/local/types";
import { videoProfiles, type VideoProfile, type GestureCapability, type GestureInput, type H264Frame, type InteractiveSource, type PointerInput } from "../../core/src/live";
import { run, start, stop, type ProcessHandle } from "./process";
import { SCRCPY_SHA256, SCRCPY_VERSION, ScrcpyGopBuffer, ScrcpyTouch, ScrcpyVideoParser, validatePoint } from "./scrcpy-protocol";

export const ANDROID_GESTURES: GestureCapability[] = ["tap", "swipe", "longPress", "drag", "multitouch"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function freezeAdbTransport(device: DeviceConfig, adb: string, execute = run) {
  const c = device.connection;
  if (c.type !== "adb") throw new DeckError("unsupported-capability", "Android live video requires an ADB connection.");
  const result = await execute(adb, ["-P", String(c.port), "devices", "-l"]);
  const matches = result.stdout.toString().split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial === c.serial && state === "device");
  const id = matches[0]?.find((part) => /^transport_id:\d+$/.test(part))?.split(":")[1];
  if (matches.length !== 1 || !id)
    throw new DeckError("device-offline", "The exact Android transport is unavailable. Reconnect the device and refresh discovery.", 409);
  const args = ["-P", String(c.port), "-t", id];
  if (!c.avdName && (device.kind === "virtual" || /^emulator-\d+$/.test(c.serial)))
    throw new DeckError("identity-unverified", "Rediscover this emulator to bind its exact AVD identity before opening live video.", 409);
  if (c.hardwareId || !c.avdName) {
    const serial = (await execute(adb, [...args, "shell", "getprop", "ro.serialno"])).stdout.toString().trim();
    if (c.hardwareId ? serial !== c.hardwareId : !serial || serial !== c.serial)
      throw new DeckError("identity-mismatch", c.hardwareId
        ? "The Android transport belongs to a different hardware serial."
        : "This Android connection has no verified hardware identity. Rediscover and rebind the device's hardware serial before opening live video, especially for network ADB.", 409);
  }
  if (c.avdName) {
    let name = (await execute(adb, [...args, "emu", "avd", "name"]).catch(() => ({ stdout: Buffer.from("") })))
      .stdout.toString().split("\n").map((s) => s.trim()).filter((s) => s && s !== "OK").join("\n");
    if (!name) name = (await execute(adb, [...args, "shell", "getprop", "ro.boot.qemu.avd_name"])).stdout.toString().trim();
    if (name !== c.avdName)
      throw new DeckError("identity-mismatch", "The Android transport belongs to a different AVD.", 409);
  }
  return { args, port: c.port, serial: c.serial };
}

async function connectVideo(port: number, process: ProcessHandle): Promise<Socket> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !process.exited()) {
    const socket = await new Promise<Socket | undefined>((resolve) => {
      const candidate = createConnection({ host: "127.0.0.1", port });
      candidate.setNoDelay(true);
      const timer = setTimeout(() => finish(), 500);
      const failed = () => finish();
      const first = (chunk: Buffer) => {
        if (!chunk.length || chunk[0] !== 0) return finish();
        candidate.pause();
        candidate.removeListener("data", first);
        if (chunk.length > 1) candidate.unshift(chunk.subarray(1));
        finish(candidate);
      };
      let done = false;
      function finish(result?: Socket) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        candidate.removeListener("data", first);
        candidate.removeListener("close", failed);
        if (!result) candidate.destroy();
        resolve(result);
      }
      candidate.on("error", failed);
      candidate.once("close", failed);
      candidate.on("data", first);
    });
    if (socket) return socket;
    await delay(100);
  }
  throw new DeckError("capture-failed", process.log() || process.output() || "Android video server did not connect.", 502);
}

function connectControl(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Android control connection timed out.")); }, 5000);
    socket.setNoDelay(true);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function removeScrcpyForward(
  adb: string, transport: { args: string[]; port: number; serial: string },
  port: number, socketName: string, execute = run,
) {
  // Listing is server-wide, but ADB still requires a device selector for
  // killforward when multiple devices are connected. Keep our frozen -t ID.
  const ownsForward = async () => {
    const list = (await execute(adb, ["-P", String(transport.port), "forward", "--list"], 3000)).stdout.toString();
    return list.split("\n").some((line) => {
      const [serial, local, remote] = line.trim().split(/\s+/);
      return serial === transport.serial && local === `tcp:${port}` && remote === `localabstract:${socketName}`;
    });
  };
  if (!await ownsForward()) return;
  try {
    await execute(adb, [...transport.args, "forward", "--remove", `tcp:${port}`], 3000);
  } catch (error) {
    // A disconnected transport removes its listeners itself. Suppress only
    // that verified outcome, never an error which leaves our mapping behind.
    if (await ownsForward())
      throw new DeckError("cleanup-required", `Could not remove the Android video forward tcp:${port} on ADB port ${transport.port}: ${(error as Error).message}`, 502);
  }

}

export async function checkAndroidVideoSdk(adb: string, args: string[], execute = run): Promise<number> {
  const value = (await execute(adb, [...args, "shell", "getprop", "ro.build.version.sdk"])).stdout.toString().trim();
  const sdk = Number(value);
  if (!/^\d+$/.test(value) || sdk < 21)
    throw new DeckError("unsupported-android-version", `Android live video requires Android 5.0/API 21 or later. This transport reported ${value || "no SDK version"}.`, 409);
  return sdk;
}

export async function adbTouchscreen(adb: string, args: string[], execute = run): Promise<boolean> {
  try {
    const features = (await execute(adb, [...args, "shell", "pm", "list", "features"])).stdout.toString();
    return /^feature:android\.hardware\.touchscreen(?:[=\r]|$)/m.test(features);
  } catch { return false; }
}

export async function startScrcpy(device: DeviceConfig, adb: string, serverFile: string, control: boolean, profile: VideoProfile = "balanced"): Promise<InteractiveSource> {
  let server: Buffer;
  try { server = await readFile(serverFile); }
  catch { throw new DeckError("missing-helper", `The pinned scrcpy ${SCRCPY_VERSION} server is missing. Rebuild Device Deck with npm run build:local or reinstall the application.`, 503); }
  if (createHash("sha256").update(server).digest("hex") !== SCRCPY_SHA256)
    throw new DeckError("helper-mismatch", "The bundled Android video server failed its checksum. Rebuild or reinstall Device Deck.", 503);
  const transport = await freezeAdbTransport(device, adb);
  await checkAndroidVideoSdk(adb, transport.args);
  const touchEnabled = control && await adbTouchscreen(adb, transport.args);
  const quality = videoProfiles[profile];
  const scid = (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
  const socketName = `scrcpy_${scid}`;
  const remoteFile = `/data/local/tmp/deck-scrcpy-${scid}.jar`;
  let forward = 0, process: ProcessHandle | undefined, video: Socket | undefined, input: Socket | undefined;
  let closed = false, width = 0, height = 0, closing: Promise<void> | undefined;
  let closeNotified = false;
  const bootstrap = new ScrcpyGopBuffer();
  const frames = new Set<(frame: H264Frame) => void>();
  const closers = new Set<(reason: string) => void>();
  const touch = new ScrcpyTouch((packet) => new Promise((resolve, reject) => {
    if (!input || input.destroyed) return reject(new Error("Android touch connection is closed."));
    const timer = setTimeout(() => reject(new Error("Android touch connection stalled.")), 1500);
    input.write(packet, (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
  }));
  async function close(reason = "Android session closed") {
    if (closing) return closing;
    closed = true;
    gestureAbort?.abort();
    closing = (async () => {
      await touch.cancel().catch(() => {});
      input?.destroy();
      video?.destroy();
      if (process) await stop(process);
      let cleanupError: unknown;
      try { if (forward) await removeScrcpyForward(adb, transport, forward, socketName); }
      catch (error) { cleanupError = error; }
      await run(adb, [...transport.args, "shell", "rm", "-f", remoteFile], 3000).catch(() => {});
      if (!closeNotified) {
        closeNotified = true;
        for (const listener of closers) {
          try { listener(cleanupError ? `${reason}; ${(cleanupError as Error).message}` : reason); }
          catch { /* A subscriber cannot prevent source cleanup. */ }
        }
        frames.clear(); closers.clear();
      }
      if (cleanupError) throw cleanupError;
    })().catch((error) => {
      // Keep input closed, but let the owner retry an unresolved resource cleanup.
      // Successful close retains its resolved promise for ordinary idempotency.
      closing = undefined;
      throw error;
    });
    return closing;
  }
  let gestureRunning = false;
  let gestureAbort: AbortController | undefined;
  function assertControl() {
    if (closed) throw new DeckError("session-closed", "Android interactive session is closed.", 409);
    if (!control) throw new DeckError("control-disabled", "This is a view-only session.", 403);
    if (!touchEnabled) throw new DeckError("unsupported-capability", "This Android device does not advertise touchscreen input.", 409);
  }
  async function pointer(event: PointerInput) {
    assertControl();
    if (event.type === "cancel") gestureAbort?.abort();
    if (event.type !== "cancel" && (event.width !== width || event.height !== height))
      throw new DeckError("stale-frame", "The Android screen rotated. Retry using the current video dimensions.", 409);
    await touch.pointer(event);
  }
  async function gesture(gesture: GestureInput) {
    assertControl(); validatePoint(gesture);
    if (gestureRunning || touch.activeContacts) throw new DeckError("input-busy", "A gesture is already running.", 409);
    if (gesture.type === "swipe") validatePoint({ ...gesture, x: gesture.toX, y: gesture.toY });
    const duration = gesture.type === "tap" ? 50 : gesture.durationMs;
    if (!Number.isFinite(duration) || duration < 1 || duration > 10000)
      throw new DeckError("invalid-input", "Gesture duration must be between 1 and 10000 milliseconds.", 400);
    gestureRunning = true;
    gestureAbort = new AbortController();
    const signal = gestureAbort.signal;
    const base = { contactId: 2147483647, x: gesture.x, y: gesture.y, width: gesture.width, height: gesture.height };
    try {
      await pointer({ ...base, type: "down" });
      if (gesture.type === "swipe") {
        const steps = Math.max(1, Math.ceil(duration / 16));
        for (let i = 1; i <= steps; i++) {
          await wait(duration / steps, undefined, { signal });
          await pointer({ ...base, type: "move", x: gesture.x + (gesture.toX - gesture.x) * i / steps, y: gesture.y + (gesture.toY - gesture.y) * i / steps });
        }
        await pointer({ ...base, type: "up", x: gesture.toX, y: gesture.toY });
      } else {
        await wait(duration, undefined, { signal });
        await pointer({ ...base, type: "up" });
      }
    } finally {
      await touch.cancel().catch(() => {});
      gestureRunning = false; gestureAbort = undefined;
    }
  }
  try {
    await run(adb, [...transport.args, "push", serverFile, remoteFile]);
    forward = Number((await run(adb, [...transport.args, "forward", "tcp:0", `localabstract:${socketName}`])).stdout.toString().trim());
    if (!Number.isInteger(forward) || forward < 1 || forward > 65535) throw new Error("ADB did not allocate a video forwarding port.");
    process = start(adb, [...transport.args, "shell", `CLASSPATH=${remoteFile}`, "exec", "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
      `scid=${scid}`, "log_level=warn", "tunnel_forward=true", "audio=false", `control=${touchEnabled}`, "video_codec=h264", `video_bit_rate=${quality.bitrate}`, `max_size=${quality.width}`, `max_fps=${quality.fps}`, `video_codec_options=profile=1,level=512,frame-rate=${quality.fps},i-frame-interval=1`, "send_device_meta=false", "clipboard_autosync=false", "power_on=false"]);
    video = await connectVideo(forward, process);
    if (touchEnabled) { input = await connectControl(forward); input.resume(); }
    const source: InteractiveSource = {
      get width() { return width; }, get height() { return height; }, fps: quality.fps,
      capabilities: touchEnabled ? [...ANDROID_GESTURES] : [],
      onFrame(listener) { frames.add(listener); bootstrap.replay(listener); return () => { frames.delete(listener); }; },
      onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; },
      async pointer(event) {
        if (gestureRunning && event.type !== "cancel")
          throw new DeckError("input-busy", "A gesture is already running.", 409);
        await pointer(event);
      }, gesture, close: () => close(),
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Android encoder did not produce video metadata.")), 8000);
      const parser = new ScrcpyVideoParser((w, h) => {
        bootstrap.reset();
        if (width && (w !== width || h !== height)) {
          void touch.cancel(w, h).catch(() => {});
        }
        width = w; height = h; clearTimeout(timer); resolve();
      }, (frame, configuration) => {
        bootstrap.push(frame, configuration);
        for (const listener of frames) listener(frame);
      });
      const failed = (reason: string) => { clearTimeout(timer); reject(new Error(reason)); void close(reason).catch(() => {}); };
      video!.on("data", (chunk: Buffer) => { try { parser.push(chunk); } catch (error) { failed((error as Error).message); } });
      video!.once("close", () => { if (!closed) failed("Android video disconnected."); });
      video!.on("error", (error) => failed(error.message));
      input?.once("close", () => { if (!closed) failed("Android input disconnected."); });
      input?.on("error", (error) => failed(error.message));
      void process!.completed.then(() => { if (!closed) failed(process!.log() || "Android video server exited."); });
      video!.resume();
    });
    return source;
  } catch (error) { await close((error as Error).message); throw error; }
}
