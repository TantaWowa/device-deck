import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, type RTCDataChannel } from "werift";
import { H264Packetizer } from "../../../packages/capture/src/h264";
import { streamOpenSchema, type StreamOpen, type StreamAnswer, type StreamCredentials, type LiveVideoSource, type InteractiveSource, type H264Frame, type VideoProfile } from "../../../packages/core/src/live";
import { fail, type DeviceConfig, type SourceConfig } from "../../../packages/core/src/local/types";
import { ControlStream } from "./control-stream";

export type LiveTarget = { device: DeviceConfig | null; source?: SourceConfig; validate(): void };
export type LiveBackend = {
  resolve(args: StreamOpen): LiveTarget;
  video(target: LiveTarget, profile: VideoProfile): Promise<LiveVideoSource>;
  interactive(device: DeviceConfig, profile: VideoProfile): Promise<InteractiveSource>;
  report?(error: Error): void;
  helperIdentity?(): string;
};
type Entry = {
  id: string; token: string; args: StreamOpen; target: LiveTarget;
  peer: RTCPeerConnection; touched: number; authorize: () => Promise<boolean>;
  source?: LiveVideoSource; control?: ControlStream; channel?: RTCDataChannel;
  disposers: (() => void)[]; release: (() => Promise<void>)[];
  closed: boolean; closing?: Promise<void>;
};
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Signaling uses the existing authenticated API; media and ordered input travel over DTLS/SRTP. */
export class LiveStreams {
  private entries = new Map<string, Entry>();
  private interactive = new Map<string, { refs: number; pending: Promise<InteractiveSource> }>();
  private scripts = new Map<string, { source: InteractiveSource; control: ControlStream; release(): Promise<void>; validate(): Promise<void>; touched: number }>();
  private controlInitializing = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(private backend: LiveBackend) {
    this.timer = setInterval(() => { void this.sweep().catch((error) => this.report(error)); }, 1000);
    this.timer.unref();
  }
  private report(error: unknown) { this.backend.report?.(error instanceof Error ? error : new Error(String(error))); }
  private disposeLater(entry: Entry) { void this.dispose(entry).catch((error) => this.report(error)); }
  private async acquireInteractive(device: DeviceConfig, profile: VideoProfile = "balanced") {
    // View-only sources do not hold a reservation. An edited device ID must
    // never reuse a helper pinned to the previous physical device or AVD.
    const key = `${JSON.stringify(device)}:${profile}:${this.backend.helperIdentity?.() || ""}`;
    let slot = this.interactive.get(key);
    if (!slot) {
      slot = { refs: 0, pending: this.backend.interactive(device, profile) };
      this.interactive.set(key, slot);
    }
    const current = slot;
    current.refs++;
    let released = false;
    let lastOwner = false;
    const release = async () => {
      if (!released) { released = true; lastOwner = --current.refs === 0; }
      if (lastOwner) {
        if (this.interactive.get(key) === current) this.interactive.delete(key);
        await current.pending.then((source) => source.close(), () => {});
      }
    };
    try { return { source: await current.pending, release }; }
    catch (error) { await release(); throw error; }
  }
  async open(value: unknown, authorize: () => Promise<boolean> = async () => true): Promise<StreamAnswer> {
    const args = streamOpenSchema.parse(value);
    if (!args.control) return this.openReady(args, authorize);
    if (this.controlInitializing.has(args.sessionId!)) fail("control-connecting", "This session already has a controller connecting. Wait for it to finish.", 409);
    this.controlInitializing.add(args.sessionId!);
    try { return await this.openReady(args, authorize); }
    finally { this.controlInitializing.delete(args.sessionId!); }
  }
  private async openReady(args: StreamOpen, authorize: () => Promise<boolean>): Promise<StreamAnswer> {
    if (this.entries.size >= 32) fail("stream-limit", "Too many live viewers. Close an unused viewer.", 429);
    if (!await authorize()) fail("unauthorized", "Machine access expired. Reconnect before opening the viewer.", 401);
    if (!/^v=0\r?\n/.test(args.offer) || !/^m=video /m.test(args.offer) || !/^a=rtpmap:\d+ H264\/90000\r?$/im.test(args.offer))
      fail("unsupported-video", "The browser must offer an H.264 WebRTC video receiver. Try a current Chrome, Safari or Firefox browser.", 400);
    const target = this.backend.resolve(args);
    target.validate();
    if (args.control) {
      await this.stopScript(args.sessionId!);
      await Promise.all([...this.entries.values()].filter((e) => e.args.control && e.args.sessionId === args.sessionId).map((e) => this.dispose(e)));
    }
    if (this.entries.size >= 32) fail("stream-limit", "Too many live viewers. Close an unused viewer.", 429);
    const peer = new RTCPeerConnection({
      iceServers: [],
      // Tailscale's utun and loopback are normally excluded by ICE discovery.
      iceAdditionalHostAddresses: [...new Set(Object.values(networkInterfaces()).flatMap((items) => items?.filter((i) => i.family === "IPv4").map((i) => i.address) || []))],
      icePortRange: [49152, 49251],
      iceUseIpv6: false,
      bundlePolicy: "max-bundle",
      codecs: { video: [new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: 96,
        parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }] })] },
    });
    const entry: Entry = { id: randomUUID(), token: randomBytes(32).toString("base64url"), args, target, peer, touched: Date.now(), authorize, disposers: [], release: [], closed: false };
    this.entries.set(entry.id, entry);
    const own = async (release: () => Promise<void>) => {
      if (entry.closed) { await release(); fail("stream-expired", "The viewer closed while connecting. Connect again.", 409); }
      entry.release.push(release);
    };
    const validate = async () => {
      if (entry.closed || Date.now() - entry.touched > 15_000) fail("stream-expired", "The live viewer disconnected. Start a new session.", 409);
      target.validate();
      if (!await authorize()) fail("unauthorized", "Machine access expired or was revoked. Reconnect from the machines page.", 401);
      target.validate();
      if (entry.closed) fail("stream-expired", "The viewer closed.", 409);
    };
    try {
      let input: InteractiveSource | undefined;
      if (target.device && (args.control || (target.device.connection.type === "adb" && target.source?.kind !== "usb"))) {
        const acquired = await this.acquireInteractive(target.device, args.profile);
        await own(acquired.release);
        input = acquired.source;
      }
      const source = input && target.device?.connection.type === "adb" ? input : await this.backend.video(target, args.profile);
      entry.source = source;
      if (source !== input) await own(() => source.close());
      await validate();
      const send = (message: unknown) => { if (entry.channel?.readyState === "open") entry.channel.send(JSON.stringify(message)); };
      const failStream = (error: Error) => { send({ type: "error", message: error.message }); this.disposeLater(entry); };
      if (args.control && input) entry.control = new ControlStream(input, validate, failStream);
      const capabilities = args.control ? input?.capabilities || [] : [];
      const track = new MediaStreamTrack({ kind: "video" });
      peer.addTrack(track);
      const packetizer = new H264Packetizer();
      let width = source.width, height = source.height;
      let detachVideo: (() => void) | undefined;
      const videoFrame = (frame: H264Frame) => {
        if (entry.closed) return;
        try {
          const packets = packetizer.packetize(frame);
          if (peer.connectionState === "connected") for (const packet of packets) track.writeRtp(packet);
          if (source.width !== width || source.height !== height) {
            width = source.width; height = source.height;
            packetizer.waitForKeyframe();
            // A display rotation invalidates all coordinates and in-flight gestures.
            void entry.control?.cancel();
            send({ type: "geometry", width, height });
          }
        } catch (error) { failStream(error instanceof Error ? error : new Error(String(error))); }
      };
      entry.disposers.push(() => { detachVideo?.(); detachVideo = undefined; });
      entry.disposers.push(source.onClose((reason) => failStream(new Error(reason))));
      if (input && input !== source) entry.disposers.push(input.onClose((reason) => failStream(new Error(reason))));
      peer.onDataChannel.subscribe((channel) => {
        if (channel.label !== "control" || !channel.ordered || channel.maxRetransmits !== undefined && channel.maxRetransmits !== null || channel.maxPacketLifeTime !== undefined && channel.maxPacketLifeTime !== null || entry.channel) { channel.close(); return; }
        entry.channel = channel;
        channel.onopen = () => send({ type: "ready", capabilities, width: source.width, height: source.height });
        channel.onMessage.subscribe((value) => {
          try {
            if (value.length > 4096) throw new Error("Control message is too large.");
            if (!entry.control) throw new Error("Start a control session before touching the screen.");
            entry.control.send(JSON.parse(value.toString()));
          } catch (error) { failStream(error instanceof Error ? error : new Error(String(error))); }
        });
        channel.onclose = () => { this.disposeLater(entry); };
      });
      peer.connectionStateChange.subscribe((state) => {
        if (state === "connected" && !entry.closed) {
          packetizer.waitForKeyframe();
          detachVideo?.();
          // Subscribe only once the peer can receive RTP. Android sources replay
          // their complete current GOP here, including a static screen's first IDR.
          // Subscribing before ICE used to discard that only decodable image.
          detachVideo = source.onFrame(videoFrame);
          if (entry.closed) { detachVideo(); detachVideo = undefined; }
        }
        if (["failed", "closed", "disconnected"].includes(state)) this.disposeLater(entry);
      });
      await peer.setRemoteDescription({ type: "offer", sdp: args.offer });
      await peer.setLocalDescription(await peer.createAnswer());
      await validate();
      entry.touched = Date.now();
      return { id: entry.id, token: entry.token, answer: peer.localDescription!.sdp, capabilities, width: source.width, height: source.height,
        mode: source.fps !== undefined && source.fps <= 2 ? "snapshots" : "live" };
    } catch (error) { await this.dispose(entry); throw error; }
  }
  private entry(args: StreamCredentials) {
    const entry = this.entries.get(args.id);
    if (!entry || !equal(entry.token, args.token)) fail("stream-not-found", "This live viewer ended. Connect again.", 404);
    return entry;
  }
  async ping(args: StreamCredentials) {
    const entry = this.entry(args);
    try {
      entry.target.validate();
      if (!await entry.authorize()) fail("unauthorized", "Machine access expired or was revoked.", 401);
      if (entry.closed || Date.now() - entry.touched > 15_000) fail("stream-expired", "The viewer expired. Connect again.", 409);
      entry.touched = Date.now();
      return { ok: true };
    } catch (error) { await this.dispose(entry); throw error; }
  }
  async closeStream(args: StreamCredentials) {
    // Closing the data channel can finish disposal before the HTTP close arrives.
    if (this.entries.has(args.id)) await this.dispose(this.entry(args));
    return { ok: true };
  }
  private dispose(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    for (const dispose of entry.disposers.splice(0)) dispose();
    // Schedule to publish closing before peer/channel close callbacks fire synchronously.
    entry.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const close of [() => entry.control?.close(), () => entry.peer.close()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      const releases = entry.release;
      const results = await Promise.allSettled(releases.map((release) => release()));
      entry.release = releases.filter((_, i) => results[i].status === "rejected");
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, `Live session cleanup needs attention: ${failures.map((e) => e instanceof Error ? e.message : String(e)).join("; ")}`);
      this.entries.delete(entry.id);
    }).catch((error) => { entry.closing = undefined; throw error; });
    return entry.closing;
  }
  async closeSession(id: string) {
    await this.stopScript(id);
    await Promise.all([...this.entries.values()].filter((entry) => entry.args.sessionId === id).map((entry) => this.dispose(entry)));
  }
  async script(sessionId: string, target: LiveTarget, authorize: () => Promise<boolean> = async () => true) {
    target.validate();
    if (this.controlInitializing.has(sessionId)) fail("control-connecting", "A browser controller is connecting for this session.", 409);
    this.controlInitializing.add(sessionId);
    try { return await this.scriptReady(sessionId, target, authorize); }
    finally { this.controlInitializing.delete(sessionId); }
  }
  private async scriptReady(sessionId: string, target: LiveTarget, authorize: () => Promise<boolean>) {
    if ([...this.entries.values()].some((e) => e.args.control && e.args.sessionId === sessionId)) fail("control-busy", "End the browser control session before sending scripted gestures.", 409);
    let entry = this.scripts.get(sessionId);
    if (!entry) {
      if (!target.device) fail("unsupported-capability", "A configured touch device is required.");
      const acquired = await this.acquireInteractive(target.device);
      try { target.validate(); } catch (error) { await acquired.release(); throw error; }
      const validate = async () => {
        target.validate();
        if (!await authorize()) fail("unauthorized", "Machine access expired or was revoked.", 401);
        target.validate();
      };
      try { await validate(); } catch (error) { await acquired.release(); throw error; }
      const control = new ControlStream(acquired.source, validate, () => { void this.stopScript(sessionId).catch((error) => this.report(error)); });
      entry = { ...acquired, control, validate, touched: Date.now() };
      this.scripts.set(sessionId, entry);
    }
    await entry.validate(); entry.touched = Date.now();
    return entry;
  }
  async stopScript(sessionId: string) {
    const entry = this.scripts.get(sessionId);
    if (entry) { await entry.control.close(); await entry.release(); this.scripts.delete(sessionId); }
  }
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await Promise.all([...this.entries.values()].map(async (entry) => {
        try {
          entry.target.validate();
          if (Date.now() - entry.touched > 15_000 || !await entry.authorize()) await this.dispose(entry);
        } catch { await this.dispose(entry); }
      }));
      for (const [id, entry] of this.scripts) {
        try { await entry.validate(); if (Date.now() - entry.touched > 15_000) await this.stopScript(id); }
        catch { await this.stopScript(id); }
      }
    } finally { this.sweeping = false; }
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all([...this.entries.values()].map((entry) => this.dispose(entry)));
    await Promise.all([...this.scripts.keys()].map((id) => this.stopScript(id)));
  }
}
