import React, { useState } from "react";
import { Play, Square, LoaderCircle } from "lucide-react";
import {
  supportsSimulatorLifecycle,
  canLaunchSimulator,
  type Device,
  type Session,
} from "../../../../packages/core/src/local/types";
import { api } from "./api";
import { deviceIsBooting } from "../../../../packages/core/src/device-table";
import { popupAnchor, type PopupAnchor } from "./anchored-popup";

export function SimulatorControls({
  device,
  session,
  lease,
  recording,
  refresh,
  manageSession,
}: {
  device: Device;
  session?: Session;
  lease: { sessionId: string; leaseToken: string } | null;
  recording: boolean;
  refresh: () => Promise<unknown>;
  manageSession: (anchor: PopupAnchor) => void;
}) {
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<{
      action: "launch" | "close";
      sessionId?: string;
    } | null>(null),
    [error, setError] = useState("");
  if (!supportsSimulatorLifecycle(device)) return null;
  const running =
    device.simulatorState === "booted" ||
    (!device.simulatorState && device.online);
  const action = running ? "close" : "launch";
  const intendedAction = confirm?.action || action;
  const pending =
    busy ||
    deviceIsBooting(device) ||
    device.simulatorState === "stopping";
  const owned = Boolean(
    lease && session?.id === lease.sessionId && session.state === "active",
  );
  const execute = async () => {
    setBusy(true);
    setError("");
    try {
      if (confirm && confirm.sessionId !== session?.id) {
        setConfirm(null);
        throw new Error(
          "This reservation changed. Review the current session and try again.",
        );
      }
      if (session) {
        if (!owned)
          throw new Error(
            `End ${session.owner}’s session before ${intendedAction === "close" ? "closing" : "launching"} this simulator.`,
          );
        await api("sessions.release", lease);
      }
      await api("devices.simulator", {
        deviceId: device.id,
        action: intendedAction,
        ...(intendedAction === "close" ? { confirmed: true } : {}),
      });
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <div className="simulator-controls">
      <button
        className={running ? "" : "primary"}
        aria-label={`${running ? "Close" : "Launch"} simulator ${device.name}`}
        disabled={
          pending ||
          device.locked ||
          device.simulatorState === "unavailable" ||
          (!running && !canLaunchSimulator(device))
        }
        title={
          !running && !canLaunchSimulator(device)
            ? "Set the Android AVD name in Edit device before launching."
            : device.locked
              ? device.lockReason
              : device.simulatorState === "unavailable"
                ? device.platform === "Android"
                  ? "Select an available Android AVD and SDK emulator executable in Settings."
                  : "Install this simulator runtime in Xcode first."
                : `${running ? "Shut down" : "Boot and open"} only this simulator`
        }
        onClick={() =>
          running || session
            ? setConfirm({ action, sessionId: session?.id })
            : void execute()
        }
      >
        {pending ? (
          <LoaderCircle size={14} className="simulator-spinner" />
        ) : running ? (
          <Square size={14} />
        ) : (
          <Play size={14} />
        )}
        {pending
          ? device.simulatorState === "stopping" ||
            (device.simulatorState !== "starting" && intendedAction === "close")
            ? "Closing…"
            : "Booting…"
          : running
            ? "Close sim"
            : "Launch sim"}
      </button>
      {confirm && (
        <div
          className="simulator-confirm"
          role="alertdialog"
          aria-label={`Confirm ${intendedAction} simulator`}
        >
          <strong>
            {intendedAction === "close" ? "Close" : "Launch"} {device.name}?
          </strong>
          <p>
            {session
              ? `${owned ? "Your" : `${session.owner}’s`} session is active. ${recording ? "Its recording must stop and save first. " : ""}${owned ? "This ends your reservation before changing the simulator." : "Manage and end that session before continuing."}`
              : intendedAction === "close"
                ? "This shuts down this simulator. Other simulators stay open."
                : "This boots and opens the selected simulator."}
          </p>
          <div className="live-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            {session && !owned ? (
              <button
                disabled={busy}
                onClick={(event) => {
                  setConfirm(null);
                  manageSession(popupAnchor(event.currentTarget));
                }}
              >
                Manage session
              </button>
            ) : (
              <button
                className={intendedAction === "close" ? "danger" : "primary"}
                disabled={busy}
                onClick={() => void execute()}
              >
                {session ? "End session & " : ""}
                {intendedAction === "close" ? "close sim" : "launch sim"}
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <small className="simulator-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
