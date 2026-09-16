import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { DeckError, type DeviceConfig } from "../../core/src/local/types";
import { videoProfiles, type H264Frame, type LiveVideoSource, type VideoProfile } from "../../core/src/live";
import { H264GopBuffer } from "../../core/src/h264-bootstrap";
import { available, run, start, stop, type ProcessHandle } from "../../adapters/src/process";
import { annexB, H264AccessUnitParser, h264Keyframe, h264Nals } from "./h264";

type Size = { width: number; height: number };

/** Read H.264 SPS geometry, including crop and High-profile scaling matrices. */
export function h264Size(nal: Buffer): Size {
  if ((nal[0] & 31) !== 7) throw new Error("Expected an H264 sequence parameter set.");
  const bytes: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i > 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    bytes.push(nal[i]);
  }
  let offset = 0;
  const bits = (count: number): number => {
    if (count > 32 || offset + count > bytes.length * 8) throw new Error("Truncated H264 sequence parameter set.");
    let value = 0;
    while (count--) { value = value * 2 + ((bytes[offset >> 3] >> (7 - (offset & 7))) & 1); offset++; }
    return value;
  };
  const ue = (): number => {
    let zeros = 0;
    while (!bits(1)) if (++zeros > 24) throw new Error("Invalid H264 sequence parameter set.");
    return 2 ** zeros - 1 + bits(zeros);
  };
  const se = () => { const value = ue(); return value & 1 ? (value + 1) / 2 : -value / 2; };
  const profile = bits(8); bits(16); ue();
  let chroma = 1, separate = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma > 3) throw new Error("Invalid H264 colour format.");
    if (chroma === 3) separate = bits(1);
    ue(); ue(); bits(1);
    if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bits(1)) {
      let last = 8, next = 8;
      for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
        if (next) next = (last + se() + 256) % 256;
        last = next || last;
      }
    }
  }
  ue();
  const order = ue();
  if (order === 0) ue();
  else if (order === 1) {
    bits(1); se(); se();
    const cycle = ue();
    if (cycle > 256) throw new Error("Invalid H264 picture order cycle.");
    for (let i = 0; i < cycle; i++) se();
  } else if (order !== 2) throw new Error("Invalid H264 picture order mode.");
  ue(); bits(1);
  const columns = ue() + 1, rows = ue() + 1, progressive = bits(1);
  if (!progressive) bits(1);
  bits(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
  const format = separate ? 0 : chroma;
  const cropX = format === 1 || format === 2 ? 2 : 1;
  const cropY = (format === 1 ? 2 : 1) * (2 - progressive);
  const width = columns * 16 - (left + right) * cropX;
  const height = rows * 16 * (2 - progressive) - (top + bottom) * cropY;
  if (width < 2 || height < 2 || width > 16384 || height > 16384) throw new Error("Invalid H264 screen dimensions.");
  return { width, height };
}

function simulatorSize(json: string, udid: string): Size {
  const target = JSON.parse(json);
  if (target.udid !== udid || target.target_type !== "simulator")
    throw new DeckError("identity-mismatch", "idb returned a different simulator identity.", 409);
  if (String(target.state).toLowerCase() !== "booted")
    throw new DeckError("device-offline", "Boot the iOS simulator before opening live video.", 409);
  const { width, height } = target.screen_dimensions ?? {};
  if (![width, height].every((n) => Number.isInteger(n) && n >= 2 && n <= 16384))
    throw new DeckError("missing-helper", "idb did not report the simulator screen dimensions. Update idb and idb_companion together.", 503);
  return { width, height };
}

function scaleFactor(size: Size, profile: VideoProfile) {
  // Level 3.1 permits 3600 macroblocks. Bound portrait/tablet area as well as
  // its longest edge; native idb capture is scaled before crossing the pipe.
  let factor = Math.min(1, videoProfiles[profile].width / Math.max(size.width, size.height));
  while (Math.ceil(size.width * factor / 16) * Math.ceil(size.height * factor / 16) > 3600) factor *= 0.995;
  return factor;
}

