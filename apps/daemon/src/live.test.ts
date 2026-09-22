import test from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { LiveStreams, type LiveTarget, type LiveAuthorization } from "./live";
import type { MachineAccess } from "./network";
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

test("audio offers are rejected before acquiring video or interactive capture", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.streams.open({ deviceId: device.id, control: true, ...credentials,
      offer: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n",
    }), /video only/);
    assert.deepEqual(f.counts(), { acquired: 0, closed: 0 });
  } finally { await f.streams.close(); }
});

test("iOS simulator streams use native video independently of touch and never show an assigned USB image to a controller", { timeout: 25000 }, async () => {
  const ios: DeviceConfig = { ...device, platform: "Apple", kind: "virtual", connection: { type: "simulator", os: "ios", udid: "fixture-ios" } };
  for (const control of [false, true]) {
    let videoClosed = 0, inputClosed = 0, inputOpened = 0, gestures = 0;
    const video = { width: 588, height: 1280, fps: 15, onFrame: () => () => {}, onClose: () => () => {}, close: async () => { videoClosed++; } };
    const input: InteractiveSource = { ...video, capabilities: ["tap", "swipe", "longPress"],
      close: async () => { inputClosed++; }, pointer: async () => {}, gesture: async () => { gestures++; } };
    const streams = new LiveStreams({
      resolve: () => ({ device: ios, source: control
        ? { id: "external", kind: "usb", name: "External feed", uniqueId: "fixture" }
        : { id: "native", kind: "native", name: "iPhone screen", deviceId: ios.id }, validate() {} }),
      video: async (target, profile) => {
        assert.equal(target.source?.kind, "native");
        assert.equal(target.source?.deviceId, ios.id);
        assert.equal(profile, "balanced");
        return video;
      },
      interactive: async () => { inputOpened++; return input; },
    });
    const peer = client();
    try {
      peer.addTransceiver("video", { direction: "recvonly" });
      const channel = peer.createDataChannel("control", { ordered: true });
      await peer.setLocalDescription(await peer.createOffer());
      const stream = await streams.open({ deviceId: ios.id, offer: peer.localDescription!.sdp, control, ...(control ? credentials : {}) });
      assert.equal(stream.mode, "live");
      assert.equal(stream.width, 588);
      assert.equal(stream.height, 1280);
      assert.deepEqual(stream.capabilities, control ? input.capabilities : []);
      assert.equal(inputOpened, control ? 1 : 0);
      await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
      await until(() => channel.readyState === "open");
      if (control) {
        channel.send(JSON.stringify({ type: "gesture", gesture: { type: "swipe", x: 200, y: 900, toX: 200, toY: 200, width: 588, height: 1280, durationMs: 300 } }));
        await until(() => gestures === 1);
      }
      await streams.closeStream(stream);
      assert.equal(videoClosed, 1);
      assert.equal(inputClosed, control ? 1 : 0);
    } finally { await peer.close(); await streams.close(); }
  }
});

