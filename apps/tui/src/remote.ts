import { callOperation } from "../../../packages/core/src/client";
import {
  type Device,
  type Snapshot,
  type Session,
} from "../../../packages/core/src/local/types";
import { terminal, clean } from "./terminal";
export async function interactiveRemote(
  device: Device,
  acquired: { session: Session; leaseToken: string },
) {
  const ui = terminal(),
    lease = { sessionId: acquired.session.id, leaseToken: acquired.leaseToken };
  let message = "Ready",
    recording = false;
  try {
    while (true) {
      const snapshot: Snapshot = await callOperation("inventory");
      recording = snapshot.recordings.some(
        (r) => r.sessionId === lease.sessionId,
      );
      const session = snapshot.sessions.find((s) => s.id === lease.sessionId);
      ui.draw(
        `DEVICE DECK / REMOTE\n\n${clean(device.name)} · ${device.platform}\nOwner: ${clean(session?.owner || "")} · ${clean(session?.reason || "")}\nSession: ${session?.state} · expires ${session ? new Date(session.expiresAt).toLocaleTimeString() : ""}\nRecording: ${recording ? "RUNNING" : "stopped"}\n\n↑ ↓ ← → navigate   Enter select   b Back   h Home\ns Screenshot   c Screenshot to clipboard   r Record/stop\nt Text   u Renew   q Release and return\n\n${clean(message)}\n`,
      );
      const key = await ui.key();
      if (key.name === "q" || (key.ctrl && key.name === "c")) break;
      try {
        if (key.name === "s" || key.name === "c") {
          const a = await callOperation("captures.screenshot", {
            ...lease,
            clipboard: key.name === "c",
          });
          message = a.clipboardError
            ? `Saved ${a.path}. Clipboard: ${a.clipboardError}`
            : `Saved ${a.path}`;
        } else if (key.name === "r") {
          const a = await callOperation(
            recording ? "recordings.stop" : "recordings.start",
            lease,
          );
          message = recording
            ? `${a.status}: ${a.path}`
            : `Recording ${a.id}. The daemon owns this job.`;
        } else if (key.name === "u") {
          await callOperation("sessions.renew", lease);
          message = "Reservation renewed.";
        } else if (key.name === "t") {
          const text = await ui.ask("\nText: ");
          if (text) await callOperation("remote.input", { ...lease, text });
          message = "Text sent.";
        } else {
          const mapping: Record<string, string> = {
            up: "Up",
            down: "Down",
            left: "Left",
            right: "Right",
            return: "OK",
            b: "Back",
            h: "Home",
            space: "Play",
          };
          if (mapping[key.name || ""]) {
            await callOperation("remote.input", {
              ...lease,
              key: mapping[key.name!],
            });
            message = `Sent ${mapping[key.name!]}`;
          }
        }
      } catch (e) {
        message = (e as Error).message;
      }
    }
  } finally {
    ui.close();
    await callOperation("sessions.release", lease);
  }
}
