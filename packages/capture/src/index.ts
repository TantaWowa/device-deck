import { EventEmitter } from "node:events";
import { writeFile, readFile, mkdir, stat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
  id: string;
  deviceId: string;
  path: string;
  startedAt: number;
  startedMono: number;
  pid?: number;
  remotePid?: string;
  remotePath?: string;
  ended: Promise<string | undefined>;
  stop: () => Promise<{
    duration: number;
    bytes: number;
    interruption?: string;
  }>;
};
class UsbStream extends EventEmitter {
  handle: ProcessHandle;
  latest?: Buffer;
  buffer = Buffer.alloc(0);
  error = "";
  constructor(id: string, cameraHelper: string) {
    super();
    this.handle = start(cameraHelper, ["stream", id]);
    this.handle.child.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 32 * 1024 * 1024) {
        this.error = "Invalid capture stream";
        this.buffer = Buffer.alloc(0);
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
    });
    void this.handle.completed.then(() => {
      this.error = this.handle.log() || "USB capture source disconnected";
      this.emit("stopped");
    });
  }
  async frame() {
    if (this.latest && !this.error) return this.latest;
    return new Promise<Buffer>((resolve, reject) => {
      const done = (buffer?: Buffer) => {
        clearTimeout(timer);
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
      const timer = setTimeout(onStop, 12000);
      this.once("frame", onFrame);
      this.once("stopped", onStop);
    });
  }
  async close() {
    await stop(this.handle);
    this.removeAllListeners();
  }
}
export class CaptureEngine {
  private streams = new Map<string, UsbStream>();
  private frames = new Map<string, { at: number; data: Buffer }>();
  private pending = new Map<string, Promise<Buffer>>();
  constructor(
    readonly adapters: Adapters,
    readonly cameraHelper = helper,
  ) {}
  private usb(s: SourceConfig) {
    if (!s.uniqueId) fail("source-missing", "USB source has no stable ID.");
    let stream = this.streams.get(s.uniqueId);
    if (!stream || stream.error) {
      stream = new UsbStream(s.uniqueId, this.cameraHelper);
      this.streams.set(s.uniqueId, stream);
    }
    return stream;
  }
  async preview(d: DeviceConfig | null, s: SourceConfig, interval = 750) {
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
        const data =
          s.kind === "usb"
            ? await this.usb(s).frame()
            : await this.adapters.screenshot(d!);
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
      pid?: number;
      remotePid?: string;
      remotePath?: string;
    }) => void,
  ): Promise<RecordingHandle> {
    await this.adapters.verifyIdentity(d);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let handle: ProcessHandle,
      detach: (() => void) | undefined,
      finishNative: (() => Promise<void>) | undefined;
    let requestedStop = false,
      interruption: string | undefined,
      remotePid: string | undefined,
      remotePath: string | undefined;
    let startedAt = Date.now(),
      startedMono = performance.now();
    let sourceStopped: (() => void) | undefined;
    if (s.kind === "usb") {
      const stream = this.usb(s);
      const first = await stream.frame();
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
      onWorker?.({ pid: handle.child.pid });
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
      };
      try {
        await ready(handle);
      } catch (e) {
        detach();
        await stop(handle);
        throw e;
      }
    } else if (d.connection.type === "simulator") {
      handle = start("xcrun", [
        "simctl",
        "io",
        d.connection.udid,
        "recordVideo",
        "--codec=h264",
        ...(d.connection.os === "tvos" ? ["--display=external"] : []),
        file,
      ]);
      onWorker?.({ pid: handle.child.pid });
      await ready(handle, /Recording started/i, 30000);
      startedAt = Date.now();
      startedMono = performance.now();
    } else if (d.connection.type === "adb") {
      remotePath = `/data/local/tmp/device-deck-${id}.mp4`;
      handle = start(this.adapters.tool("adb"), [
        ...this.adapters.adb(d),
        "shell",
        `screenrecord --time-limit 180 ${remotePath} & child=$!; echo DEVICE_DECK_PID:$child; wait $child`,
      ]);
      onWorker?.({ pid: handle.child.pid, remotePath });
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
      onWorker?.({ pid: handle.child.pid, remotePid, remotePath });
      const pid = remotePid,
        remote = remotePath;
      finishNative = async () => {
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
        await run(
          this.adapters.tool("adb"),
          [...this.adapters.adb(d), "pull", remote, file],
          30000,
        );
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
      deviceId: d.id,
      path: file,
      startedAt,
      startedMono,
      pid: handle.child.pid,
      remotePid,
      remotePath,
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
        "-vf",
        `ass=filename=${path.basename(subtitles)}`,
        ...(kind === "screenshot"
          ? ["-frames:v", "1"]
          : [
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-c:a",
              "copy",
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
    if (s.kind === "usb" && s.uniqueId) {
      const stream = this.streams.get(s.uniqueId);
      if (stream) {
        await stream.close();
        this.streams.delete(s.uniqueId);
      }
      this.frames.delete(s.uniqueId);
    }
    if (s.deviceId) this.frames.delete(s.deviceId);
  }
  async close() {
    await Promise.all([...this.streams.values()].map((s) => s.close()));
    this.streams.clear();
  }
}
