import { EventEmitter } from "node:events";
import { writeFile, readFile, mkdir, mkdtemp, copyFile, stat, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { H264Frame, LiveVideoSource, VideoProfile } from "../../core/src/live";
import { encodeLiveImages, type ImageVideoInput } from "./video";
import { startIosSimulatorVideo } from "./ios-video";
import { wdaScreenshot } from "../../adapters/src/webdriveragent";
export { H264Packetizer } from "./h264";
import {
  type DeviceConfig,
  type SourceConfig,
  type Input,
  fail,
} from "../../core/src/local/types";
import { Adapters, helper } from "../../adapters/src";
import {
  start,
  stop,
  ready,
  run,
  type ProcessHandle,
} from "../../adapters/src/process";
export type RecordingHandle = {
  device?: DeviceConfig;
  id: string;
  deviceId: string;
  path: string;
  startedAt: number;
  startedMono: number;
  pid?: number;
  remotePid?: string;
  remotePath?: string;
  localPath?: string;
  ended: Promise<string | undefined>;
  stop: () => Promise<{
    duration: number;
    bytes: number;
    interruption?: string;
  }>;
};
class UsbStream extends EventEmitter {
  private handle?: ProcessHandle;
  private abort = new AbortController();
  private startup: Promise<void>;
  private closed = false;
  latest?: Buffer;
  buffer = Buffer.alloc(0);
  error = "";
  users = 0;
  closeWhenUnused = false;
  idleTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  constructor(id: string, cameraHelper: string, adapters: Adapters, startupTimeout: number) {
    super();
    this.setMaxListeners(0);
    this.startup = adapters.cameras.initialize(async (signal) => {
      signal.throwIfAborted();
      const handle = this.handle = start(cameraHelper, ["stream", id]);
      handle.child.stdout.on("data", this.receive);
      void handle.completed.then(() => {
        this.error ||= handle.log() || "USB capture source disconnected";
        this.emit("stopped");
      });
      try { await this.firstFrame(signal, startupTimeout); }
      catch (error) {
        this.error ||= error instanceof Error ? error.message : String(error);
        // Keep the shared native initialization gate until the failed child exits.
        await stop(handle);
        throw error;
      }
    }, this.abort.signal);
    // A queued startup can be closed before any caller starts awaiting its frame.
    void this.startup.catch((error) => {
      this.error ||= error instanceof Error ? error.message : String(error);
      this.emit("stopped");
    });
  }
  get unavailable() { return this.closed || Boolean(this.error); }
  private receive = (data: Buffer) => {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.error = "Invalid capture stream";
      this.buffer = Buffer.alloc(0);
      void this.close();
      return;
    }
    while (true) {
      const begin = this.buffer.indexOf(Buffer.from([255, 216]));
      if (begin < 0) return;
      const end = this.buffer.indexOf(Buffer.from([255, 217]), begin + 2);
      if (end < 0) return;
      this.latest = this.buffer.subarray(begin, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      this.emit("frame", this.latest);
    }
  };
  private firstFrame(signal: AbortSignal, timeout: number) {
    return new Promise<Buffer>((resolve, reject) => {
      const done = (buffer?: Buffer) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onStop);
        this.off("frame", onFrame);
        this.off("stopped", onStop);
        buffer
          ? resolve(buffer)
          : reject(
              new Error(
                this.error ||
                  "USB source did not produce a frame; check camera permission and HDMI signal.",
              ),
            );
      };
      const onFrame = (b: Buffer) => done(b),
        onStop = () => done();
      const timer = setTimeout(onStop, timeout);
      this.once("frame", onFrame);
      this.once("stopped", onStop);
      signal.addEventListener("abort", onStop, { once: true });
      if (signal.aborted || this.unavailable) onStop();
    });
  }
  async frame() {
    await this.startup;
    if (this.unavailable || !this.latest) throw new Error(this.error || "USB capture source closed");
    return this.latest;
  }
  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.abort.abort();
    return this.closing ??= (async () => {
      await this.startup.catch(() => {});
      if (this.handle) {
        await stop(this.handle);
        this.handle.child.stdout.off("data", this.receive);
      }
      this.latest = undefined;
      this.buffer = Buffer.alloc(0);
      this.removeAllListeners();
    })();
  }
}
type SharedLiveVideo = {
  sourceId: string;
  source: Promise<LiveVideoSource>;
  users: number;
  closed: boolean;
};
export class CaptureEngine {
  private streams = new Map<string, UsbStream>();
  private frames = new Map<string, { at: number; data: Buffer }>();
  private pending = new Map<string, Promise<Buffer>>();
  private liveStreams = new Map<string, SharedLiveVideo>();
  private closed = false;
  constructor(
    readonly adapters: Adapters,
    readonly cameraHelper = helper,
    private readonly usbTimings: { idleGraceMs?: number; startupTimeoutMs?: number } = {},
  ) {}
  private async retainUsb(s: SourceConfig) {
    if (!s.uniqueId) fail("source-missing", "USB source has no stable ID.");
    const id = s.uniqueId;
    let stream = this.streams.get(s.uniqueId);
    while (stream?.unavailable) {
      await this.closeUsb(id, stream);
      stream = this.streams.get(id);
    }
    if (this.closed) fail("capture-closed", "Capture service is shutting down.", 503);
    if (!stream) {
      stream = new UsbStream(id, this.cameraHelper, this.adapters, this.usbTimings.startupTimeoutMs ?? 12000);
      this.streams.set(id, stream);
    }
    const retained = stream;
    clearTimeout(stream.idleTimer);
    stream.idleTimer = undefined;
    stream.users++;
    let released = false;
    return {
      stream: retained,
      release: async (closeWhenUnused = false) => {
        if (released) return;
        released = true;
        retained.closeWhenUnused ||= closeWhenUnused;
        if (--retained.users === 0) {
          if (retained.closeWhenUnused || retained.unavailable) await this.closeUsb(id, retained);
          else {
            retained.idleTimer = setTimeout(() => {
              void this.closeUsb(id, retained).catch((error) => { retained.error = String(error); });
            }, this.usbTimings.idleGraceMs ?? 5000);
            retained.idleTimer.unref();
          }
        }
      },
    };
  }
  private async closeUsb(id: string, stream: UsbStream) {
    // Keep the closing entry visible: a new retain must await its child exit.
    await stream.close();
    if (this.streams.get(id) === stream) this.streams.delete(id);
  }
  private async liveInput(d: DeviceConfig | null, s: SourceConfig): Promise<ImageVideoInput> {
    if (s.kind === "usb") {
      const { stream, release } = await this.retainUsb(s);
      try {
        const first = await stream.frame();
        return {
          first,
          fps: 15, // The shared native camera helper currently captures 720p at 15fps.
          onFrame: (listener) => {
            stream.on("frame", listener);
            return () => { stream.off("frame", listener); };
          },
          onClose: (listener) => {
            const stopped = () => listener(stream.error || "USB capture source disconnected.");
            stream.on("stopped", stopped);
            if (stream.error) queueMicrotask(stopped);
            return () => { stream.off("stopped", stopped); };
          },
          close: () => release(true),
        };
      } catch (e) { await release(true); throw e; }
    }
    if (!d) fail("source-missing", "A native screen needs its configured device.", 404);
    // Retain one exact USB forward throughout this physical iOS viewer. Reading
    // images never creates or takes over a WebDriverAgent automation session.
    const apple = d.connection.type === "apple-device" && d.connection.webDriverAgent
      ? await this.adapters.startAppleScreen(d) : undefined;
    const capture = () => apple ? wdaScreenshot(apple) : this.preview(d, s, 0);
    // Native screenshot adapters are a compatibility fallback. Their actual
    // sampling rate remains explicit; they are never advertised as 30fps video.
    let first: Buffer;
    try { first = await capture(); }
    catch (error) { await apple?.close(); throw error; }
    const events = new EventEmitter();
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      const started = performance.now();
      try {
        const frame = await capture();
        if (!closed) events.emit("frame", frame);
      } catch (e) {
        if (!closed) events.emit("closed", (e as Error).message);
        closed = true;
        await apple?.close();
      }
      if (!closed) timer = setTimeout(() => { void sample(); }, Math.max(0, 500 - (performance.now() - started)));
    };
    timer = setTimeout(() => { void sample(); }, 500);
    return {
      first,
      fps: 2,
      onFrame: (listener) => { events.on("frame", listener); return () => { events.off("frame", listener); }; },
      onClose: (listener) => { events.on("closed", listener); return () => { events.off("closed", listener); }; },
      close: async () => { closed = true; clearTimeout(timer); events.removeAllListeners(); await apple?.close(); },
    };
  }
  async live(d: DeviceConfig | null, s: SourceConfig, profile: VideoProfile = "balanced"): Promise<LiveVideoSource> {
    const nativeIos = s.kind === "native" && d?.connection.type === "simulator" && d.connection.os === "ios";
    const physicalIos = s.kind === "native" && d?.connection.type === "apple-device" && d.connection.webDriverAgent;
    const key = `${s.kind}:${s.uniqueId ?? d?.id ?? s.id}:${profile}${nativeIos || physicalIos ? `:${JSON.stringify(d!.connection)}:${JSON.stringify(this.adapters.tool(nativeIos ? "idb" : "iproxy"))}:${this.adapters.tool("ffmpeg")}` : ""}`;
    let shared = this.liveStreams.get(key);
    if (!shared) {
      shared = {
        sourceId: s.id, users: 0, closed: false,
        source: nativeIos
          ? startIosSimulatorVideo(d, this.adapters.tool("idb"), this.adapters.tool("ffmpeg"), profile)
          : this.liveInput(d, s).then((input) => encodeLiveImages(this.adapters.tool("ffmpeg"), input, profile)),
      };
      this.liveStreams.set(key, shared);
      const entry = shared;
      void entry.source.then((video) => video.onClose(() => {
        entry.closed = true;
        if (this.liveStreams.get(key) === entry) this.liveStreams.delete(key);
      })).catch(() => {
        entry.closed = true;
        if (this.liveStreams.get(key) === entry) this.liveStreams.delete(key);
      });
    }
    const entry = shared;
    entry.users++;
    let video: LiveVideoSource;
    try { video = await entry.source; }
    catch (e) { entry.users--; throw e; }
    if (entry.closed) {
      entry.users--;
      await video.close();
      fail("capture-failed", "Live capture source closed before it became ready.", 502);
    }
    let released = false;
    const listeners = new Set<() => void>();
    const subscribe = <T>(add: (listener: (event: T) => void) => () => void, listener: (event: T) => void) => {
      if (released) return () => {};
      const off = add(listener);
      const detach = () => { off(); listeners.delete(detach); };
      listeners.add(detach);
      return detach;
    };
    return {
      get width() { return video.width; }, get height() { return video.height; }, get fps() { return video.fps; },
      onFrame: (listener) => subscribe<H264Frame>((fn) => video.onFrame(fn), listener),
      onClose: (listener) => subscribe<string>((fn) => video.onClose(fn), listener),
      close: async () => {
        if (released) return;
        released = true;
        for (const detach of listeners) detach();
        if (--entry.users === 0) {
          entry.closed = true;
          if (this.liveStreams.get(key) === entry) this.liveStreams.delete(key);
          await video.close();
        }
      },
    };
  }
  async preview(d: DeviceConfig | null, s: SourceConfig, interval = 750, closeWhenUnused = false) {
    if (s.kind !== "usb" && !d)
      fail(
        "source-missing",
        "A native screen needs its configured device.",
        404,
      );
    const key = s.kind === "usb" ? s.uniqueId! : d!.id;
    const frame = this.frames.get(key);
    if (frame && Date.now() - frame.at < interval) return frame.data;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const data = await (async () => {
          if (s.kind !== "usb") return this.adapters.screenshot(d!);
          const { stream, release } = await this.retainUsb(s);
          try { return await stream.frame(); }
          finally { await release(closeWhenUnused); }
        })();
        if (!(
          (data[0] === 137 && data.subarray(1, 4).toString() === "PNG") ||
          (data[0] === 255 && data[1] === 216)
        ))
          fail("invalid-frame", "Adapter did not return a valid image.", 502);
        this.frames.set(key, { at: Date.now(), data });
        return data;
      })();
      this.pending.set(key, pending);
      void pending.finally(() => this.pending.delete(key)).catch(() => {});
    }
    return pending;
  }
  async screenshot(d: DeviceConfig, s: SourceConfig, file: string) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const data = await this.preview(d, s, 0);
    if (data[0] === 137)
      await writeFile(file, data, { mode: 0o600, flag: "wx" });
    else {
      const p = start(this.adapters.tool("ffmpeg"), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        file,
      ]);
      p.child.stdin.end(data);
      const result = await p.completed;
      if (result.code !== 0) fail("capture-failed", p.log(), 502);
    }
    return (await stat(file)).size;
  }
  async startRecording(
    id: string,
    d: DeviceConfig,
    s: SourceConfig,
    file: string,
    _maxMinutes: number,
    onWorker?: (worker: {
      device?: DeviceConfig;
      pid?: number;
      remotePid?: string;
      remotePath?: string;
      localPath?: string;
    }) => void,
  ): Promise<RecordingHandle> {
    d = await this.adapters.verifyIdentity(d);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let handle: ProcessHandle,
      detach: (() => void) | undefined,
      finishNative: (() => Promise<void>) | undefined;
    let requestedStop = false,
      interruption: string | undefined,
      remotePid: string | undefined,
      remotePath: string | undefined,
      localPath: string | undefined;
    let startedAt = Date.now(),
      startedMono = performance.now();
    let sourceStopped: (() => void) | undefined;
    if (s.kind === "usb") {
      const { stream, release } = await this.retainUsb(s);
      let first: Buffer;
      try { first = await stream.frame(); }
      catch (e) { await release(true); throw e; }
      handle = start(this.adapters.tool("ffmpeg"), [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-use_wallclock_as_timestamps",
        "1",
        "-f",
        "image2pipe",
        "-framerate",
        "15",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        file,
      ]);
      onWorker?.({ pid: handle.child.pid, device: d });
      handle.child.stdin.write(first);
      const frame = (b: Buffer) => {
        if (
          !handle.exited() &&
          !handle.child.stdin.destroyed &&
          handle.child.stdin.writableLength < 8 * 1024 * 1024
        )
          handle.child.stdin.write(b);
      };
      sourceStopped = () => {
        interruption = stream.error || "USB source disconnected";
        handle.child.stdin.end();
        void stop(handle);
      };
      stream.on("frame", frame);
      stream.once("stopped", sourceStopped);
      detach = () => {
        stream.off("frame", frame);
        stream.off("stopped", sourceStopped!);
        void release();
      };
      try {
        await ready(handle);
      } catch (e) {
        // Encoder startup failed too: do not leave its unused camera capturing.
        await release(true);
        detach();
        await stop(handle);
        throw e;
      }
    } else if (d.connection.type === "simulator") {
      const directory = await mkdtemp(path.join(os.tmpdir(), "device-deck-recording-"));
      const recording = path.join(directory, "recording.mp4");
      localPath = recording;
      handle = start("xcrun", [
        "simctl",
        "io",
        d.connection.udid,
        "recordVideo",
        "--codec=h264",
        ...(d.connection.os === "tvos" ? ["--display=external"] : []),
        recording,
      ]);
      try {
        onWorker?.({ pid: handle.child.pid, device: d, localPath });
        await ready(handle, /Recording started/i, 30000);
      } catch (error) {
        await stop(handle);
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      finishNative = async () => {
        try {
          handle.child.stdin.end();
          await stop(handle);
          await copyFile(recording, file, constants.COPYFILE_EXCL);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      };
      startedAt = Date.now();
      startedMono = performance.now();
    } else if (d.connection.type === "adb") {
      remotePath = `/data/local/tmp/device-deck-${id}.mp4`;
      handle = start(this.adapters.tool("adb"), [
        ...this.adapters.adb(d),
        "shell",
        `screenrecord --time-limit 180 ${remotePath} & child=$!; echo DEVICE_DECK_PID:$child; wait $child`,
      ]);
      onWorker?.({ pid: handle.child.pid, remotePath, device: d });
      await ready(handle);
      remotePid = /DEVICE_DECK_PID:(\d+)/.exec(handle.output())?.[1];
      if (!remotePid) {
        await stop(handle);
        fail(
          "capture-failed",
          "Android did not return the owned recording PID.",
          502,
        );
      }
      onWorker?.({ pid: handle.child.pid, remotePid, remotePath, device: d });
      const pid = remotePid,
        remote = remotePath;
      finishNative = async () => {
        await this.adapters.verifyCaptureTransport(d);
        // Verify both executable and this recording's UUID path before signalling a remote PID.
        try {
          const cmd = (
            await run(this.adapters.tool("adb"), [
              ...this.adapters.adb(d),
              "shell",
              "cat",
              `/proc/${pid}/cmdline`,
            ])
          ).stdout
            .toString()
            .split("\0");
          if (cmd[0]?.endsWith("screenrecord") && cmd.includes(remote))
            await run(this.adapters.tool("adb"), [
              ...this.adapters.adb(d),
              "shell",
              "kill",
              "-2",
              pid,
            ]);
        } catch (e) {
          if (!handle.exited())
            interruption = `Android recorder disconnected: ${(e as Error).message}`;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            handle.completed,
            new Promise(
              (_, reject) =>
                (timer = setTimeout(
                  () => reject(new Error("Android recording did not finalize")),
                  10000,
                )),
            ),
          ]);
        } finally {
          clearTimeout(timer);
          if (!handle.exited()) await stop(handle);
        }
        await this.adapters.verifyCaptureTransport(d);
        await run(
          this.adapters.tool("adb"),
          [...this.adapters.adb(d), "pull", remote, file],
          30000,
        );
        await this.adapters.verifyCaptureTransport(d);
        await run(this.adapters.tool("adb"), [
          ...this.adapters.adb(d),
          "shell",
          "rm",
          remote,
        ]);
      };
    } else fail("unsupported-capability", "This source cannot record.");
    const ended = handle.completed.then((result) => {
      if (!requestedStop && !interruption)
        interruption =
          d.connection.type === "adb"
            ? "Android recorder exited or reached its 180-second limit."
            : `Recorder exited unexpectedly. ${handle.log()}`;
      if (result.signal === "SIGKILL")
        interruption = "Recorder required a forced stop.";
      detach?.();
      return interruption;
    });
    let final:
      | Promise<{ duration: number; bytes: number; interruption?: string }>
      | undefined;
    return {
      id,
      device: d,
      deviceId: d.id,
      path: file,
      startedAt,
      startedMono,
      pid: handle.child.pid,
      remotePid,
      remotePath,
      localPath,
      ended,
      stop: () =>
        (final ??= (async () => {
          requestedStop = true;
          const stoppedMono = performance.now();
          detach?.();
          try {
            if (finishNative) await finishNative();
            else {
              handle.child.stdin.end();
              await stop(handle);
            }
            await ended;
          } finally {
            if (!handle.exited()) await stop(handle);
          }
          const nativeScreen =
            s.kind === "native" &&
            ["simulator", "adb"].includes(d.connection.type);
          let metadata = await this.probe(file, nativeScreen);
          // Native recorders emit frames on screen changes. Repeat the last real frame through stop time.
          const wallSeconds = Math.max(0.1, (stoppedMono - startedMono) / 1000);
          if (nativeScreen && metadata.duration < wallSeconds - 0.15) {
            const padded = file + ".timed.mp4";
            try {
              await run(
                this.adapters.tool("ffmpeg"),
                [
                  "-hide_banner",
                  "-loglevel",
                  "error",
                  // Android can mux one static frame with zero duration. Give that frame a timebase.
                  ...(metadata.duration === 0 ? ["-r", "30"] : []),
                  "-i",
                  file,
                  "-an",
                  "-vf",
                  `tpad=stop_mode=clone:stop_duration=${wallSeconds},fps=30`,
                  "-t",
                  String(wallSeconds),
                  "-c:v",
                  "libx264",
                  "-preset",
                  "ultrafast",
                  "-pix_fmt",
                  "yuv420p",
                  "-movflags",
                  "+faststart",
                  padded,
                ],
                120000,
              );
              await rename(padded, file);
              metadata = await this.probe(file);
            } finally {
              await rm(padded, { force: true });
            }
          }
          return { ...metadata, interruption };
        })()),
    };
  }
  async probe(file: string, allowSingleFrame = false) {
    const info = JSON.parse(
      (
        await run(
          this.adapters.tool("ffprobe"),
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,nb_frames",
            "-of",
            "json",
            file,
          ],
          20000,
        )
      ).stdout.toString(),
    );
    if (info.streams?.some((s: any) => s.codec_type === "audio"))
      fail("unexpected-audio", "Recording contains audio; Device Deck requires video-only recordings.", 502);
    let duration = Number(info.format?.duration);
    if (
      allowSingleFrame &&
      (!Number.isFinite(duration) || duration <= 0) &&
      info.streams?.some(
        (s: any) => s.codec_type === "video" && Number(s.nb_frames) === 1,
      )
    )
      duration = 0;
    if (
      !Number.isFinite(duration) ||
      (duration <= 0 && !(allowSingleFrame && duration === 0)) ||
      !info.streams?.some((s: any) => s.codec_type === "video")
    )
      fail("invalid-video", "Recording is not a playable video.", 502);
    return { duration, bytes: (await stat(file)).size };
  }
  async annotate(
    file: string,
    out: string,
    inputs: Input[],
    deviceName: string,
    sessionId: string,
    kind: "screenshot" | "recording",
  ) {
    const escape = (s: string) =>
      s
        .replaceAll("\\", "\\\\")
        .replaceAll("{", "\\{")
        .replaceAll("}", "\\}")
        .replaceAll("\n", " ");
    const time = (ms: number) => {
      const cs = Math.max(0, Math.round(ms / 10));
      return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
    };
    const ass =
      `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Helvetica,26,&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,2,0,3,25,25,25,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
      inputs
        .map(
          (i) =>
            `Dialogue: 0,${time(kind === "screenshot" ? 0 : i.elapsedMs || 0)},${time(kind === "screenshot" ? 10000 : (i.elapsedMs || 0) + 1500)},Default,,0,0,0,,${escape(deviceName)} · ${escape(sessionId.slice(0, 8))}\\N${escape(i.key)}\n`,
        )
        .join("");
    const subtitles = path.join(
      path.dirname(file),
      `annotation-${path.basename(file)}.ass`,
    );
    await writeFile(subtitles, ass, { mode: 0o600 });
    await run(
      this.adapters.tool("ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-an",
        "-vf",
        `ass=filename=${path.basename(subtitles)}`,
        ...(kind === "screenshot"
          ? ["-frames:v", "1"]
          : [
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-movflags",
              "+faststart",
            ]),
        out,
      ],
      120000,
      { cwd: path.dirname(file) },
    );
  }
  async clipboard(file: string) {
    await run(this.cameraHelper, ["clipboard", file]);
  }
  async closeSource(s: SourceConfig) {
    const usb = s.kind === "usb" && s.uniqueId ? this.streams.get(s.uniqueId) : undefined;
    const closingUsb = usb ? this.closeUsb(s.uniqueId!, usb) : Promise.resolve();
    const live = [...this.liveStreams.entries()].filter(([, entry]) => entry.sourceId === s.id);
    for (const [key, entry] of live) {
      entry.closed = true;
      this.liveStreams.delete(key);
    }
    await Promise.allSettled(live.map(async ([, entry]) => (await entry.source).close()));
    await closingUsb;
    if (s.kind === "usb" && s.uniqueId) {
      this.frames.delete(s.uniqueId);
    }
    if (s.deviceId) this.frames.delete(s.deviceId);
  }
  async close() {
    this.closed = true;
    const closingUsb = Promise.all([...this.streams.entries()].map(([id, stream]) => this.closeUsb(id, stream)));
    const live = [...this.liveStreams.values()];
    this.liveStreams.clear();
    for (const entry of live) entry.closed = true;
    await Promise.allSettled(live.map(async (entry) => (await entry.source).close()));
    await closingUsb;
    this.frames.clear();
  }
}
