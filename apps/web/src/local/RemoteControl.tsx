import React, { useEffect, useId, useRef, useState } from "react";
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  CornerUpLeft,
  Play,
  Pause,
  Rewind,
  FastForward,
  RotateCcw,
  Asterisk,
  Keyboard,
  Send,
  Menu,
  Delete,
  Sun,
  Volume1,
  Volume2,
} from "lucide-react";
import type { Device } from "../../../../packages/core/src/local/types";
import {
  remoteLayout,
  supportsRemoteKey,
  supportsWake,
  wakeDescription,
} from "../../../../packages/core/src/remote";
import { useRemoteKeyboard } from "./use-remote-keyboard";
import {
  RemoteKeyTooltip,
  remoteShortcuts,
  type RemoteTooltip,
} from "./RemoteKeyTooltip";
import "./remote-feedback.css";
import "./mobile-remote.css";

const keyIcons: Record<string, React.ReactNode> = {
  Up: <ChevronUp />,
  Down: <ChevronDown />,
  Left: <ChevronLeft />,
  Right: <ChevronRight />,
  OK: <strong>OK</strong>,
  Back: <CornerUpLeft size={20} />,
  Home: <Home size={20} />,
  Rewind: <Rewind size={19} />,
  FastForward: <FastForward size={19} />,
  Play: <span className="play-pause"><Play size={16} /><Pause size={14} /></span>,
  Replay: <RotateCcw size={19} />,
  Backspace: <Delete size={19} />,
  VolumeDown: <Volume1 size={19} />,
  VolumeUp: <Volume2 size={19} />,
};

