import test from "node:test";
import assert from "node:assert/strict";
import { annexB, H264AccessUnitParser, h264Nals, H264Packetizer } from "./h264";
import type { H264Frame } from "../../core/src/live";

const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1f]), pps = Buffer.from([0x68, 0xaa]);
const frame = (nals: Buffer[], timestampUs = 0n): H264Frame => ({
  data: annexB(nals), timestampUs, keyframe: nals.some((nal) => (nal[0] & 31) === 5),
});

test("Annex-B access units survive split start codes and multiple frames per pipe read", () => {
  const units = [
    annexB([Buffer.from([9, 0xf0]), sps, pps, Buffer.from([0x65, 1, 2, 3])]),
    annexB([Buffer.from([9, 0xf0]), Buffer.from([0x41, 4, 5, 6])]),
    annexB([Buffer.from([9, 0xf0]), Buffer.from([0x41, 7, 8, 9])]),
  ];
  const parser = new H264AccessUnitParser(), actual: Buffer[] = [];
  for (const byte of Buffer.concat(units)) actual.push(...parser.push(Buffer.from([byte])));
  actual.push(...parser.finish());
  assert.deepEqual(actual, units);
  const coalesced = new H264AccessUnitParser();
  assert.deepEqual([...coalesced.push(Buffer.concat(units)), ...coalesced.finish()], units);
});

test("RTP waits for random access, preserves H264 bytes through FU-A, and advances its 90kHz clock", () => {
  const packetizer = new H264Packetizer({ sequenceNumber: 65535, timestamp: 0xfffffff0, ssrc: 42, maxPayloadSize: 1100 });
  assert.deepEqual(packetizer.packetize(frame([sps, pps])), []);
  assert.deepEqual(packetizer.packetize(frame([Buffer.from([0x41, 3])], 1_000_000n)), []);
  const idr = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(5000, 0xaf)]);
  const packets = packetizer.packetize(frame([idr], 2_000_000n));
  assert.equal(packets[0].readUInt16BE(2), 65535);
  assert.equal(packets[1].readUInt16BE(2), 0);
  assert.deepEqual(packets.slice(0, 2).map((p) => p.subarray(12)), [sps, pps]);
  assert.ok(packets.every((p) => p.length <= 1112));
  assert.ok(packets.every((p) => p.readUInt32BE(4) === 0xfffffff0 && p.readUInt32BE(8) === 42));
  assert.equal(packets.filter((p) => p[1] & 0x80).length, 1);
  assert.ok(packets.at(-1)![1] & 0x80);
  const fragments = packets.slice(2).map((p) => p.subarray(12));
  assert.equal(fragments[0][0] & 31, 28);
  assert.ok(fragments[0][1] & 0x80);
  assert.ok(fragments.at(-1)![1] & 0x40);
  assert.deepEqual(Buffer.concat([Buffer.from([(fragments[0][0] & 0xe0) | (fragments[0][1] & 31)]), ...fragments.map((p) => p.subarray(2))]), idr);
  const next = packetizer.packetize(frame([Buffer.from([0x41, 4])], 2_100_000n));
  assert.equal(next[0].readUInt32BE(4), (0xfffffff0 + 9000) >>> 0);
  assert.deepEqual(packetizer.packetize(frame([sps, pps], 0n)), []);
  const afterConfig = packetizer.packetize(frame([Buffer.from([0x41, 4])], 2_200_000n));
  assert.equal(afterConfig[0].readUInt32BE(4), (0xfffffff0 + 18000) >>> 0);
  packetizer.waitForKeyframe();
  assert.deepEqual(packetizer.packetize(frame([Buffer.from([0x41, 4])], 2_200_000n)), []);
  assert.ok(packetizer.packetize(frame([idr], 3_000_000n)).length);
  const late = new H264Packetizer();
  assert.deepEqual(late.packetize(frame([Buffer.from([0x41, 4])])), []);
  assert.ok(late.packetize(frame([sps, pps, idr])).length);
  assert.deepEqual(h264Nals(frame([sps, pps, idr]).data), [sps, pps, idr]);
});