test("failed native iOS video startup releases gesture input and reports the failure", { timeout: 10000 }, async () => {
  let closed = 0;
  const ios: DeviceConfig = { ...device, platform: "Apple", kind: "virtual", connection: { type: "simulator", os: "ios", udid: "fixture-ios" } };
  const streams = new LiveStreams({
    resolve: () => ({ device: ios, source: { id: "native", kind: "native", name: "iPhone screen", deviceId: ios.id }, validate() {} }),
    video: async () => { throw new Error("Native iOS video helper unavailable"); },
    interactive: async () => ({ width: 588, height: 1280, capabilities: ["tap"], onFrame: () => () => {}, onClose: () => () => {},
      close: async () => { closed++; }, pointer: async () => {}, gesture: async () => {} }),
  });
  const peer = client();
  try {
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.createDataChannel("control", { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    await assert.rejects(streams.open({ deviceId: ios.id, offer: peer.localDescription!.sdp, control: true, ...credentials }), /Native iOS video helper unavailable/);
    assert.equal(closed, 1);
  } finally { await peer.close(); await streams.close(); }
});

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

test("ordered input barrier prevents delayed touch from replaying across a hardware key", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  let finishGesture!: () => void, finishHardware!: () => void;
  const gestureFinished = new Promise<void>((resolve) => { finishGesture = resolve; });
  const hardwareFinished = new Promise<void>((resolve) => { finishHardware = resolve; });
  let gestures = 0, gestureRunning = false, hardwareRunning = false;
  f.source.gesture = async () => { gestures++; gestureRunning = true; await gestureFinished; gestureRunning = false; };
  let pending: Promise<void> | undefined;
  try {
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    const receipts = new Set<string>();
    channel.onMessage.subscribe((value) => {
      const receipt = JSON.parse(value.toString());
      if (receipt.type === "input-barrier") receipts.add(receipt.id);
    });
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials }, f.authorize);
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    await until(() => channel.readyState === "open");
    const tap = { type: "gesture", gesture: { type: "tap", x: 20, y: 30, width: 100, height: 200 } };
    const send = (value: unknown) => channel.send(JSON.stringify(value));
    const barrier = async (id: string) => {
      send({ type: "input-barrier", id });
      await until(() => receipts.has(id));
    };
    send(tap); await until(() => gestureRunning);
    send(tap); await barrier("before_Home");
    assert.equal(gestures, 1, "the receipt confirms delivery without waiting for the running gesture");
    pending = f.streams.withHardwareInput(credentials.sessionId, async () => {
      assert.equal(gestureRunning, false);
      hardwareRunning = true;
      await hardwareFinished;
      hardwareRunning = false;
    });
    await until(() => f.events.some((event) => event.type === "cancel"));
    send(tap); await barrier("while_waiting");
    assert.equal(hardwareRunning, false, "Home waits for the original gesture to settle");
    finishGesture(); await until(() => hardwareRunning);
    send(tap);
    send({ type: "pointer", event: { type: "down", contactId: 1, x: 20, y: 30, width: 100, height: 200 } });
    await barrier("while_Home");
    await assert.rejects(f.streams.script(credentials.sessionId, f.target), /connecting/);
    finishHardware(); await pending;
    send({ type: "pointer", event: { type: "move", contactId: 1, x: 30, y: 40, width: 100, height: 200 } });
    send({ type: "pointer", event: { type: "up", contactId: 1, x: 30, y: 40, width: 100, height: 200 } });
    await barrier("after_Home");
    assert.equal(gestures, 1, "queued and delayed touches never replay after the key");
    assert.equal(f.events.filter((event) => event.type !== "cancel").length, 0, "late movement cannot revive a cancelled contact");
    send(tap); await until(() => gestures === 2);
    assert.equal(f.counts().closed, 0, "the existing stream remains available after hardware input");
  } finally {
    finishGesture(); finishHardware(); await pending?.catch(() => {});
    await peer.close(); await f.streams.close();
  }
});

test("brief ICE disconnection pauses touch and preserves the existing stream; sustained loss closes it", { timeout: 20000 }, async () => {
  const f = fixture(), peer = client();
  try {
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    const receipts = new Set<string>();
    channel.onMessage.subscribe((value) => {
      const message = JSON.parse(value.toString());
      if (message.type === "input-barrier") receipts.add(message.id);
    });
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials }, f.authorize);
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    await until(() => channel.readyState === "open");
    // Inject the transport's state notification while keeping the actual ordered
    // data channel to verify cancellation and recovery input behavior.
    const entries: unknown = Reflect.get(f.streams, "entries");
    assert.ok(entries instanceof Map);
    const serverPeer: unknown = entries.get(stream.id)?.peer;
    assert.ok(serverPeer instanceof RTCPeerConnection);
    const send = (value: unknown) => channel.send(JSON.stringify(value));
    const pointer = (type: PointerInput["type"]) => send({ type: "pointer", event: { type, contactId: 1, x: 20, y: 30, width: 100, height: 200 } });
    pointer("down"); await until(() => f.events.some((event) => event.type === "down"));
    serverPeer.connectionStateChange.execute("disconnected");
    await until(() => f.events.at(-1)?.type === "cancel");
    pointer("down"); pointer("move");
    send({ type: "input-barrier", id: "during_disconnect" });
    await until(() => receipts.has("during_disconnect"));
    assert.deepEqual(f.events.map((event) => event.type), ["down", "cancel"]);
    assert.equal(f.counts().closed, 0);
    await f.streams.ping(stream);
    serverPeer.connectionStateChange.execute("connected");
    await Promise.resolve();
    pointer("move"); pointer("up");
    pointer("down"); pointer("up");
    await until(() => f.events.filter((event) => event.type === "up").length === 1);
    assert.deepEqual(f.events.map((event) => event.type), ["down", "cancel", "down", "up"]);
    assert.equal(f.counts().closed, 0);
    serverPeer.connectionStateChange.execute("disconnected");
    await until(() => f.counts().closed === 1);
    await assert.rejects(f.streams.ping(stream), /ended/);
  } finally { await peer.close(); await f.streams.close(); }
});

