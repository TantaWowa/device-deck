import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DeckError } from "../../core/src/local/types";
import { gestureInputSchema, type GestureInput, type InteractiveSource } from "../../core/src/live";
import { available, start, stop } from "./process";

export const WDA_GESTURES = ["tap", "swipe", "longPress"] as const;
const responseSchema = z.object({ value: z.unknown(), sessionId: z.string().nullable().optional(), status: z.number().optional() });
type WdaResponse = z.infer<typeof responseSchema>;
const statusSchema = z.object({ ready: z.literal(true), device: z.enum(["iphone", "ipad"]), os: z.object({ name: z.enum(["iOS", "iPadOS"]) }) });
const screenSchema = z.object({
  screenSize: z.object({ width: z.number().positive().max(16384), height: z.number().positive().max(16384) }),
  scale: z.number().positive().max(10),
});
export type WdaScreen = z.infer<typeof screenSchema>;
export type WdaConnection = {
  request(method: string, route: string, body?: unknown): Promise<WdaResponse>;
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
};

/** Only an owned USB forward can select a WDA target. A bare HTTP URL cannot
 * prove which phone it controls: WDA's status does not expose the device UDID. */
export async function openWda(udid: string, devicePort: number, iproxy: string): Promise<WdaConnection> {
  if (!/^(?:[a-f\d]{8}-[a-f\d]{16}|[a-f\d]{40})$/i.test(udid))
    throw new DeckError("identity-unverified", "Xcode did not report a physical iPhone/iPad hardware UDID. Reconnect and rediscover the device.", 409);
  if (!await available(iproxy))
    throw new DeckError("missing-helper", "Physical iOS control needs iproxy. Install libusbmuxd and configure its executable in Settings.", 503);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a WebDriverAgent port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const handle = start(iproxy, ["--udid", udid, "--local", "--source", "127.0.0.1", `${port}:${devicePort}`]);
  const abort = new AbortController(), listeners = new Set<(reason: string) => void>();
  let closed = false;
  let closing: Promise<void> | undefined;
  void handle.completed.then(() => {
    abort.abort();
    if (!closed) for (const listener of listeners) listener("WebDriverAgent USB connection closed. Reconnect the phone and start its helper.");
  });
  const connection: WdaConnection = {
    async request(method, route, body) {
      if (closed || handle.exited()) throw new DeckError("device-offline", "WebDriverAgent USB connection is closed.", 409);
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, redirect: "error", headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("WebDriverAgent returned an empty response.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 24 * 1024 * 1024) throw new Error("WebDriverAgent response exceeded 24 MiB.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (closed || handle.exited()) throw new Error("WebDriverAgent USB connection closed during the request.");
      const result = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      const error = z.object({ error: z.string(), message: z.string().optional() }).safeParse(result.value);
      if (!response.ok || error.success || result.status && result.status !== 0)
        throw new DeckError("wda-failed", error.success ? error.data.message || error.data.error : `WebDriverAgent returned HTTP ${response.status}.`, 502);
      return result;
    },
    onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {
      return closing ??= (async () => { closed = true; abort.abort(); listeners.clear(); await stop(handle); })();
    },
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const result = await connection.request("GET", "/status");
        if (!statusSchema.safeParse(result.value).success)
          throw new DeckError("unsupported-capability", "The USB helper must be WebDriverAgent running on a physical iPhone or iPad.", 409);
        return connection;
      } catch (error) {
        if (error instanceof DeckError || Date.now() >= deadline || handle.exited()) throw error;
        await delay(100);
      }
    }
  } catch (error) {
    await connection.close();
    throw new DeckError("wda-unavailable", `Cannot connect to the selected phone's WebDriverAgent. Connect it by USB, unlock it and start the signed helper. ${error instanceof Error ? error.message : error}`, 503);
  }
}

export async function wdaScreen(connection: WdaConnection): Promise<WdaScreen> {
  const result = screenSchema.safeParse((await connection.request("GET", "/wda/screen")).value);
  if (!result.success) throw new DeckError("missing-helper", "WebDriverAgent must report full screenSize and scale. Update the signed helper using the physical iOS setup instructions.", 503);
  return result.data;
}

export async function wdaScreenshot(connection: WdaConnection): Promise<Buffer> {
  const value = (await connection.request("GET", "/screenshot")).value;
  if (typeof value !== "string" || !value.length) throw new Error("WebDriverAgent returned no screenshot.");
  const data = Buffer.from(value, "base64");
  if (!(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data[0] === 255 && data[1] === 216))
    throw new Error("WebDriverAgent must return PNG or JPEG screenshots. Update the signed helper using the physical iOS setup instructions.");
  return data;
}

