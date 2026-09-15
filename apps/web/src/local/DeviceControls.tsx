import React, { useLayoutEffect, useRef, useState } from "react";
import { Camera, Circle, Square, Lock, Unlock, RefreshCw } from "lucide-react";
import type {
  Device,
  Snapshot,
  Session,
} from "../../../../packages/core/src/local/types";
import { api } from "./api";
import { RemoteControl } from "./RemoteControl";
import type { FeedAction } from "./FeedActions";
export type DeviceLease = { session: Session; leaseToken: string };
type RemoteLease = DeviceLease & { observed: boolean };
export function DeviceControls({
  device,
  data,
  lease,
  onLease,
  refresh,
  edit,
  initialAction = "remote",
  optionsOpen,
  setOptionsOpen,
}: {
  device: Device;
  data: Snapshot;
  lease: { sessionId: string; leaseToken: string } | null;
  onLease: (lease: DeviceLease) => void;
  refresh: () => Promise<unknown>;
  edit: () => void;
  initialAction?: FeedAction;
  optionsOpen: boolean;
  setOptionsOpen: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [owner, setOwner] = useState(data.config.settings.owner),
    [reason, setReason] = useState("Local recording and device control");
  const [mode, setMode] = useState(data.config.settings.captureMode);
  const [confirm, setConfirm] = useState<
    "takeover" | "release" | "stop" | null
  >(null);
  const session = data.sessions.find(
    (s) => s.deviceId === device.id && s.state !== "closed",
  );
  const recording = data.recordings.find((r) => r.deviceId === device.id);
  const owned = Boolean(
    lease &&
    session?.id === lease.sessionId &&
    session.state === "active" &&
    session.expiresAt > Date.now(),
  );
  const enabled = (owned || !session) && device.online && !device.locked;
  const latest = useRef({
    device,
    data,
    lease,
    session,
    owned,
    owner,
    reason,
    busy,
    confirm,
    optionsOpen,
    onLease,
    refresh,
    setOptionsOpen,
  });
  latest.current = {
    device,
    data,
    lease,
    session,
    owned,
    owner,
    reason,
    busy,
    confirm,
    optionsOpen,
    onLease,
    refresh,
    setOptionsOpen,
  };
  const input = useRef({
    mounted: true,
    generation: 0,
    tail: Promise.resolve<unknown>(undefined),
    lease: null as RemoteLease | null,
  });
  useLayoutEffect(() => {
    input.current.mounted = true;
    return () => {
      input.current.mounted = false;
      input.current.generation++;
      input.current.lease = null;
    };
  }, [device.id]);
  const run = async (fn: () => Promise<unknown>) => {
    // Management actions supersede queued keys and wait for dispatched input.
    input.current.generation++;
    input.current.lease = null;
    latest.current.busy = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await input.current.tail;
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      setOptionsOpen(true);
      await refresh();
      return false;
    } finally {
      latest.current.busy = false;
      setBusy(false);
    }
  };
  const capture = async (
    kind: "record" | "screenshot",
    credentials = lease,
  ) => {
    const result = await api(
      kind === "record" ? "recordings.start" : "captures.screenshot",
      { ...credentials, mode },
    );
    setNotice(
      kind === "record"
        ? "Recording started. You can close this remote."
        : "Screenshot saved to Captures.",
    );
    return result;
  };
  const reserve = async (next?: "record" | "screenshot") => {
    const result: DeviceLease = await api("sessions.reserve", {
      selector: { device: device.id },
      owner,
      reason,
    });
    onLease(result);
    if (next)
      await capture(next, {
        sessionId: result.session.id,
        leaseToken: result.leaseToken,
      });
    else setNotice("Device reserved. Remote and capture controls are ready.");
    return { sessionId: result.session.id, leaseToken: result.leaseToken };
  };
  const send = (payload: { key?: string; text?: string }) => {
    const queue = input.current;
    const generation = queue.generation;
    const deviceId = latest.current.device.id;
    // Remember the session at enqueue time so a released reservation cannot be
    // silently replaced while older keys are still waiting to be dispatched.
    const expectedSession = latest.current.owned
      ? latest.current.session!.id
      : queue.lease?.session.id;
    const current = () =>
      queue.mounted &&
      queue.generation === generation &&
      latest.current.device.id === deviceId;
    const task = queue.tail.then(async () => {
      if (!current()) return false;
      const state = latest.current;
      if (state.busy || state.confirm || state.optionsOpen) return false;
      try {
        if (!state.device.online || state.device.locked)
          throw new Error(
            "This device is offline or locked. Remote input is unavailable.",
          );
        let credentials = queue.lease;
        if (!credentials && state.owned && state.lease && state.session) {
          credentials = {
            session: state.session,
            leaseToken: state.lease.leaseToken,
            observed: true,
          };
          queue.lease = credentials;
        }
        if (expectedSession && credentials?.session.id !== expectedSession)
          throw new Error(
            "Your reservation ended or changed. Reserve the device again to continue.",
          );
        if (!credentials) {
          if (state.session)
            throw new Error(
              `Reserved by ${state.session.owner}. End the current session from the menu to take control.`,
            );
          const reserved: DeviceLease = await api("sessions.reserve", {
            selector: { device: deviceId },
            owner: state.owner,
            reason: state.reason,
          });
          // Keep the returned token even if the window closes during reservation.
          state.onLease(reserved);
          void state.refresh().catch(() => {});
          if (!current()) return false;
          credentials = { ...reserved, observed: false };
          queue.lease = credentials;
        }
        if (!current()) return false;
        // Reservation may have awaited the network while inventory or the
        // window changed. Check the latest state before dispatching this key.
        const beforeSend = latest.current;
        if (beforeSend.busy || beforeSend.confirm || beforeSend.optionsOpen)
          return false;
        if (!beforeSend.device.online || beforeSend.device.locked)
          throw new Error(
            "This device is offline or locked. Remote input is unavailable.",
          );
        const known = beforeSend.data.sessions.find(
          (s) => s.id === credentials.session.id,
        );
        if (
          (known &&
            (known.state !== "active" || known.expiresAt <= Date.now())) ||
          (beforeSend.session &&
            beforeSend.session.id !== credentials.session.id) ||
          (credentials.observed &&
            (!beforeSend.owned ||
              beforeSend.lease?.sessionId !== credentials.session.id))
        )
          throw new Error(
            "Your reservation ended or changed. Reserve the device again to continue.",
          );
        if (known) credentials.session = known;
        if (
          beforeSend.owned &&
          beforeSend.lease?.sessionId === credentials.session.id
        )
          credentials.observed = true;
        if (credentials.session.expiresAt <= Date.now())
          throw new Error(
            "Your reservation expired. Reserve the device again to continue.",
          );
        return await api("remote.input", {
          sessionId: credentials.session.id,
          leaseToken: credentials.leaseToken,
          ...payload,
        });
      } catch (e) {
        if (!current()) return false;
        queue.generation++;
        queue.lease = null;
        setError((e as Error).message);
        setNotice("");
        latest.current.setOptionsOpen(true);
        void latest.current.refresh().catch(() => {});
        return false;
      }
    });
    queue.tail = task;
    return task;
  };
  const captureAllowed = (kind: "record" | "screenshot") =>
    device.online &&
    !device.locked &&
    device.capabilities.includes(kind) &&
    (owned || !session);
  return (
    <div className={`device-control-panel intent-${initialAction}`}>
      {optionsOpen && (
        <div className="remote-options">
          {error && (
            <p role="alert" className="live-alert">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="control-notice">
              {notice}
            </p>
          )}
          <div className="control-session">
            <div className="control-session-title">
              <Lock size={16} />
              <strong>
                {session
                  ? `${owned ? "Your reservation" : "Reserved"} · ${session.owner}`
                  : "Available to reserve"}
              </strong>
              <span>{device.online ? "Online" : "Offline"}</span>
            </div>
            {session && (
              <p>
                {session.reason} · {session.state} · until{" "}
                {new Date(session.expiresAt).toLocaleTimeString()}
              </p>
            )}
            {recording && (
              <p className="recording-notice" role="status">
                <span className="record-dot" />
                Recording is already running since{" "}
                {new Date(recording.startedAt).toLocaleTimeString()}. Ending the
                session stops and saves it.
              </p>
            )}
            {!owned && (
              <div className="control-reserve-fields">
                <label>
                  Owner
                  <input
                    value={owner}
                    maxLength={128}
                    onChange={(e) => setOwner(e.target.value)}
                  />
                </label>
                <label>
                  Reason
                  <input
                    value={reason}
                    maxLength={512}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              </div>
            )}
            <div className="live-actions">
              {owned ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api("sessions.renew", lease);
                        setNotice("Reservation renewed.");
                      })
                    }
                  >
                    <RefreshCw size={14} />
                    Renew
                  </button>
                  <button disabled={busy} onClick={() => setConfirm("release")}>
                    <Unlock size={14} />
                    End session…
                  </button>
                </>
              ) : session ? (
                <button
                  className="danger"
                  disabled={
                    busy ||
                    session.state !== "active" ||
                    !owner.trim() ||
                    !reason.trim()
                  }
                  onClick={() => setConfirm("takeover")}
                >
                  End current session & reserve…
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !device.online ||
                    device.locked ||
                    !owner.trim() ||
                    !reason.trim()
                  }
                  onClick={() => void run(() => reserve())}
                >
                  <Lock size={14} />
                  Reserve
                </button>
              )}
              <button disabled={busy} onClick={edit}>
                Configure device
              </button>
            </div>
            {session && !owned && (
              <p className="control-warning">
                This device belongs to another session. You can cancel that
                session and take control; any recording will be saved first.
              </p>
            )}
            {device.locked && (
              <p role="alert">Device locked: {device.lockReason}</p>
            )}
            {confirm && (
              <div
                className="control-confirm"
                role="alertdialog"
                aria-label="Confirm session change"
              >
                <strong>
                  {confirm === "stop"
                    ? "Stop and save this recording?"
                    : "End the current session?"}
                </strong>
                <p>
                  {recording
                    ? "The current recording will stop and finalize in Captures. "
                    : ""}
                  {confirm === "takeover"
                    ? `Control will transfer from ${session?.owner} to ${owner}.`
                    : confirm === "release"
                      ? "Remote input will stop until you reserve again."
                      : "Your reservation will remain active."}
                </p>
                <div className="live-actions">
                  <button disabled={busy} onClick={() => setConfirm(null)}>
                    Keep current session
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (confirm === "takeover")
                          onLease(
                            await api("sessions.takeover", {
                              deviceId: device.id,
                              owner,
                              reason,
                              confirmed: true,
                            }),
                          );
                        else
                          await api(
                            confirm === "stop"
                              ? "recordings.stop"
                              : "sessions.release",
                            lease,
                          );
                        setConfirm(null);
                        setNotice(
                          confirm === "takeover"
                            ? "Current session ended. You now have control."
                            : confirm === "stop"
                              ? "Recording stopped and saved."
                              : "Session ended.",
                        );
                      })
                    }
                  >
                    {confirm === "takeover"
                      ? "End session & take control"
                      : confirm === "stop"
                        ? "Stop & save recording"
                        : "End session"}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="control-capture">
            <h3>Quick capture</h3>
            <label>
              Capture file
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                disabled={busy}
              >
                <option value="clean">Clean source</option>
                <option
                  value="annotated"
                  disabled={
                    !data.license.features.includes(
                      "DEVICE_DECK_RECORDING_ANNOTATIONS",
                    )
                  }
                >
                  With keypress overlays
                </option>
              </select>
            </label>
            <button
              className={initialAction === "screenshot" ? "primary" : ""}
              disabled={
                busy ||
                !captureAllowed("screenshot") ||
                (!owned && (!owner.trim() || !reason.trim()))
              }
              onClick={() =>
                void run(() =>
                  owned ? capture("screenshot") : reserve("screenshot"),
                )
              }
            >
              <Camera size={17} />
              {owned ? "Take screenshot" : "Reserve & take screenshot"}
            </button>
            <button
              className={recording ? "danger" : "primary"}
              disabled={
                busy ||
                (recording ? !owned : !captureAllowed("record")) ||
                (!owned && (!owner.trim() || !reason.trim()))
              }
              onClick={() =>
                recording
                  ? setConfirm("stop")
                  : void run(() =>
                      owned ? capture("record") : reserve("record"),
                    )
              }
            >
              {recording ? <Square size={16} /> : <Circle size={16} />}
              {recording
                ? "Stop recording…"
                : owned
                  ? "Start recording"
                  : "Reserve & start recording"}
            </button>
            <p>
              {device.captureSourceId
                ? `Input: ${data.sources.find((s) => s.id === device.captureSourceId)?.name || device.captureSourceId}`
                : "Choose a capture input in Configure device."}
            </p>
            {!device.online && <p>{device.healthDetail}</p>}
            <small>
              Captures are saved in the library. Closing the popup keeps your
              session and recording running.
            </small>
          </div>
        </div>
      )}
      <RemoteControl
        key={device.id}
        device={device}
        enabled={enabled && !confirm && !optionsOpen}
        busy={busy}
        sendKey={(key) => send({ key })}
        sendText={(text) => send({ text })}
      />
    </div>
  );
}
