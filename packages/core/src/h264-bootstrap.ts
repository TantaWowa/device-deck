import type { H264Frame } from "./live";

/** A complete, bounded decoder bootstrap. An IDR alone is insufficient once
 * dependent delta frames have already passed; replay the entire current GOP. */
export class H264GopBuffer {
  private config: H264Frame[] = [];
  private frames: H264Frame[] = [];
  private bytes = 0;
  constructor(private maxBytes = 4 * 1024 * 1024, private maxFrames = 120) {}
  reset() { this.config = []; this.frames = []; this.bytes = 0; }
  push(frame: H264Frame, configuration = false) {
    if (configuration) {
      // Some codecs split their SPS and PPS. Keep a small number of config
      // packets, but invalidate the old GOP whenever configuration changes.
      this.config = [...this.config, frame].slice(-4);
      this.frames = []; this.bytes = 0;
      return;
    }
    if (frame.keyframe) { this.frames = []; this.bytes = 0; }
    else if (!this.frames.length) return;
    if (this.bytes + frame.data.length > this.maxBytes || this.frames.length >= this.maxFrames) {
      this.frames = []; this.bytes = 0;
      return; // Wait for a new IDR rather than replaying an incomplete dependency chain.
    }
    this.frames.push(frame); this.bytes += frame.data.length;
  }
  replay(listener: (frame: H264Frame) => void) {
    for (const frame of this.config) listener(frame);
    for (const frame of this.frames) listener(frame);
  }
}
