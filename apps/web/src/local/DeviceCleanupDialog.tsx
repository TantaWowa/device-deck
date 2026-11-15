import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  supportsDeviceCleanup,
  type Device,
  type DeviceCleanupAction,
  type DeviceCleanupResult,
  type Session,
} from "../../../../packages/core/src/local/types";
import { api } from "./api";
import "./device-cleanup.css";

export type CleanupTarget = { device: Device; hidden: boolean };

export function cleanupBlockedReason(device: Device | undefined, sessions: Session[]) {
  if (!device) return "No longer configured.";
  if (!supportsDeviceCleanup(device)) return "Only Android emulators and Apple simulators can be cleaned up.";
  const session = sessions.find((entry) => entry.deviceId === device.id && entry.state !== "closed");
  if (session) return `Reserved by ${session.owner}. End the session first.`;
  if (device.locked) return device.lockReason || "Device is locked for maintenance.";
  if (device.simulatorState === "starting" || device.simulatorState === "stopping") return "Wait for the device to finish starting or stopping.";
  if (device.simulatorState === "unavailable") return "The virtual device or its runtime is unavailable.";
  if (device.connection.type === "adb" && !device.connection.avdName && !device.online) return "Set this emulator's AVD name in Edit device first.";
  return undefined;
}

export function DeviceCleanupDialog({
  targets,
  devices,
  sessions,
  configRevision,
  refresh,
  onClose,
}: {
  targets: CleanupTarget[];
  devices: Device[];
  sessions: Session[];
  configRevision: string;
  refresh: () => Promise<unknown>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dispatched = useRef(false);
  const reviewedRevision = useRef(configRevision).current;
  const [action, setAction] = useState<DeviceCleanupAction>("uninstall-apps");
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<DeviceCleanupResult[] | null>(null);
  const [requestError, setRequestError] = useState("");
  const [submitted, setSubmitted] = useState<{ ids: string[]; skipped: Record<string, string> } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const configurationChanged = configRevision !== reviewedRevision;

  const rows = targets.map(({ device: original, hidden }) => {
    const current = devices.find((device) => device.id === original.id);
    const changed = current && JSON.stringify(current.connection) !== JSON.stringify(original.connection);
    const blocked = configurationChanged ? "Configuration changed. Close this dialog and review the devices again."
      : changed ? "Device connection changed. Close this dialog and review the device again."
      : cleanupBlockedReason(current, sessions);
    return { device: original, hidden, blocked };
  });
  const eligible = rows.filter((row) => !row.blocked);
  const hasAndroid = rows.some(({ device }) => device.connection.type === "adb" && supportsDeviceCleanup(device));
  const completed = results !== null || Boolean(requestError);
  const selectedCount = submitted?.ids.length ?? eligible.length;
  const close = () => { if (!dispatched.current || completed) onClose(); };
  const execute = async () => {
    if (dispatched.current || !eligible.length || eligible.length > 100) return;
    dispatched.current = true;
    const ids = eligible.map(({ device }) => device.id);
    setSubmitted({ ids, skipped: Object.fromEntries(rows.filter((row) => row.blocked).map((row) => [row.device.id, row.blocked!])) });
    setPending(true);
    try {
      // Booting stopped devices and cleaning a selection can take several minutes.
      // Do not retry a destructive operation if its response is lost.
      setResults(await api<DeviceCleanupResult[]>("devices.cleanup", { ids, action, confirmed: true, revision: reviewedRevision }));
    } catch (error) {
      setRequestError(`${(error as Error).message} Some devices may already have changed. Refresh their status before starting another cleanup.`);
    } finally {
      setPending(false);
      void refresh().catch(() => {});
    }
  };
  return (
    <dialog
      ref={dialog}
      className="live-modal device-cleanup-dialog"
      aria-labelledby="device-cleanup-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
    >
      <header>
        <h2 id="device-cleanup-title">{completed ? "Cleanup results" : targets.length === 1 ? `Clean up ${targets[0].device.name}` : "Clean up selected devices"}</h2>
        <button type="button" aria-label="Close cleanup dialog" disabled={pending} onClick={close}>×</button>
      </header>
      <fieldset className="device-cleanup-options" disabled={pending || completed}>
        <legend>Choose what to remove</legend>
        <label>
          <input type="radio" name="device-cleanup-action" value="uninstall-apps" checked={action === "uninstall-apps"} onChange={() => setAction("uninstall-apps")} />
          <span><strong>Uninstall apps</strong><span>Remove user-installed apps and their app data. Keep system apps and device settings.</span></span>
        </label>
        <label>
          <input type="radio" name="device-cleanup-action" value="reset" checked={action === "reset"} onChange={() => setAction("reset")} />
          <span><strong>Reset device</strong><span>Remove installed apps, user data, settings and logins. Keep the virtual device and its OS image.</span></span>
        </label>
      </fieldset>
      <p className="device-cleanup-warning">{action === "reset"
        ? "This cannot be undone. Reset devices will be left shut down."
        : "This cannot be undone. Stopped devices may start briefly, then shut down again."}
        {action === "reset" && hasAndroid && " Android reset keeps files on the virtual SD card."}
      </p>
      <p>{targets.length} {targets.length === 1 ? "device" : "devices"} selected{rows.some((row) => row.hidden) && `, including ${rows.filter((row) => row.hidden).length} hidden by filters`}. Reserved and locked devices are skipped.</p>
      <ul className="device-cleanup-targets" aria-label="Cleanup targets and results" aria-live="polite">
        {rows.map(({ device, hidden, blocked }) => {
          const result = results?.find((entry) => entry.id === device.id);
          const skipped = submitted ? submitted.skipped[device.id] : blocked;
          const requested = submitted?.ids.includes(device.id);
          let detail = skipped ? `Skipped: ${skipped}` : "Ready";
          if (requested && pending) detail = "Cleanup in progress…";
          else if (requested && requestError) detail = "Result unknown. Refresh device status before retrying.";
          else if (result) detail = result.ok
            ? action === "reset" ? "Reset complete. Device shut down."
              : `${typeof result.removedApps === "number" ? `${result.removedApps} ${result.removedApps === 1 ? "app" : "apps"} uninstalled.` : "Apps uninstalled."}${result.state === "shutdown" ? " Device shut down." : ""}`
            : result.error || "Cleanup failed.";
          else if (results && requested) detail = "No result returned. Refresh device status before retrying.";
          return <li key={device.id} className={result && !result.ok ? "device-cleanup-failed" : ""}>
            <strong>{device.name}{hidden && <span className="device-cleanup-hidden">Hidden by filters</span>}</strong>
            <span>{detail}</span>
            {result?.ok && result.warning && <span className="device-cleanup-result-warning">{result.warning}</span>}
          </li>;
        })}
      </ul>
      {eligible.length > 100 && !submitted && <p role="alert">Select at most 100 eligible devices for one cleanup.</p>}
      {requestError && <p className="device-cleanup-error" role="alert">{requestError}</p>}
      {pending && <p role="status"><LoaderCircle size={14} className="simulator-spinner" /> Cleaning up {selectedCount} {selectedCount === 1 ? "device" : "devices"}. This may take several minutes.</p>}
      <footer>
        <button type="button" disabled={pending} onClick={close}>{completed ? "Done" : "Cancel"}</button>
        {!completed && <button type="button" className="danger" disabled={pending || !eligible.length || eligible.length > 100} onClick={() => void execute()}>
          {pending ? "Cleaning up…" : action === "reset" ? `Reset ${selectedCount} ${selectedCount === 1 ? "device" : "devices"}` : `Uninstall apps on ${selectedCount} ${selectedCount === 1 ? "device" : "devices"}`}
        </button>}
      </footer>
    </dialog>
  );
}
