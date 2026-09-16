import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Home, Lock, Power, Smartphone, Square, Volume1, Volume2 } from "lucide-react";
import type { Device } from "../../../../packages/core/src/local/types";
import { phoneHardwareButtons, type PhoneHardwareKey } from "../../../../packages/core/src/remote";
import type { LiveLease, LiveOperation } from "./LivePreview";
import "./phone-hardware-controls.css";

const icons = { Back: ArrowLeft, Home, Recents: Square, VolumeDown: Volume1, VolumeUp: Volume2, Power, Lock, SideButton: Smartphone };

/** Hardware input shares the feed's explicit touch permission and reservation. */
export function PhoneHardwareControls({ device, lease, operation, enabled, unavailableReason, onBeforeInput, onBusyChange }: {
  device: Device; lease: LiveLease; operation: LiveOperation; enabled: boolean;
  unavailableReason?: string;
  onBeforeInput: (signal: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<PhoneHardwareKey | null>(null);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const current = useRef({ device, lease, operation, enabled, onBeforeInput, onBusyChange });
  current.current = { device, lease, operation, enabled, onBeforeInput, onBusyChange };
  const buttons = phoneHardwareButtons(device);
  useEffect(() => {
    const cancel = () => {
      active.current?.abort(); active.current = null;
      setPending(null); current.current.onBusyChange(false);
    };
    setError("");
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("offline", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancel();
      window.removeEventListener("offline", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [device.id, lease.sessionId, lease.leaseToken, operation, enabled]);

  const send = async (key: PhoneHardwareKey) => {
    const latest = current.current;
    if (active.current || !latest.enabled || !navigator.onLine || document.hidden || !latest.device.capabilities.includes("key") || !phoneHardwareButtons(latest.device).some((button) => button.key === key)) return;
    const request = new AbortController();
    active.current = request;
    latest.onBusyChange(true); setPending(key); setError("");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    try {
      await latest.onBeforeInput(signal);
      signal.throwIfAborted();
      if (active.current !== request || !current.current.enabled) return;
      await latest.operation("remote.input", { ...latest.lease, key }, signal);
    } catch (failure) {
      if (active.current === request && !request.signal.aborted) setError(failure instanceof Error ? failure.message : "The button could not be sent. Try again when the device is ready.");
    } finally {
      if (active.current === request) { active.current = null; setPending(null); current.current.onBusyChange(false); }
    }
  };

  if (!buttons.length) return null;
  return <div className="phone-hardware-controls" role="group" aria-label={`Hardware buttons for ${device.name}`} aria-busy={Boolean(pending)}>
    <span className="phone-hardware-heading">Phone buttons</span>
    <div className="phone-hardware-buttons">{buttons.map(({ key, label }) => {
      const Icon = icons[key];
      return <button type="button" key={key} disabled={!enabled || Boolean(pending) || !device.capabilities.includes("key")} aria-label={label} onClick={() => void send(key)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button>;
    })}</div>
    {unavailableReason && <p className="phone-hardware-error" role="status">{unavailableReason}</p>}
    {error && <p className="phone-hardware-error" role="alert">{error}</p>}
  </div>;
}
