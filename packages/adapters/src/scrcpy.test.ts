import test from "node:test";
import assert from "node:assert/strict";
import { ScrcpyGopBuffer, ScrcpyTouch, ScrcpyVideoParser, touchPacket } from "./scrcpy-protocol";
import { checkAndroidVideoSdk, adbTouchscreen, freezeAdbTransport, removeScrcpyForward, startScrcpy } from "./scrcpy";
import { deviceSchema } from "../../core/src/local/types";
import type { H264Frame, PointerInput } from "../../core/src/live";
import type { run } from "./process";

const point: PointerInput = { type: "down", contactId: 17, x: 53, y: 89, width: 540, height: 960 };
const android = deviceSchema.parse({ id: "phone", name: "Phone", platform: "Android", kind: "physical", connection: { type: "adb", serial: "usb-device", hardwareId: "hardware-one", port: 5038 } });
function session(w: number, h: number) {
  const packet = Buffer.alloc(12); packet[0] = 0x80;
  packet.writeUInt32BE(w, 4); packet.writeUInt32BE(h, 8); return packet;
}
function packet(data: Buffer, flags: bigint) {
  const header = Buffer.alloc(12); header.writeBigUInt64BE(flags); header.writeUInt32BE(data.length, 8); return Buffer.concat([header, data]);
}
test("scrcpy 4.1 decodes arbitrarily fragmented config, media and rotation session packets in order", () => {
  const sequence: (string | H264Frame)[] = [];
  const parser = new ScrcpyVideoParser((w, h) => sequence.push(`${w}x${h}`), (f) => sequence.push(f));
  const config = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1f]);
  const media = Buffer.from([0, 0, 1, 0x65, 1, 2]);
  const bytes = Buffer.concat([Buffer.from("h264"), session(540, 960), packet(config, 1n << 62n), packet(media, (1n << 61n) | 250000n), session(960, 540), packet(media, (1n << 61n) | 300000n)]);
  for (let i = 0; i < bytes.length; i += 3) parser.push(bytes.subarray(i, i + 3));
  assert.deepEqual(sequence, ["540x960", { data: config, timestampUs: 0n, keyframe: false }, { data: media, timestampUs: 250000n, keyframe: true }, "960x540", { data: media, timestampUs: 300000n, keyframe: true }]);
});
test("scrcpy rejects incompatible codecs, invalid geometry and oversized packets before buffering their payload", () => {
  const create = () => new ScrcpyVideoParser(() => {}, () => {});
  assert.throws(() => create().push(Buffer.from("h265")), /H.264/);
  assert.throws(() => create().push(Buffer.concat([Buffer.from("h264"), session(0, 1)])), /dimensions/);
  const header = Buffer.alloc(12); header.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => create().push(Buffer.concat([Buffer.from("h264"), header])), /packet size/);
});
test("scrcpy touch serialization preserves pointer identity, encoded dimensions and Android finger semantics", () => {
  const bytes = touchPacket(point, 0);
  assert.equal(bytes.length, 32); assert.equal(bytes[0], 2); assert.equal(bytes[1], 0);
  assert.equal(bytes.readBigUInt64BE(2), 17n);
  assert.deepEqual([bytes.readUInt32BE(10), bytes.readUInt32BE(14), bytes.readUInt16BE(18), bytes.readUInt16BE(20)], [53, 89, 540, 960]);
  assert.equal(bytes.readUInt16BE(22), 65535); assert.equal(bytes.readBigUInt64BE(24), 0n);
  assert.equal(touchPacket({ ...point, x: 539.9 }, 1).readUInt32BE(10), 539);
  assert.throws(() => touchPacket({ ...point, x: 540 }, 0), /inside/);
  assert.throws(() => touchPacket({ ...point, contactId: -1 }, 0), /contact ID/);
});
test("concurrent touch calls stay ordered; cancel releases every contact and allows a new gesture", async () => {
  const writes: Buffer[] = [];
  const touch = new ScrcpyTouch(async (bytes) => { await new Promise((r) => setImmediate(r)); writes.push(bytes); });
  await Promise.all([touch.pointer(point), touch.pointer({ ...point, type: "move", x: 70 }), touch.pointer({ ...point, contactId: 19 }), touch.pointer({ ...point, type: "cancel" })]);
  assert.deepEqual(writes.map((p) => [p[1], Number(p.readBigUInt64BE(2))]), [[0, 17], [2, 17], [0, 19], [3, 17], [1, 17], [1, 19]]);
  await assert.rejects(touch.pointer({ ...point, type: "up" }), /active contact/);
  await touch.pointer(point); await touch.cancel(960, 540);
  const cancel = writes.at(-2)!;
  assert.deepEqual([cancel[1], cancel.readUInt16BE(18), cancel.readUInt16BE(20)], [3, 960, 540]);
  assert.equal(touch.activeContacts, 0);
});
test("identity is verified against a frozen transport ID and cleanup only removes the owned forward", async () => {
  const calls: string[][] = [];
  const execute: typeof run = async (_command, args) => {
    calls.push(args);
    const stdout = args.includes("devices") ? "List of devices attached\nusb-device device model:Phone transport_id:72\n" : args.includes("ro.serialno") ? "hardware-one\n" : "usb-device tcp:49152 localabstract:scrcpy_abc\nother tcp:49153 localabstract:scrcpy_xyz\n";
    return { stdout: Buffer.from(stdout), stderr: "" };
  };
  const transport = await freezeAdbTransport(android, "adb", execute);
  assert.deepEqual(transport.args, ["-P", "5038", "-t", "72"]);
  assert.deepEqual(calls[1], [...transport.args, "shell", "getprop", "ro.serialno"]);
  await removeScrcpyForward("adb", transport, 49152, "scrcpy_abc", execute);
  assert.deepEqual(calls.at(-1), ["-P", "5038", "-t", "72", "forward", "--remove", "tcp:49152"]);
  calls.length = 0;
  await removeScrcpyForward("adb", transport, 49153, "scrcpy_abc", execute);
  assert.equal(calls.length, 1, "An unrelated or replaced forward must survive cleanup");
  assert(!calls.flat().includes("kill-server"));
});
test("reused Android serial or AVD rejects before any push or input", async () => {
  const execute: typeof run = async (_command, args) => ({ stdout: Buffer.from(args.includes("devices") ? "usb-device device transport_id:73\n" : "some-other-device\n"), stderr: "" });
  await assert.rejects(freezeAdbTransport(android, "adb", execute), /different hardware serial/);
  await assert.rejects(freezeAdbTransport({ ...android, connection: { type: "adb", serial: "usb-device", avdName: "Expected_AVD", port: 5038 } }, "adb", execute), /different AVD/);
  await assert.rejects(startScrcpy(android, "adb", "/nonexistent/deck-scrcpy-server", true), /pinned scrcpy.*missing/);
});

