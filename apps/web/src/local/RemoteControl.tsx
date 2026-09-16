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
} from "lucide-react";
import type { Device } from "../../../../packages/core/src/local/types";
import {
  remoteProfile,
  remoteProfiles,
  supportsRemoteKey,
  wakeDescription,
  type RemoteProfile,
} from "../../../../packages/core/src/remote";
import { useRemoteKeyboard } from "./use-remote-keyboard";
import {
  RemoteKeyTooltip,
  remoteShortcuts,
  type RemoteTooltip,
} from "./RemoteKeyTooltip";
import "./remote-feedback.css";

export function RemoteControl({
  device,
  enabled,
  busy,
  sendKey,
  sendText,
  wakeEnabled,
  wake,
}: {
  device: Device;
  enabled: boolean;
  busy: boolean;
  sendKey: (key: string) => Promise<unknown>;
  sendText: (text: string) => Promise<unknown>;
  wakeEnabled: boolean;
  wake: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const element = useRef<HTMLElement>(null);
  const tooltipId = useId();
  const [tooltip, setTooltip] = useState<RemoteTooltip | null>(null);
  const [profile, setProfile] = useState<RemoteProfile>(() => {
    const saved = localStorage.getItem(`deck-remote-style-${device.id}`);
    return remoteProfiles.find((p) => p === saved) || remoteProfile(device);
  });
  const canKey = enabled && device.capabilities.includes("key");
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
    const button =
      target instanceof Element
        ? target.closest<HTMLButtonElement>("[data-remote-key]")
        : null;
    if (!button || !element.current?.contains(button)) return;
    setTooltip({
      element: button,
      label: button.getAttribute("aria-label") || "",
      shortcut: remoteShortcuts[button.dataset.remoteKey || ""],
      unavailable:
        !canKey || !supportsRemoteKey(device, button.dataset.remoteKey || ""),
    });
  };
  const button = (
    key: string,
    label: string,
    icon: React.ReactNode,
    className = "",
  ) => (
    <button
      type="button"
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
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <section
      ref={element}
      tabIndex={-1}
      className="remote-component"
      data-keyboard-remote={keyboard}
      onPointerOverCapture={(event) => showTooltip(event.target)}
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
      <label className="remote-style-picker">
        Remote style
        <select
          value={profile}
          onChange={(e) => {
            const p = e.target.value as RemoteProfile;
            setProfile(p);
            localStorage.setItem(`deck-remote-style-${device.id}`, p);
          }}
        >
          {remoteProfiles.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <div
        className={`remote-handset remote-${profile.toLowerCase().replaceAll(" ", "-")}`}
      >
        <div className="remote-brand">
          <span className="remote-indicator" data-active={canKey} />
          {profile}
          <small>{device.name}</small>
        </div>
        <div className="remote-top">
          {button("Back", "Back", <CornerUpLeft size={20} />)}
          {button("Home", "Home", <Home size={20} />)}
          <button
            type="button"
            aria-label="Wake device"
            data-remote-action="wake"
            title={wakeDescription(device)}
            disabled={!wakeEnabled || busy}
            onClick={() => void wake()}
          >
            <Sun size={20} />
            <span>Wake</span>
          </button>
        </div>
        <div className="remote-ring">
          {button("Up", "Up", <ChevronUp />, "remote-up")}
          {button("Left", "Left", <ChevronLeft />, "remote-left")}
          {button("OK", "OK", <strong>OK</strong>, "remote-ok")}
          {button("Right", "Right", <ChevronRight />, "remote-right")}
          {button("Down", "Down", <ChevronDown />, "remote-down")}
        </div>
        <div className="remote-media">
          {button(
            "Rewind",
            profile === "Apple TV" ? "Skip back" : "Rewind",
            <Rewind size={19} />,
          )}
          {button(
            "Play",
            "Play / pause",
            <span className="play-pause">
              <Play size={16} />
              <Pause size={14} />
            </span>,
          )}
          {button(
            "FastForward",
            profile === "Apple TV" ? "Skip forward" : "Fast forward",
            <FastForward size={19} />,
          )}
          {button("Replay", "Replay", <RotateCcw size={19} />)}
          {button(
            "Special",
            profile === "Roku" ? "Special / options" : "Special / menu",
            profile === "Roku" ? <Asterisk size={21} /> : <Menu size={21} />,
          )}
          {button("Backspace", "Delete character", <Delete size={19} />)}
        </div>
        {["Samsung", "LG"].includes(profile) && (
          <p className="remote-style-note">
            Visual style only. Keys use the configured {device.connection.type}{" "}
            connection.
          </p>
        )}
      </div>
      <button
        type="button"
        className={`keyboard-toggle ${keyboard ? "primary" : ""}`}
        aria-pressed={keyboard}
        disabled={!canKey}
        onClick={toggleKeyboard}
      >
        <Keyboard size={17} />
        {keyboard
          ? "Keyboard locked · Esc to release"
          : "Keyboard unlocked · Click to lock"}
      </button>
      {keyboard && (
        <p className="remote-key-help" role="status">
          Arrows / Enter · B back · H home · Space play · R rewind · F forward ·
          P replay · S special · Backspace delete. Text goes through the field
          below.
        </p>
      )}
      <form
        className="remote-text"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            !text ||
            !enabled ||
            busy ||
            !device.capabilities.includes("text")
          )
            return;
          const result = await sendText(text);
          if (result !== false) setText("");
        }}
      >
        <input
          aria-label={`Text for ${device.name}`}
          placeholder="Type text to send…"
          maxLength={4096}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!enabled || !device.capabilities.includes("text")}
        />
        <button
          disabled={
            !enabled || !text || busy || !device.capabilities.includes("text")
          }
          aria-label="Send text"
        >
          <Send size={17} />
        </button>
      </form>
      {!device.capabilities.includes("key") && (
        <p className="remote-key-help">
          Remote input needs a connected control adapter. Edit the device to
          configure Roku, Fire TV / Android ADB, or Apple TV. Samsung and LG
          control adapters are not available yet.
        </p>
      )}
    </section>
  );
}
