import test from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { LiveStreams, type LiveTarget } from "./live";
import type { InteractiveSource, PointerInput } from "../../../packages/core/src/live";
import type { DeviceConfig } from "../../../packages/core/src/local/types";

const device: DeviceConfig = { id: "phone", name: "Phone", platform: "Android", kind: "physical", model: "fixture", visibility: "local", captureSourceId: "native", connection: { type: "adb", serial: "fixture", hardwareId: "fixture-hardware", port: 5037 } };
const credentials = { sessionId: "session", leaseToken: "secret" };
function fixture() {
  let authorized = true, leased = true, acquired = 0, closed = 0;
  const events: PointerInput[] = [];
  const source: InteractiveSource = { width: 100, height: 200, capabilities: ["drag", "tap"],
    onFrame: () => () => {}, onClose: () => () => {}, close: async () => { closed++; },
    pointer: async (event) => { events.push(event); }, gesture: async () => {},
  };
  const target: LiveTarget = { device, source: { id: "native", kind: "native", name: "Phone", deviceId: device.id },
    validate() { if (!leased) throw new Error("Lease ended"); } };
  const streams = new LiveStreams({ resolve: () => target, video: async () => source, interactive: async () => { acquired++; return source; } });
  return { streams, source, events, target, authorize: async () => authorized, revoke: () => { authorized = false; }, release: () => { leased = false; }, counts: () => ({ acquired, closed }) };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for real WebRTC transport"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function client() {
  return new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [], iceAdditionalHostAddresses: ["127.0.0.1"], iceUseIpv6: false, codecs: { video: [new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: 96, parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" })] } });
}

test("real WebRTC data channel sends a drag before up and lease loss cancels contacts", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  try {
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials }, f.authorize);
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    await until(() => channel.readyState === "open");
    channel.send(JSON.stringify({ type: "pointer", event: { type: "down", contactId: 1, x: 20, y: 30, width: 100, height: 200 } }));
    channel.send(JSON.stringify({ type: "pointer", event: { type: "move", contactId: 1, x: 40, y: 80, width: 100, height: 200 } }));
    await until(() => f.events.some((event) => event.type === "move"));
    assert.deepEqual(f.events.map((event) => event.type), ["down", "move"]);
    await assert.rejects(f.streams.ping({ id: stream.id, token: "wrong-token" }), /ended/);
    f.release();
    await assert.rejects(f.streams.ping(stream), /Lease ended/);
    assert.equal(f.events.at(-1)?.type, "cancel");
    assert.equal(f.counts().closed, 1);
  } finally { await peer.close(); await f.streams.close(); }
});

test("original authentication revocation stops an existing viewer despite its stream token", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp }, f.authorize);
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    assert.deepEqual(stream.capabilities, []);
    f.revoke();
    await assert.rejects(f.streams.ping(stream), /revoked/);
    assert.equal(f.counts().closed, 1);
  } finally { await peer.close(); await f.streams.close(); }
});

test("closing while helper startup is pending releases the late helper exactly once", async () => {
  const f = fixture();
  let finish!: (source: InteractiveSource) => void;
  const streams = new LiveStreams({ resolve: () => f.target, video: async () => f.source, interactive: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = streams.open({ deviceId: device.id, control: true, ...credentials, offer: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n" });
  const rejected = assert.rejects(pending, /closed while connecting/);
  await until(() => Boolean(finish));
  await streams.close();
  finish(f.source);
  await rejected;
  assert.equal(f.counts().closed, 1);
  await f.streams.close();
});

test("malformed offers clean up encoders; authorization and target checks happen before capture", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.streams.open({ deviceId: device.id, offer: "invalid" }), /./);
    assert.equal(f.counts().closed, 0);
    f.revoke();
    await assert.rejects(f.streams.open({ deviceId: device.id, offer: "invalid" }, f.authorize), /expired/);
    assert.equal(f.counts().acquired, 0);
    await assert.rejects(f.streams.open({ deviceId: device.id, offer: "invalid", control: true }), /reservation/);
  } finally { await f.streams.close(); }
});

test("simultaneous controller startup cannot create two controllers for one reservation", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  let finish!: (source: InteractiveSource) => void, acquired = 0;
  const streams = new LiveStreams({
    resolve: () => f.target, video: async () => f.source,
    interactive: () => { acquired++; return new Promise((resolve) => { finish = resolve; }); },
  });
  let first: ReturnType<typeof streams.open> | undefined;
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const args = { deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials };
    first = streams.open(args);
    await until(() => Boolean(finish));
    await assert.rejects(streams.open(args));
    finish(f.source);
    const opened = await first;
    assert.ok(opened.id);
    assert.equal(acquired, 1);
    await streams.closeSession(credentials.sessionId);
    assert.equal(f.counts().closed, 1);
  } finally {
    finish?.(f.source);
    await first?.catch(() => {});
    await peer.close(); await streams.close(); await f.streams.close();
  }
});

