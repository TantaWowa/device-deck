import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { videoProfiles, type H264Frame, type LiveVideoSource, type VideoProfile } from "../../core/src/live";
import { start, stop, type ProcessHandle } from "../../adapters/src/process";
import { annexB, H264AccessUnitParser, h264Keyframe, h264Nals } from "./h264";

export type ImageVideoInput = {
  first: Buffer;
  fps: number;
  onFrame(listener: (frame: Buffer) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
};

/** Inspect the already captured image instead of opening the camera a second time. */
function imageSize(data: Buffer) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data[0] === 255 && data[1] === 216) {
    for (let offset = 2; offset + 4 < data.length;) {
      if (data[offset++] !== 255) continue;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > data.length) break;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7)
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      offset += size;
    }
  }
  throw new Error("Live capture did not return a valid PNG or JPEG image.");
}

class ImageVideoEncoder implements LiveVideoSource {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private readonly inputSize: { width: number; height: number };
  private readonly events = new EventEmitter();
  private handle?: ProcessHandle;
  private detach: (() => void)[] = [];
  private stopped?: string;
  private closing?: Promise<void>;
  private ready = false;
  private parameters?: Buffer;
  constructor(private ffmpeg: string, private input: ImageVideoInput, private profile: VideoProfile) {
    const size = imageSize(input.first), settings = videoProfiles[profile];
    this.inputSize = size;
    // Avoid upscaling; portrait/tablet frames must also fit level 3.1's 3600
    // macroblocks, rather than only constraining a landscape-oriented width.
    let ratio = Math.min(1, settings.width / Math.max(size.width, size.height), Math.sqrt(921_600 / (size.width * size.height)));
    let width: number, height: number;
    do {
      width = Math.max(2, Math.floor(size.width * ratio / 2) * 2);
      height = Math.max(2, Math.floor(size.height * ratio / 2) * 2);
      ratio *= 0.995;
    } while (Math.ceil(width / 16) * Math.ceil(height / 16) > 3600);
    this.width = width;
    this.height = height;
    this.fps = Math.min(input.fps, settings.fps);
    this.events.setMaxListeners(0);
  }
  async start() {
    const encoders = process.platform === "darwin" ? ["h264_videotoolbox", "libx264"] : ["libx264"];
    let error: unknown;
    for (const encoder of encoders) {
      try {
        await this.attempt(encoder);
        this.ready = true;
        return this;
      } catch (e) {
        error = e;
        this.detach.splice(0).forEach((detach) => detach());
        if (this.handle) {
          this.handle.child.stdin.end();
          await stop(this.handle);
        }
        if (this.stopped) break;
      }
    }
    await this.close();
    throw error;
  }
  private attempt(encoder: string) {
    const settings = videoProfiles[this.profile];
    const handle = this.handle = start(this.ffmpeg, [
      "-hide_banner", "-loglevel", "warning",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "mpjpeg", "-r", String(this.fps), "-threads", "1",
      "-c:v", this.input.first[0] === 137 ? "png" : "mjpeg", "-i", "pipe:0",
      "-an", "-vf", `scale=${this.width}:${this.height}`, "-pix_fmt", "yuv420p",
      "-c:v", encoder,
      ...(encoder === "libx264"
        ? ["-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "repeat-headers=1:scenecut=0"]
        : ["-realtime", "1", "-flags", "+low_delay", "-allow_sw", "1"]),
      "-profile:v", encoder === "h264_videotoolbox" ? "constrained_baseline" : "baseline",
      "-level:v", "3.1", "-bf", "0", "-g", String(Math.max(1, Math.round(this.fps))),
      "-b:v", String(settings.bitrate), "-maxrate", String(settings.bitrate),
      "-bufsize", String(Math.round(settings.bitrate / 2)),
      "-bsf:v", "h264_metadata=aud=insert", "-flush_packets", "1", "-f", "h264", "pipe:1",
    ]);
    const parser = new H264AccessUnitParser(), timestamps: bigint[] = [];
    let nextInput = -Infinity, lastTimestamp = 0n, settled = false;
    return new Promise<void>((resolve, reject) => {
      const finish = (reason: string) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(reason)); }
        else if (this.ready) void this.shutdown(reason);
      };
      // Some hardware encoders buffer multiple frames despite realtime mode.
      // Prefer the bounded, zero-latency software path when that happens.
      const timeout = setTimeout(() => finish(handle.log() || "Live video encoder did not produce a keyframe."), encoder === "h264_videotoolbox" ? 1500 : 5000);
      const send = (image: Buffer) => {
        const now = performance.now();
        if (this.stopped || handle.exited() || handle.child.stdin.destroyed ||
          now < nextInput - 3 || handle.child.stdin.writableLength > 0 || timestamps.length >= 4) return;
        try {
          const size = imageSize(image);
          if (size.width !== this.inputSize.width || size.height !== this.inputSize.height) {
            finish("Capture dimensions changed. Reconnect the viewer to use the new orientation.");
            return;
          }
        } catch (e) { finish((e as Error).message); return; }
        nextInput = Number.isFinite(nextInput) ? Math.max(nextInput + 1000 / this.fps, now) : now + 1000 / this.fps;
        timestamps.push(BigInt(Math.round(now * 1000)));
        // image2pipe buffers 4096 bytes before yielding, stalling tiny/static
        // images. Multipart Content-Length keeps each captured image atomic.
        // mpjpeg requires this MIME header; the explicit input decoder above
        // selects PNG for screenshot adapters using the same internal framing.
        handle.child.stdin.write(Buffer.concat([
          Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`),
          image, Buffer.from("\r\n"),
        ]));
      };
      const output = (chunk: Buffer) => {
        try {
          for (const data of parser.push(chunk)) {
            const timestampUs = timestamps.shift() ?? lastTimestamp + BigInt(Math.round(1_000_000 / this.fps));
            lastTimestamp = timestampUs;
            const keyframe = h264Keyframe(data);
            const parameters = h264Nals(data).filter((nal) => [7, 8].includes(nal[0] & 31));
            if (parameters.some((nal) => (nal[0] & 31) === 7) && parameters.some((nal) => (nal[0] & 31) === 8))
              this.parameters = annexB(parameters);
            if (keyframe && !settled) { settled = true; clearTimeout(timeout); resolve(); }
            this.events.emit("frame", { data, timestampUs, keyframe } satisfies H264Frame);
          }
        } catch (e) { finish((e as Error).message); }
      };
      handle.child.stdout.on("data", output);
      this.detach.push(() => { clearTimeout(timeout); handle.child.stdout.off("data", output); });
      this.detach.push(this.input.onFrame(send), this.input.onClose(finish));
      void handle.completed.then(() => finish(handle.log() || "Live video encoder stopped."));
      send(this.input.first);
    });
  }
  onFrame(listener: (frame: H264Frame) => void) {
    this.events.on("frame", listener);
    // Configuration is safe to replay. Replaying an old IDR while skipping its
    // dependent frames would corrupt decoding, so viewers await the next IDR.
    if (this.parameters) listener({ data: this.parameters, timestampUs: 0n, keyframe: false });
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
      this.events.emit("closed", reason);
      this.events.removeAllListeners();
      if (this.handle) {
        this.handle.child.stdin.end();
        await stop(this.handle);
      }
      await this.input.close();
    })();
  }
  close() { return this.shutdown("Live video closed."); }
}

export async function encodeLiveImages(ffmpeg: string, input: ImageVideoInput, profile: VideoProfile) {
  let encoder: ImageVideoEncoder;
  try { encoder = new ImageVideoEncoder(ffmpeg, input, profile); }
  catch (e) { await input.close(); throw e; }
  return encoder.start();
}