test("stream renewal pins every principal field and ignores stale authentication and heartbeat races", { timeout: 20000 }, async (t) => {
  const f = fixture(), peer = client();
  let now = 0, delayOldCheck = false, finishOld!: (valid: boolean) => void, finishSlow!: (valid: boolean) => void;
  const principal = { issuer: "https://portal.test", machineId: "machine", uid: "alice", pairingId: "pairing" };
  const grant = (expiresAt: number, change: Partial<MachineAccess> = {}): LiveAuthorization => Object.assign(async () => now < expiresAt, { access: { ...principal, expiresAt, ...change } });
  const original: LiveAuthorization = Object.assign(async () => {
    if (delayOldCheck) { delayOldCheck = false; return new Promise<boolean>((resolve) => { finishOld = resolve; }); }
    return now < 60_000;
  }, { access: { ...principal, expiresAt: 60_000 } });
  let slowPing: Promise<unknown> | undefined;
  try {
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp, control: true, ...credentials }, original);
    await peer.setRemoteDescription({ type: "answer", sdp: stream.answer });
    await until(() => channel.readyState === "open");
    for (const field of ["issuer", "machineId", "uid", "pairingId"] as const)
      await assert.rejects(f.streams.ping(stream, grant(90_000, { [field]: "other" })), /different machine account or pairing/);
    await assert.rejects(f.streams.ping(stream, async () => true), /different machine account or pairing/);
    await assert.rejects(f.streams.ping(stream, grant(-1)), /expired or was revoked/);
    assert.equal(f.counts().closed, 0, "bad credentials do not close another owner's viewer");
    delayOldCheck = true;
    channel.send(JSON.stringify({ type: "pointer", event: { type: "down", contactId: 1, x: 20, y: 30, width: 100, height: 200 } }));
    await until(() => Boolean(finishOld));
    const renewed = grant(90_000);
    await f.streams.ping(stream, renewed);
    now = 61_000;
    finishOld(false);
    await until(() => f.events.some((event) => event.type === "down"));
    assert.equal(f.counts().closed, 0, "a late rejection of the old grant cannot invalidate renewed touch");
    const slow: LiveAuthorization = Object.assign(() => new Promise<boolean>((resolve) => { finishSlow = resolve; }), { access: { ...principal, expiresAt: 120_000 } });
    slowPing = f.streams.ping(stream, slow);
    await until(() => Boolean(finishSlow));
    const newest = grant(150_000);
    await f.streams.ping(stream, newest);
    finishSlow(true); await slowPing;
    now = 125_000;
    await f.streams.ping(stream, newest);
    assert.equal(f.counts().closed, 0, "an older ping completing late cannot replace a newer grant");
    const nativePeer = client();
    try {
      nativePeer.addTransceiver("video", { direction: "recvonly" }); nativePeer.createDataChannel("control");
      await nativePeer.setLocalDescription(await nativePeer.createOffer());
      const nativeStream = await f.streams.open({ deviceId: device.id, offer: nativePeer.localDescription!.sdp });
      await assert.rejects(f.streams.ping(nativeStream, newest), /different machine account or pairing/);
      await f.streams.ping(nativeStream);
    } finally { await nativePeer.close(); }
    const future = Date.now() + 16_000;
    t.mock.method(Date, "now", () => future);
    await assert.rejects(f.streams.ping(stream, grant(200_000)), /viewer expired/);
  } finally {
    finishOld?.(false); finishSlow?.(false); await slowPing?.catch(() => {});
    t.mock.restoreAll(); await peer.close(); await f.streams.close();
  }
});

test("the latest hub grant still expires an existing stream when it is not renewed", { timeout: 10000 }, async () => {
  const f = fixture(), peer = client();
  let now = 0;
  const grant: LiveAuthorization = Object.assign(async () => now < 60_000, {
    access: { issuer: "https://portal.test", machineId: "machine", uid: "alice", pairingId: "pairing", expiresAt: 60_000 },
  });
  try {
    peer.addTransceiver("video", { direction: "recvonly" }); peer.createDataChannel("control");
    await peer.setLocalDescription(await peer.createOffer());
    const stream = await f.streams.open({ deviceId: device.id, offer: peer.localDescription!.sdp }, grant);
    await f.streams.ping(stream, grant);
    now = 60_001;
    await assert.rejects(f.streams.ping(stream, grant), /expired or was revoked/);
    await until(() => f.counts().closed === 1);
    await assert.rejects(f.streams.ping(stream, grant), /ended/);
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
