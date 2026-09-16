import type { DeviceConfig } from "../../core/src/local/types";
import { DeckError } from "../../core/src/local/types";
import type { GestureCapability, GestureInput, InteractiveSource } from "../../core/src/live";
import { available, run } from "./process";
import { validatePoint } from "./scrcpy-protocol";

export const IOS_GESTURES: GestureCapability[] = ["tap", "swipe", "longPress"];
type Screen = { width: number; height: number; widthPoints: number; heightPoints: number };

export function idbScreen(json: string, udid: string): Screen {
  const target = JSON.parse(json);
  if (target.udid !== udid)
    throw new DeckError("identity-mismatch", "idb returned a different simulator UDID.", 409);
  if (String(target.state).toLowerCase() !== "booted")
    throw new DeckError("device-offline", "Boot the iOS simulator before enabling touch.", 409);
  const screen = target.screen_dimensions;
  const width = Number(screen?.width), height = Number(screen?.height);
  const widthPoints = Number(screen?.width_points), heightPoints = Number(screen?.height_points);
  if (![width, height, widthPoints, heightPoints].every((n) => Number.isFinite(n) && n > 0))
    throw new DeckError("missing-helper", "idb did not report simulator pixels and points. Update the configured idb and idb_companion together before enabling touch.", 503);
  return { width, height, widthPoints, heightPoints };
}

export function idbGestureArgs(gesture: GestureInput, screen: Screen, udid: string): string[] {
  validatePoint(gesture);
  if (gesture.type === "swipe") validatePoint({ ...gesture, x: gesture.toX, y: gesture.toY });
  const portrait = screen.height >= screen.width;
  const rotated = (gesture.height >= gesture.width) !== portrait;
  const pointsWidth = rotated ? screen.heightPoints : screen.widthPoints;
  const pointsHeight = rotated ? screen.widthPoints : screen.heightPoints;
  const expectedRatio = rotated ? screen.height / screen.width : screen.width / screen.height;
  if (Math.abs(gesture.width / gesture.height / expectedRatio - 1) > 0.02)
    throw new DeckError("stale-frame", "The simulator screen dimensions changed. Wait for the current preview before touching it.", 409);
  const x = (value: number) => String(Math.min(Math.ceil(pointsWidth) - 1, Math.round(value / gesture.width * pointsWidth)));
  const y = (value: number) => String(Math.min(Math.ceil(pointsHeight) - 1, Math.round(value / gesture.height * pointsHeight)));
  const duration = gesture.type === "tap" ? [] : ["--duration", String(gesture.durationMs / 1000)];
  if (gesture.type !== "tap" && (!Number.isFinite(gesture.durationMs) || gesture.durationMs < 1 || gesture.durationMs > 10000))
    throw new DeckError("invalid-input", "Gesture duration must be between 1 and 10000 milliseconds.", 400);
  return ["ui", gesture.type === "swipe" ? "swipe" : "tap", x(gesture.x), y(gesture.y),
    ...(gesture.type === "swipe" ? [x(gesture.toX), y(gesture.toY)] : []), ...duration, "--udid", udid];
}

export async function startIdbInteractive(
  device: DeviceConfig, idb: string, control: boolean,
  execute = run, hasTool = available,
): Promise<InteractiveSource> {
  const connection = device.connection;
  if (connection.type !== "simulator" || connection.os !== "ios")
    throw new DeckError("unsupported-capability", "Touch gestures are available on iOS simulators only.");
  if (!(await hasTool(idb)) || !(await hasTool("idb_companion")))
    throw new DeckError("missing-helper", "iOS touch requires idb and idb_companion. Install both using the idb setup instructions, then configure the idb executable in Settings.", 503);
  const describe = async () => idbScreen((await execute(idb, ["describe", "--udid", connection.udid, "--json"])).stdout.toString(), connection.udid);
  let screen = await describe(), closed = false, pending: Promise<void> | undefined;
  const closers = new Set<(reason: string) => void>();
  return {
    get width() { return screen.width; }, get height() { return screen.height; },
    capabilities: control ? [...IOS_GESTURES] : [],
    // Native iOS video is shared separately by CaptureEngine. This adapter
    // supplies bounded gestures, not continuous drag/multitouch.
    onFrame: () => () => {},
    onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; },
    async pointer(event) {
      if (event.type === "cancel") return; // No held pointer is created by this adapter.
      throw new DeckError("unsupported-capability", "iOS supports tap, swipe and long press gestures; continuous pointer input is unavailable.", 409);
    },
    async gesture(gesture) {
      if (closed) throw new DeckError("session-closed", "iOS touch session is closed.", 409);
      if (!control) throw new DeckError("control-disabled", "This is a view-only session.", 403);
      if (pending) throw new DeckError("input-busy", "An iOS gesture is already running.", 409);
      pending = (async () => {
        screen = await describe();
        if (closed) return;
        const args = idbGestureArgs(gesture, screen, connection.udid);
        await execute(idb, args, 15000);
      })();
      try { await pending; } finally { pending = undefined; }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Let the bounded HID sequence send its final up. Killing the idb process
      // between down and up could strand a touch in the simulator.
      await pending?.catch(() => {});
      for (const listener of closers) listener("iOS touch session closed");
      closers.clear();
    },
  };
}
