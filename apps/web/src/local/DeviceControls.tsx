import React, { useLayoutEffect, useRef, useState } from "react";
import { Camera, Copy, Circle, Square, Lock, Unlock, RefreshCw } from "lucide-react";
import type {
  Device,
  Snapshot,
  Session,
  Artifact,
} from "../../../../packages/core/src/local/types";
import { copyImageToClipboard } from "./capture-feedback";
import { api } from "./api";
import { RemoteControl } from "./RemoteControl";
import type { FeedAction } from "./FeedActions";
import { supportsWake } from "../../../../packages/core/src/remote";
import "./control-override.css";
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
  onCapture,
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
  onCapture?: (artifact: Artifact) => void;
}) {
  const [busy, setBusy] = useState(false),
    [waking, setWaking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [owner, setOwner] = useState(data.config.settings.owner),
    [reason, setReason] = useState("Local recording and device control");
  const [mode, setMode] = useState(data.config.settings.captureMode);
  const [overrideSessionId, setOverrideSessionId] = useState<string | null>(null);
  // Stored lease credentials do not imply permission to send keys from a new popup.
  const [approvedSessionId, setApprovedSessionId] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusRemote = useRef(false);
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
  const overriding = Boolean(
    overrideSessionId &&
    session?.id === overrideSessionId &&
    session.state === "active" &&
    session.expiresAt > Date.now(),
  );
  const approved = owned && session?.id === approvedSessionId;
  const needsControlChoice = Boolean(session && !approved && !overriding);
  const controlAllowed =
    (approved || overriding || (!session && !overrideSessionId)) &&
    !device.locked;
  const enabled = controlAllowed && device.online;
  const latest = useRef({
    device,
    data,
    lease,
    session,
    owned,
    approved,
    overrideSessionId,
    overriding,
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
    approved,
    overrideSessionId,
    overriding,
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
  useLayoutEffect(() => {
    if (needsControlChoice) setOptionsOpen(true);
  }, [session?.id, needsControlChoice]);
  useLayoutEffect(() => {
    if (!optionsOpen && focusRemote.current) {
      focusRemote.current = false;
      panel.current
        ?.querySelector<HTMLElement>(".remote-component")
        ?.focus({ preventScroll: true });
    }
  }, [optionsOpen, overriding]);
  const chooseOverride = (sessionId: string | null) => {
    input.current.generation++;
    input.current.lease = null;
    setApprovedSessionId(null);
    setOverrideSessionId(sessionId);
    setError("");
    setNotice("");
    focusRemote.current = Boolean(sessionId);
    setOptionsOpen(!sessionId);
  };
  const run = async <T,>(fn: () => Promise<T>, rethrow = false): Promise<T | false> => {
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
      setOverrideSessionId(null);
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      setOptionsOpen(true);
      await refresh();
      if (rethrow) throw e;
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
    const result = await api<Artifact>(
      kind === "record" ? "recordings.start" : "captures.screenshot",
      { ...credentials, mode },
    );
    if (kind === "screenshot") onCapture?.(result);
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
    setApprovedSessionId(result.session.id);
    onLease(result);
    if (next)
      await capture(next, {
        sessionId: result.session.id,
        leaseToken: result.leaseToken,
      });
    else setNotice("Device reserved. Choose a control or capture action.");
    return { sessionId: result.session.id, leaseToken: result.leaseToken };
  };
  const screenshotToClipboard = () => {
    setError("");
    // The browser clipboard write must begin in this click's activation scope.
    void copyImageToClipboard(async () => {
      const result = await run(async () => {
        const credentials = owned ? lease : await reserve();
        const artifact = await api<Artifact>("captures.screenshot", { ...credentials, mode, clipboard: false });
        onCapture?.(artifact);
        const response = await fetch(`/v1/artifacts/${encodeURIComponent(artifact.id)}/file`);
        if (!response.ok) throw new Error("Screenshot saved, but its image could not be loaded for copying.");
        return response.blob();
      }, true);
      if (!result) throw new Error("Could not capture the screenshot.");
      return result;
    }).then(() => setNotice("Screenshot copied to this computer’s clipboard and saved in Captures."))
      .catch((error: Error) => { setError(error.message); setOptionsOpen(true); });
  };
  const send = (payload: { key?: string; text?: string; wake?: true }) => {
    const queue = input.current;
    const generation = queue.generation;
    const deviceId = latest.current.device.id;
    const expectedOverride = latest.current.overrideSessionId;
    const expectedWakeSession = latest.current.session?.id;
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
        if (payload.wake) {
          if (state.device.locked)
            throw new Error("This device is locked. Wake is unavailable.");
          if (
            state.session?.id !== expectedWakeSession ||
            (expectedOverride && !state.overriding)
          )
            throw new Error(
              "The reservation changed. Review it before waking this device.",
            );
          if (state.session && !state.approved && !state.overriding)
            throw new Error(
              `Reserved by ${state.session.owner}. Choose override before waking this device.`,
            );
          return await api("devices.wake", {
            deviceId,
            ...(expectedWakeSession
              ? { sessionId: expectedWakeSession, confirmed: true }
              : {}),
          });
        }
        if (!state.device.online || state.device.locked)
          throw new Error(
            "This device is offline or locked. Remote input is unavailable.",
          );
        if (expectedOverride) {
          if (!state.overriding || state.overrideSessionId !== expectedOverride)
            throw new Error(
              "The reservation changed. Choose how to continue from the remote menu.",
            );
          return await api("remote.override", {
            deviceId,
            sessionId: expectedOverride,
            confirmed: true,
            owner: state.data.config.settings.owner,
            ...payload,
          });
        }
        if (state.session && !state.approved && !queue.lease)
          throw new Error(
            `Reserved by ${state.session.owner}. Choose override from the remote menu before sending keys.`,
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
              `Reserved by ${state.session.owner}. Choose override or take the reservation from the remote menu.`,
            );
          const reserved: DeviceLease = await api("sessions.reserve", {
            selector: { device: deviceId },
            owner: state.owner,
            reason: state.reason,
          });
          setApprovedSessionId(reserved.session.id);
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
  const wake = async () => {
    setWaking(true);
    setNotice("");
    try {
      const result = await send({ wake: true });
      if (result !== false && input.current.mounted)
        setNotice("Wake request sent.");
      return result;
    } finally {
      setWaking(false);
    }
  };
  return (
    <div ref={panel} className={`device-control-panel intent-${initialAction}`}>
      {!optionsOpen && notice && (
        <p role="status" className="control-notice">
          {notice}
        </p>
      )}
      {overrideSessionId && (
        <div className="control-override-status" role="status">
          <div>
            <strong>{overriding ? "Override active" : "Override ended"}</strong>
            <span>
              {overriding
                ? `Reserved by ${session!.owner}`
                : "Reservation changed. Choose how to continue."}
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => chooseOverride(null)}
          >
            {overriding ? "Stop override" : "Review options"}
          </button>
        </div>
      )}
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
            {session && !approved && (
              <>
                <div className="control-override-choice">
                  <p>
                    Using controls can interrupt work or running regression tests.
                  </p>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      busy ||
                      Boolean(confirm) ||
                      (!device.online && !supportsWake(device)) ||
                      device.locked ||
                      session.state !== "active" ||
                      session.expiresAt <= Date.now() ||
                      (!supportsWake(device) &&
                        !device.capabilities.some(
                          (c) => c === "key" || c === "text",
                        ))
                    }
                    onClick={() => chooseOverride(session.id)}
                  >
                    Override — do not reserve
                  </button>
                  <p>
                    Reservation and recording stay active.
                  </p>
                </div>
                <h3 className="control-takeover-heading">
                  {owned ? "Manage your reservation" : "Or take the reservation"}
                </h3>
              </>
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
                Taking the reservation ends {session.owner}’s session. Any
                recording will stop and save first.
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
                        if (confirm === "takeover") {
                          const result: DeviceLease = await api(
                            "sessions.takeover",
                            {
                              deviceId: device.id,
                              owner,
                              reason,
                              confirmed: true,
                            },
                          );
                          setApprovedSessionId(result.session.id);
                          onLease(result);
                        } else
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
                void run<unknown>(() =>
                  owned ? capture("screenshot") : reserve("screenshot"),
                )
              }
            >
              <Camera size={17} />
              {owned ? "Take screenshot" : "Reserve & take screenshot"}
            </button>
            <button
              disabled={busy || !captureAllowed("screenshot") || (!owned && (!owner.trim() || !reason.trim()))}
              onClick={screenshotToClipboard}
              title="Save a screenshot and copy its image to the clipboard on this computer"
            >
              <Copy size={17} />
              Screenshot to clipboard
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
                  : void run<unknown>(() =>
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
        busy={busy || waking}
        wakeEnabled={
          controlAllowed && supportsWake(device) && !confirm && !optionsOpen
        }
        wake={wake}
        sendKey={(key) => send({ key })}
        sendText={(text) => send({ text })}
      />
    </div>
  );
}
