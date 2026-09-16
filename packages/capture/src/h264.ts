import { randomBytes } from "node:crypto";
import type { H264Frame } from "../../core/src/live";

const prefix = Buffer.from([0, 0, 0, 1]);

function starts(data: Buffer) {
  const result: { at: number; body: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const size = data[i + 2] === 1 ? 3 :
      data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (!size || i + size >= data.length) continue;
    result.push({ at: i, body: i + size });
    i += size - 1;
  }
  return result;
}

/** Split an Annex-B access unit without retaining its start codes. */
export function h264Nals(data: Buffer): Buffer[] {
  const positions = starts(data);
  return positions.map((position, i) =>
    data.subarray(position.body, positions[i + 1]?.at ?? data.length),
  );
}

/** ffmpeg inserts AUDs, giving an unambiguous boundary even across pipe chunks. */
export class H264AccessUnitParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024)
      throw new Error("H264 encoder exceeded the maximum access unit size.");
    const units: Buffer[] = [];
    const boundaries = starts(this.buffer)
      .filter((position) => (this.buffer[position.body] & 31) === 9);
    // Keep the unfinished last unit. Parameter sets before its first AUD belong
    // to that first unit too, as permitted by different encoder implementations.
    for (let i = boundaries.length - 1; i > 0; i--) {
      units.unshift(this.buffer.subarray(boundaries[i].at));
      this.buffer = this.buffer.subarray(0, boundaries[i].at);
    }
    if (units.length) {
      units.unshift(this.buffer);
      this.buffer = units.pop()!;
    }
    return units.filter((unit) => h264Nals(unit).some((nal) => [1, 5].includes(nal[0] & 31)));
  }
  finish(): Buffer[] {
    const last = this.buffer;
    this.buffer = Buffer.alloc(0);
    return h264Nals(last).some((nal) => [1, 5].includes(nal[0] & 31)) ? [last] : [];
  }
}

export function h264Keyframe(data: Buffer) {
  return h264Nals(data).some((nal) => (nal[0] & 31) === 5);
}

/** RFC 6184 packetization-mode=1. One instance belongs to one WebRTC viewer. */
export class H264Packetizer {
  private sequence: number;
  private readonly timestamp: number;
  private readonly ssrc: number;
  private readonly payloadType: number;
  private readonly maxPayloadSize: number;
  private origin?: bigint;
  private sps?: Buffer;
  private pps?: Buffer;
  private waitingForKeyframe = true;

  constructor(options: {
    payloadType?: number;
    ssrc?: number;
    sequenceNumber?: number;
    timestamp?: number;
    maxPayloadSize?: number;
  } = {}) {
    this.sequence = options.sequenceNumber ?? randomBytes(2).readUInt16BE();
    this.timestamp = options.timestamp ?? randomBytes(4).readUInt32BE();
    this.ssrc = options.ssrc ?? randomBytes(4).readUInt32BE();
    this.payloadType = options.payloadType ?? 96;
    this.maxPayloadSize = options.maxPayloadSize ?? 1100;
    if (this.maxPayloadSize < 3 || this.maxPayloadSize > 1400)
      throw new Error("H264 RTP payload size must be between 3 and 1400 bytes.");
  }

  /** Keep parameter sets and RTP clock continuity while awaiting a fresh IDR. */
  waitForKeyframe() { this.waitingForKeyframe = true; }

  packetize(frame: H264Frame): Buffer[] {
    let nals = h264Nals(frame.data).filter((nal) => (nal[0] & 31) !== 9);
    for (const nal of nals) {
      if ((nal[0] & 31) === 7) this.sps = nal;
      if ((nal[0] & 31) === 8) this.pps = nal;
    }
    // scrcpy sends configuration separately (also during rotation) with a zero
    // timestamp. Cache it without creating an RTP timestamp or media packet.
    if (!nals.some((nal) => [1, 5].includes(nal[0] & 31))) return [];
    const keyframe = nals.some((nal) => (nal[0] & 31) === 5);
    if (this.waitingForKeyframe && (!keyframe || !this.sps || !this.pps)) return [];
    if (keyframe && this.sps && this.pps) {
      nals = [this.sps, this.pps, ...nals.filter((nal) => ![7, 8].includes(nal[0] & 31))];
      this.waitingForKeyframe = false;
    }
    this.origin ??= frame.timestampUs;
    const time = Number((BigInt(this.timestamp) +
      (frame.timestampUs - this.origin) * 90n / 1000n) & 0xffffffffn);
    const payloads: Buffer[] = [];
    for (const nal of nals) {
      if (nal.length <= this.maxPayloadSize) {
        payloads.push(nal);
        continue;
      }
      const type = nal[0] & 31, indicator = (nal[0] & 0xe0) | 28;
      for (let offset = 1; offset < nal.length; offset += this.maxPayloadSize - 2) {
        const end = Math.min(nal.length, offset + this.maxPayloadSize - 2);
        payloads.push(Buffer.concat([
          Buffer.from([indicator, type | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0)]),
          nal.subarray(offset, end),
        ]));
      }
    }
    return payloads.map((payload, i) => {
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = this.payloadType | (i === payloads.length - 1 ? 0x80 : 0);
      header.writeUInt16BE(this.sequence++ & 0xffff, 2);
      header.writeUInt32BE(time, 4);
      header.writeUInt32BE(this.ssrc, 8);
      return Buffer.concat([header, payload]);
    });
  }
}

export function annexB(nals: Buffer[]) {
  return Buffer.concat(nals.flatMap((nal) => [prefix, nal]));
}