export function RemoteControl({
  device,
  enabled,
  busy,
  sendKey,
  sendText,
  wakeEnabled,
  wake,
  compact = false,
  preferenceScope,
}: {
  device: Device;
  enabled: boolean;
  busy: boolean;
  sendKey: (key: string) => Promise<unknown>;
  sendText: (text: string) => Promise<unknown>;
  wakeEnabled: boolean;
  wake: () => Promise<unknown>;
  compact?: boolean;
  preferenceScope?: string;
}) {
  const deviceKey = preferenceScope ? `${preferenceScope}:${device.id}` : device.id;
  const [text, setText] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [textSending, setTextSending] = useState(false);
  const element = useRef<HTMLElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const tooltipId = useId();
  const textPanelId = useId();
  const [tooltip, setTooltip] = useState<RemoteTooltip | null>(null);
  const layout = remoteLayout(device);
  const { profile } = layout;
  const currentDevice = useRef(deviceKey);
  currentDevice.current = deviceKey;
  useEffect(() => {
    setText("");
    setTooltip(null);
    setTextOpen(false);
    setTextSending(false);
  }, [deviceKey]);
  useEffect(() => {
    if (textOpen) textInput.current?.focus({ preventScroll: true });
  }, [textOpen]);
  const canKey = enabled && device.capabilities.includes("key");
  const hasKeys = layout.navigation.length > 0;
  const hasText = device.capabilities.includes("text");
  const hasDelete = hasKeys && supportsRemoteKey(device, "Backspace");
  const canWake = hasKeys && supportsWake(device);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTooltip(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, []);
  const { keyboard, pressedKeys, pressKey, toggleKeyboard } = useRemoteKeyboard(
    {
      element,
      device,
      enabled: canKey,
      busy,
      sendKey,
    },
  );
  const showTooltip = (target: EventTarget | null) => {
    if (matchMedia("(pointer: coarse)").matches) return;
    const button =
      target instanceof Element
        ? target.closest<HTMLButtonElement>("[data-remote-key]")
        : null;
    if (!button || !element.current?.contains(button)) return;
    setTooltip({
      element: button,
      label: button.getAttribute("aria-label") || "",
      shortcut: remoteShortcuts[button.dataset.remoteKey || ""] || "",
      unavailable:
        !canKey || !supportsRemoteKey(device, button.dataset.remoteKey || ""),
    });
  };
  const button = (
    key: string,
    label: string,
    className = "",
  ) => (
    <button
      type="button"
      key={key}
      className={className}
      aria-label={label}
      data-remote-key={key}
      data-pressed={pressedKeys.has(key)}
      aria-keyshortcuts={
        key === "Play"
          ? "Space"
          : key === "Up"
            ? "ArrowUp"
            : key === "Down"
              ? "ArrowDown"
              : key === "Left"
                ? "ArrowLeft"
                : key === "Right"
                  ? "ArrowRight"
                  : remoteShortcuts[key]
      }
      aria-describedby={
        tooltip?.element.dataset.remoteKey === key ? tooltipId : undefined
      }
      disabled={!canKey || busy || !supportsRemoteKey(device, key)}
      onClick={() => {
        setTooltip(null);
        pressKey(key);
      }}
    >
      {key === "Special" ? profile === "Roku" ? <Asterisk size={21} /> : <Menu size={21} /> : keyIcons[key]}
      <span>{label}</span>
    </button>
  );
  return (
    <section
      ref={element}
      tabIndex={-1}
      className={`remote-component ${compact ? "remote-compact" : ""}`}
      aria-label={`${profile} remote controls for ${device.name}`}
      data-remote-profile={profile}
      data-keyboard-remote={keyboard}
      onPointerOverCapture={(event) => {
        if (event.pointerType !== "touch") showTooltip(event.target);
      }}
      onPointerOutCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !tooltip?.element.contains(event.relatedTarget)
        )
          setTooltip(null);
      }}
      onFocusCapture={(event) => showTooltip(event.target)}
      onBlurCapture={() => setTooltip(null)}
    >
      {tooltip && <RemoteKeyTooltip id={tooltipId} tooltip={tooltip} />}
      {hasKeys && <div
        className={`remote-handset remote-${profile.toLowerCase().replaceAll(" ", "-")}`}
      >
        <div className="remote-brand">
          <span className="remote-indicator" data-active={canKey} />
          {profile}
          <small>{device.name}</small>
        </div>
        <div className="remote-top">
          {layout.top.map(({ key, label }) => button(key, label))}
        </div>
        <div className="remote-ring">
          {layout.navigation.map(({ key, label }) => button(key, label, `remote-${key.toLowerCase()}`))}
        </div>
        <div className="remote-media">
          {layout.media.map(({ key, label }) => button(key, label))}
        </div>
        <div className="remote-tools">
          {layout.tools.map(({ key, label }) => button(key, label))}
          {canWake && <button
            type="button"
            aria-label="Wake device"
            data-remote-action="wake"
            title={wakeDescription(device)}
            disabled={!wakeEnabled || busy}
            onClick={() => void wake()}
          >
            <Sun size={20} />
            <span>Wake</span>
          </button>}
        </div>
      </div>}
      {hasKeys && <button
        type="button"
        className={`keyboard-toggle ${keyboard ? "primary" : ""}`}
        aria-pressed={keyboard}
        aria-label={keyboard ? "Keyboard active · Esc to release" : "Use keyboard"}
        title={keyboard ? `Keyboard controls ${device.name}. Press Escape to release.` : `Use keyboard to control ${device.name}`}
        disabled={!canKey}
        onClick={toggleKeyboard}
      >
        <Keyboard size={17} />
        {keyboard
          ? compact ? "Keyboard on" : "Keyboard active · Esc to release"
          : "Use keyboard"}
      </button>}
      {keyboard && (
        <p className="remote-key-help" role="status">
          Arrows / Enter · B back · H home · Space play. Hover a control for its
          shortcut. Use Text entry to type on the device.
        </p>
      )}
      {(hasText || hasDelete) && <div className="remote-text-panel">
        {compact && <button type="button" className="remote-text-toggle" data-remote-action="text" aria-expanded={textOpen} aria-controls={textPanelId} onClick={() => setTextOpen((open) => !open)}><Keyboard size={15} />Text entry<ChevronDown size={14} /></button>}
        {(!compact || textOpen) && <form
        id={textPanelId}
        className="remote-text"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            !text ||
            !enabled ||
            busy || textSending ||
            !hasText
          )
            return;
          const targetDevice = deviceKey;
          const sentText = text;
          setTextSending(true);
          try {
            const result = await sendText(sentText);
            if (result !== false && currentDevice.current === targetDevice)
              setText((current) => current === sentText ? "" : current);
          } finally {
            if (currentDevice.current === targetDevice) setTextSending(false);
          }
        }}
      >
        {hasText && <input
          ref={textInput}
          aria-label={`Text for ${device.name}`}
          placeholder="Type text to send…"
          maxLength={4096}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!enabled}
        />}
        {hasText && <button
          type="submit"
          data-remote-action="send-text"
          disabled={
            !enabled || !text || busy || textSending
          }
          aria-label="Send text"
        >
          <Send size={17} />
        </button>}
        {hasDelete && button("Backspace", "Delete character")}
      </form>}
      </div>}
      {(!hasKeys || !device.capabilities.includes("key")) && (
        <p className="remote-unavailable" role="status">
          {!hasKeys
            ? "View only. Configure a Roku, Android / Fire TV, or Apple TV control connection to use a remote."
            : !device.online
              ? "Device offline. Reconnect it or try Wake to use the remote."
              : "Remote input is unavailable. Check this device’s control connection."}
        </p>
      )}
    </section>
  );
}