export function wdaActions(input: GestureInput, screen: WdaScreen) {
  const gesture = gestureInputSchema.parse(input), { width, height } = screen.screenSize;
  if (Math.abs(gesture.width / gesture.height / (width / height) - 1) > 0.02)
    throw new DeckError("stale-frame", "The phone orientation changed. Reconnect the preview before touching it.", 409);
  const point = (x: number, y: number) => ({ x: Math.min(width - 1, Math.round(x / gesture.width * width)), y: Math.min(height - 1, Math.round(y / gesture.height * height)) });
  return { actions: [{ type: "pointer", id: "device-deck", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, origin: "viewport", ...point(gesture.x, gesture.y) },
    { type: "pointerDown", button: 0 },
    gesture.type === "swipe"
      ? { type: "pointerMove", duration: gesture.durationMs, origin: "viewport", ...point(gesture.toX, gesture.toY) }
      : { type: "pause", duration: gesture.type === "tap" ? 50 : gesture.durationMs },
    { type: "pointerUp", button: 0 },
  ] }] };
}

/** Completed gestures retain their final up, even if the lease closes mid-flight. */
export async function startWdaInteractive(connection: WdaConnection, reconnectForCleanup?: () => Promise<WdaConnection>, onSessionCreated?: (id: string) => void): Promise<InteractiveSource & { sessionId: string }> {
  let sessionId: string | undefined;
  try {
    const status = await connection.request("GET", "/status");
    if (status.sessionId) throw new DeckError("input-busy", "WebDriverAgent already has an active automation session. End it before enabling Device Deck touch.", 409);
    const screen = await wdaScreen(connection);
    const created = await connection.request("POST", "/session", { capabilities: { alwaysMatch: {
      shouldTerminateApp: false, waitForIdleTimeout: 0,
    }, firstMatch: [{}] } });
    sessionId = z.object({ sessionId: z.string().min(1) }).parse(created.value).sessionId;
    onSessionCreated?.(sessionId);
    const route = `/session/${encodeURIComponent(sessionId)}`;
    let closed = false, disconnected = false, cleaned = false;
    let pending: Promise<void> | undefined, closing: Promise<void> | undefined;
    const listeners = new Set<(reason: string) => void>();
    const detach = connection.onClose((reason) => { for (const listener of listeners) listener(reason); });
    return {
      sessionId,
      width: Math.round(screen.screenSize.width * screen.scale), height: Math.round(screen.screenSize.height * screen.scale),
      capabilities: [...WDA_GESTURES], onFrame: () => () => {},
      onClose(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async pointer(event) {
        if (event.type !== "cancel") throw new DeckError("unsupported-capability", "Physical iOS supports completed tap, swipe and long press gestures, not continuous pointer input.", 409);
      },
      async gesture(gesture) {
        if (closed) throw new DeckError("session-closed", "Physical iOS touch session is closed.", 409);
        if (pending) throw new DeckError("input-busy", "An iOS gesture is already running.", 409);
        pending = (async () => {
          const current = await wdaScreen(connection);
          if (closed) return;
          const actions = wdaActions(gesture, current);
          await connection.request("POST", `${route}/actions`, actions);
        })();
        try { await pending; } finally { pending = undefined; }
      },
      close() {
        if (cleaned) return Promise.resolve();
        return closing ??= (async () => {
          closed = true;
          await pending?.catch(() => {});
          if (disconnected) {
            if (!reconnectForCleanup) throw new Error("Reconnect the phone to finish its WebDriverAgent session cleanup.");
            connection = await reconnectForCleanup();
          }
          try {
            // A helper restart or another tool may already have replaced our
            // session. Its replacement must survive release and release retries.
            const status = await connection.request("GET", "/status");
            if (status.sessionId === sessionId) await connection.request("DELETE", route);
            cleaned = true;
          }
          finally {
            detach();
            await connection.close();
            disconnected = true;
            for (const listener of listeners) listener("Physical iOS touch session closed.");
            listeners.clear();
          }
        })().catch((error) => { closing = undefined; throw error; });
      },
    };
  } catch (error) {
    try { if (sessionId) await connection.request("DELETE", `/session/${encodeURIComponent(sessionId)}`); }
    finally { await connection.close(); }
    throw error;
  }
}