class IosSimulatorVideo implements LiveVideoSource {
  width = 0;
  height = 0;
  readonly fps: number;
  private events = new EventEmitter();
  private handles: ProcessHandle[] = [];
  private detach: (() => void)[] = [];
  private closing?: Promise<void>;
  private stopped?: string;
  private parameters?: Buffer;
  private bootstrap = new H264GopBuffer();
  constructor(private udid: string, private idb: string, private ffmpeg: string, private profile: VideoProfile, private size: Size) {
    this.fps = videoProfiles[profile].fps;
    this.events.setMaxListeners(0);
  }
  async start(): Promise<LiveVideoSource> {
    const settings = videoProfiles[this.profile];
    const encoder = start(this.ffmpeg, [
      "-hide_banner", "-loglevel", "warning", "-probesize", "32", "-analyzeduration", "0",
      "-flags", "low_delay", "-f", "h264", "-r", String(this.fps), "-i", "pipe:0",
      "-an", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
      // idb emits High-profile video. Normalize the native video stream to the
      // browser's negotiated Baseline 3.1 without capturing any screenshots.
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-x264-params", "repeat-headers=1:scenecut=0", "-profile:v", "baseline", "-level:v", "3.1",
      "-bf", "0", "-g", String(this.fps), "-b:v", String(settings.bitrate),
      "-maxrate", String(settings.bitrate), "-bufsize", String(Math.round(settings.bitrate / 2)),
      "-bsf:v", "h264_metadata=aud=insert", "-flush_packets", "1", "-f", "h264", "pipe:1",
    ]);
    const capture = start(this.idb, [
      "video-stream", "--format", "h264", "--fps", String(this.fps),
      "--scale-factor", String(scaleFactor(this.size, this.profile)), "--udid", this.udid,
    ], { env: { PYTHONUNBUFFERED: "1" } });
    this.handles = [capture, encoder];
    try {
      await new Promise<void>((resolve, reject) => {
        const parser = new H264AccessUnitParser();
        let nativeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0), nativeSize: Size | undefined;
        let settled = false, frames = 0, origin: bigint | undefined;
        const fail = (reason: string) => {
          if (!settled) { settled = true; reject(new Error(reason)); }
          void this.shutdown(reason);
        };
        const timeout = setTimeout(() => fail("iOS native video did not produce a keyframe within 10 seconds."), 10000);
        this.detach.push(() => clearTimeout(timeout));
        // Observe native SPS changes before ffmpeg can distort a rotated frame
        // into its original encoder geometry. Reconnect with truthful dimensions.
        const native = (chunk: Buffer) => {
          try {
            nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
            if (nativeBuffer.length > 8 * 1024 * 1024) throw new Error("iOS native video exceeded the maximum NAL size.");
            let last = -1;
            for (let i = 0; i + 3 < nativeBuffer.length; i++) {
              if (nativeBuffer[i] || nativeBuffer[i + 1]) continue;
              const prefix = nativeBuffer[i + 2] === 1 ? 3 : nativeBuffer[i + 2] === 0 && nativeBuffer[i + 3] === 1 ? 4 : 0;
              if (!prefix || i + prefix >= nativeBuffer.length) continue;
              if (last >= 0 && (nativeBuffer[last] & 31) === 7) {
                const size = h264Size(nativeBuffer.subarray(last, i));
                if (nativeSize && (size.width !== nativeSize.width || size.height !== nativeSize.height))
                  throw new Error("Simulator screen dimensions changed. Reconnect the viewer to use the new orientation.");
                nativeSize = size;
              }
              last = i + prefix;
              i += prefix - 1;
            }
            if (last >= 0) nativeBuffer = Buffer.concat([Buffer.from([0, 0, 0, 1]), nativeBuffer.subarray(last)]);
          } catch (e) { fail((e as Error).message); }
        };
        const output = (chunk: Buffer) => {
          try {
            for (const data of parser.push(chunk)) {
              if (this.stopped) return;
              const nals = h264Nals(data), sps = nals.find((nal) => (nal[0] & 31) === 7);
              if (sps) {
                const size = h264Size(sps);
                if (this.width && (size.width !== this.width || size.height !== this.height))
                  throw new Error("Simulator screen dimensions changed. Reconnect the viewer to use the new orientation.");
                if (Math.ceil(size.width / 16) * Math.ceil(size.height / 16) > 3600 || Math.max(size.width, size.height) > settings.width)
                  throw new Error("iOS native video exceeds the selected streaming profile.");
                this.width = size.width; this.height = size.height;
              }
              const parameters = nals.filter((nal) => [7, 8].includes(nal[0] & 31));
              if (parameters.some((nal) => (nal[0] & 31) === 7) && parameters.some((nal) => (nal[0] & 31) === 8)) this.parameters = annexB(parameters);
              origin ??= BigInt(Math.round(performance.now() * 1000));
              const frame = { data, timestampUs: origin + BigInt(Math.round(frames++ * 1_000_000 / this.fps)), keyframe: h264Keyframe(data) };
              this.bootstrap.push(frame);
              if (!settled && frame.keyframe && this.width && this.parameters) { settled = true; clearTimeout(timeout); resolve(); }
              this.events.emit("frame", frame);
            }
          } catch (e) { fail((e as Error).message); }
        };
        capture.child.stdout.on("data", native);
        encoder.child.stdout.on("data", output);
        capture.child.stdout.pipe(encoder.child.stdin);
        this.detach.push(() => {
          capture.child.stdout.off("data", native);
          encoder.child.stdout.off("data", output);
          capture.child.stdout.unpipe(encoder.child.stdin);
        });
        void capture.completed.then(() => { if (!this.stopped) fail(capture.log() || "iOS native video capture stopped."); });
        void encoder.completed.then(() => { if (!this.stopped) fail(encoder.log() || "iOS native video encoder stopped."); });
      });
      if (this.stopped) throw new Error(this.stopped);
      return this;
    } catch (e) { await this.shutdown((e as Error).message); throw e; }
  }
  onFrame(listener: (frame: H264Frame) => void) {
    this.events.on("frame", listener);
    if (this.parameters) listener({ data: this.parameters, timestampUs: 0n, keyframe: false });
    this.bootstrap.replay(listener);
    return () => { this.events.off("frame", listener); };
  }
  onClose(listener: (reason: string) => void) {
    if (this.stopped) {
      let active = true;
      queueMicrotask(() => { if (active) listener(this.stopped!); });
      return () => { active = false; };
    }
    this.events.on("closed", listener);
    return () => { this.events.off("closed", listener); };
  }
  private shutdown(reason: string) {
    return this.closing ??= (async () => {
      this.stopped = reason;
      this.detach.splice(0).forEach((detach) => detach());
      this.events.emit("closed", reason); this.events.removeAllListeners();
      this.parameters = undefined; this.bootstrap.reset();
      for (const handle of this.handles) handle.child.stdin.end();
      await Promise.all(this.handles.map((handle) => stop(handle)));
    })();
  }
  close() { return this.shutdown("iOS native video closed."); }
}

export async function startIosSimulatorVideo(
  device: DeviceConfig, idb: string, ffmpeg: string, profile: VideoProfile,
  execute = run, hasTool = available,
): Promise<LiveVideoSource> {
  const connection = device.connection;
  if (connection.type !== "simulator" || connection.os !== "ios")
    throw new DeckError("unsupported-capability", "Native simulator video requires an iOS simulator.");
  if (!(await hasTool(idb)) || !(await hasTool("idb_companion")) || !(await hasTool(ffmpeg)))
    throw new DeckError("missing-helper", "iOS simulator live video requires idb, idb_companion and ffmpeg. Install the helpers and configure their paths in Settings.", 503);
  const size = simulatorSize((await execute(idb, ["describe", "--udid", connection.udid, "--json"])).stdout.toString(), connection.udid);
  return new IosSimulatorVideo(connection.udid, idb, ffmpeg, profile, size).start();
}
