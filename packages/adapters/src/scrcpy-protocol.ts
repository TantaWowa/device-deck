import type { H264Frame, PointerInput } from "../../core/src/live";
import { DeckError } from "../../core/src/local/types";

// scrcpy 4.1: Streamer.java and app/src/control_msg.c. This internal wire
// protocol must only be used with the exact bundled server version.
export const SCRCPY_VERSION = "4.1";
export const SCRCPY_SHA256 =
  "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
const MAX_PACKET = 8 * 1024 * 1024;
export class ScrcpyVideoParser {
  private buffer: Buffer = Buffer.alloc(0);
  private codec = false;
  constructor(
    private session: (width: number, height: number) => void,
    private frame: (frame: H264Frame, configuration: boolean) => void,
  ) {}
  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.codec) {
      if (this.buffer.length < 4) return;
      if (this.buffer.readUInt32BE(0) !== 0x68323634)
        throw new Error("scrcpy did not provide an H.264 video stream.");
      this.codec = true;
      this.buffer = this.buffer.subarray(4);
    }
    while (this.buffer.length >= 12) {
      if (this.buffer[0] & 0x80) {
        const width = this.buffer.readUInt32BE(4);
        const height = this.buffer.readUInt32BE(8);
        if (!width || !height || width > 65535 || height > 65535)
          throw new Error("Invalid scrcpy video dimensions.");
        this.buffer = this.buffer.subarray(12);
        this.session(width, height);
        continue;
      }
      const flags = this.buffer.readBigUInt64BE(0);
      const size = this.buffer.readUInt32BE(8);
      if (!size || size > MAX_PACKET)
        throw new Error("Invalid scrcpy video packet size.");
      if (this.buffer.length < 12 + size) return;
      const data = Buffer.from(this.buffer.subarray(12, 12 + size));
      this.buffer = this.buffer.subarray(12 + size);
      this.frame({
        data,
        timestampUs: flags & ((1n << 61n) - 1n),
        keyframe: Boolean(flags & (1n << 61n)),
      }, Boolean(flags & (1n << 62n)));
    }
  }
}

export function validatePoint(point: { x: number; y: number; width: number; height: number }) {
  const { x, y, width, height } = point;
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 || width > 65535 || height > 65535 ||
    !Number.isFinite(x) || !Number.isFinite(y) ||
    x < 0 || y < 0 || x >= width || y >= height
  ) throw new DeckError("invalid-input", "Touch coordinates must lie inside the current video frame.", 400);
}

export function touchPacket(event: PointerInput, action: number): Buffer {
  validatePoint(event);
  if (!Number.isSafeInteger(event.contactId) || event.contactId < 0)
    throw new DeckError("invalid-input", "Invalid touch contact ID.", 400);
  const bytes = Buffer.alloc(32);
  bytes[0] = 2; // INJECT_TOUCH_EVENT
  bytes[1] = action;
  bytes.writeBigUInt64BE(BigInt(event.contactId), 2);
  bytes.writeUInt32BE(Math.min(event.width - 1, Math.round(event.x)), 10);
  bytes.writeUInt32BE(Math.min(event.height - 1, Math.round(event.y)), 14);
  bytes.writeUInt16BE(event.width, 18);
  bytes.writeUInt16BE(event.height, 20);
  bytes.writeUInt16BE(action === 1 || action === 3 ? 0 : 0xffff, 22);
  // Finger messages always use zero action_button and buttons.
  return bytes;
}

export class ScrcpyTouch {
  private contacts = new Map<number, PointerInput>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private write: (packet: Buffer) => Promise<void>) {}
  get activeContacts() { return this.contacts.size; }
  pointer(event: PointerInput): Promise<void> {
    return this.enqueue(async () => {
      if (event.type === "cancel") return this.cancelNow();
      validatePoint(event);
      const active = this.contacts.has(event.contactId);
      if (event.type === "down" && (active || this.contacts.size >= 10))
        throw new DeckError("invalid-input", "Touch contact is already active or the ten-contact limit was reached.", 409);
      if (event.type !== "down" && !active)
        throw new DeckError("invalid-input", "Touch move/up requires an active contact.", 409);
      const packet = touchPacket(event, { down: 0, move: 2, up: 1 }[event.type]);
      // Track before writing so cleanup can release a down even after a socket failure.
      if (event.type !== "up") this.contacts.set(event.contactId, event);
      await this.write(packet);
      if (event.type === "up") this.contacts.delete(event.contactId);
    });
  }
  cancel(width?: number, height?: number): Promise<void> {
    return this.enqueue(() => this.cancelNow(width, height));
  }
  private async cancelNow(width?: number, height?: number) {
    const contacts = [...this.contacts.values()];
    this.contacts.clear();
    const resized = contacts.map((p) => width && height ? {
      ...p, x: p.x / p.width * width, y: p.y / p.height * height, width, height,
    } : p);
    if (!resized.length) return;
    // ACTION_CANCEL releases the OS gesture. scrcpy's own pointer bookkeeping
    // removes contacts only on ACTION_UP, so clear each one afterwards as well.
    await this.write(touchPacket(resized[0], 3));
    for (const p of resized) await this.write(touchPacket(p, 1));
  }
  private enqueue(fn: () => Promise<void>) {
    const pending = this.tail.then(fn);
    this.tail = pending.catch(() => {});
    return pending;
  }
}


/** A complete, bounded decoder bootstrap. An IDR alone is insufficient once
 * dependent delta frames have already passed; replay the entire current GOP. */
export class ScrcpyGopBuffer {
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