test("rebound device IDs acquire a helper for the new transport while the old viewer still exists", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  let selected = device;
  const acquired: DeviceConfig[] = [];
  const streams = new LiveStreams({
    resolve: () => ({ ...f.target, device: selected }), video: async () => f.source,
    interactive: async (target) => {
      acquired.push(target);
      return { ...f.source, width: target.connection.type === "adb" && target.connection.serial === "replacement" ? 300 : 100 };
    },
  });
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const args = { deviceId: device.id, offer: peer.localDescription!.sdp };
    const original = await streams.open(args);
    selected = { ...device, connection: { type: "adb", serial: "replacement", hardwareId: "replacement-hardware", port: 5037 } };
    const replacement = await streams.open(args);
    assert.equal(original.width, 100);
    assert.equal(replacement.width, 300, "a new reservation must not reuse the old physical device's helper");
    assert.equal(acquired.length, 2);
    assert.deepEqual(acquired[1].connection, selected.connection);
  } finally { await peer.close(); await streams.close(); await f.streams.close(); }
});

test("pending scripted controller startup excludes a competing browser controller", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  let finish!: (source: InteractiveSource) => void;
  const streams = new LiveStreams({
    resolve: () => f.target, video: async () => f.source,
    interactive: () => new Promise((resolve) => { finish = resolve; }),
  });
  let scripted: ReturnType<typeof streams.script> | undefined;
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    scripted = streams.script(credentials.sessionId, f.target);
    await until(() => Boolean(finish));
    // Release capture regardless of the browser outcome, keeping a regression
    // failure bounded when the old implementation allowed both to start.
    const browser = streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials });
    finish(f.source);
    await assert.rejects(browser);
    assert.equal((await scripted).source.width, 100);
    await streams.closeSession(credentials.sessionId);
    assert.equal(f.counts().closed, 1);
  } finally {
    finish?.(f.source);
    await scripted?.catch(() => {});
    await peer.close(); await streams.close(); await f.streams.close();
  }
});

test("helper cleanup failure is visible and reservation cleanup retries the retained helper", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  let attempts = 0;
  const source: InteractiveSource = { ...f.source, close: async () => {
    if (++attempts === 1) throw new Error("Android forward cleanup failed");
  } };
  const streams = new LiveStreams({ resolve: () => f.target, video: async () => source, interactive: async () => source });
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const opened = await streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials });
    await assert.rejects(streams.closeStream(opened), /cleanup/);
    await streams.closeSession(credentials.sessionId);
    assert.equal(attempts, 2, "failed helper cleanup must remain reachable by reservation cleanup");
  } finally { await peer.close(); await streams.close(); await f.streams.close(); }
});

test("a static source's bootstrap GOP is subscribed only after ICE connects and reaches a late viewer", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  const received: number[] = [];
  let subscribed = 0, detached = 0;
  f.source.onFrame = (listener) => {
    subscribed++;
    // Emit once, synchronously. No future keyframe or screen change will rescue
    // a subscription made before this peer can receive encrypted RTP.
    listener({ data: Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0x80]), timestampUs: 0n, keyframe: false });
    listener({ data: Buffer.from([0, 0, 0, 1, 0x65, 0x80]), timestampUs: 1000n, keyframe: true });
    listener({ data: Buffer.from([0, 0, 0, 1, 0x41, 0x80]), timestampUs: 2000n, keyframe: false });
    return () => { detached++; };
  };
  try {
    peer.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => { received.push(packet.payload[0] & 31); }));
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp }, f.authorize);
    assert.equal(subscribed, 0, "Signaling must not consume the source's only bootstrap before the receiver connects");
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    await until(() => received.includes(5) && received.includes(1));
    assert.deepEqual(received, [7, 8, 5, 1]);
    assert.equal(subscribed, 1);
    await f.streams.closeStream(stream);
    assert.equal(detached, 1);
  } finally { await peer.close(); await f.streams.close(); }
});