test("Android TV and fake-touch-only devices do not advertise touchscreen gestures", async () => {
  let features = "feature:android.hardware.type.television\nfeature:android.hardware.faketouch\n";
  const execute: typeof run = async () => ({ stdout: Buffer.from(features), stderr: "" });
  assert.equal(await adbTouchscreen("adb", ["-t", "72"], execute), false);
  features += "feature:android.hardware.touchscreen\n";
  assert.equal(await adbTouchscreen("adb", ["-t", "72"], execute), true);
  features = "feature:android.hardware.touchscreen.multitouch\n";
  assert.equal(await adbTouchscreen("adb", ["-t", "72"], execute), false);
});


test("forward cleanup requires the frozen selector and reports an orphan if removal fails", async () => {
  const transport = { args: ["-P", "5037", "-t", "4"], port: 5037, serial: "emulator-5560" };
  let mapping = "emulator-5560 tcp:61765 localabstract:scrcpy_owned\n";
  let failedRemoval = false;
  const execute: typeof run = async (_command, args) => {
    if (args.includes("--remove")) {
      assert.deepEqual(args.slice(0, 4), transport.args, "ADB forward removal requires a selector with multiple devices");
      if (failedRemoval) throw new Error("transport unavailable");
      mapping = "";
    }
    return { stdout: Buffer.from(mapping), stderr: "" };
  };
  await removeScrcpyForward("adb", transport, 61765, "scrcpy_owned", execute);
  assert.equal(mapping, "");
  mapping = "emulator-5560 tcp:61765 localabstract:scrcpy_owned\n";
  failedRemoval = true;
  await assert.rejects(removeScrcpyForward("adb", transport, 61765, "scrcpy_owned", execute), /Could not remove/);
});

test("Android live video checks API21 before pushing its server", async () => {
  for (const version of ["21", "36"]) {
    const execute: typeof run = async () => ({ stdout: Buffer.from(version), stderr: "" });
    assert.equal(await checkAndroidVideoSdk("adb", ["-t", "4"], execute), Number(version));
  }
  for (const version of ["19", "", "unknown"]) {
    const execute: typeof run = async () => ({ stdout: Buffer.from(version), stderr: "" });
    await assert.rejects(checkAndroidVideoSdk("adb", ["-t", "4"], execute), /API 21/);
  }
});


test("native video requires hardware identity for network ADB and exact AVD identity for emulators", async () => {
  const usb = { ...android, connection: { type: "adb" as const, serial: "usb-device", port: 5038 } };
  const execute: typeof run = async (_command, args) => ({ stdout: Buffer.from(args.includes("devices")
    ? "usb-device device transport_id:72\n192.0.2.1:5555 device transport_id:73\nemulator-5560 device transport_id:74\n"
    : "usb-device\n"), stderr: "" });
  assert.deepEqual((await freezeAdbTransport(usb, "adb", execute)).args, ["-P", "5038", "-t", "72"]);
  await assert.rejects(freezeAdbTransport({ ...usb, connection: { ...usb.connection, serial: "192.0.2.1:5555" } }, "adb", execute), /no verified hardware identity/);
  await assert.rejects(freezeAdbTransport({ ...usb, kind: "virtual", connection: { ...usb.connection, serial: "emulator-5560" } }, "adb", execute), /exact AVD identity/);
});


test("late Android viewers replay configuration and the complete current GOP from a static screen", () => {
  const cache = new ScrcpyGopBuffer(20, 3);
  const make = (value: number, keyframe = false): H264Frame => ({ data: Buffer.from([value]), timestampUs: BigInt(value), keyframe });
  cache.push(make(7), true); cache.push(make(8), true);
  cache.push(make(1)); // A delta cannot bootstrap a decoder.
  const replay = () => { const values: number[] = []; cache.replay((f) => values.push(f.data[0])); return values; };
  assert.deepEqual(replay(), [7, 8]);
  cache.push(make(5, true)); cache.push(make(2)); cache.push(make(3));
  assert.deepEqual(replay(), [7, 8, 5, 2, 3], "Retain every dependency after the last IDR, including frames emitted before subscription");
  cache.push(make(4));
  assert.deepEqual(replay(), [7, 8], "Overflow invalidates the GOP instead of replaying a stale IDR plus missing deltas");
  cache.push(make(6, true));
  assert.deepEqual(replay(), [7, 8, 6]);
  cache.reset();
  assert.deepEqual(replay(), [], "A rotated encoder session must not replay the old dimensions' frames");
});
