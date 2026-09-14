import React, { useEffect, useState } from "react";
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
} from "lucide-react";
import type { Device } from "../../../../packages/core/src/local/types";
import {
  remoteProfile,
  remoteProfiles,
  supportsRemoteKey,
  keyboardRemoteKeys,
  type RemoteProfile,
} from "../../../../packages/core/src/remote";

export function RemoteControl({
  device,
  enabled,
  busy,
  sendKey,
  sendText,
}: {
  device: Device;
  enabled: boolean;
  busy: boolean;
  sendKey: (key: string) => Promise<unknown>;
  sendText: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [keyboard, setKeyboard] = useState(false);
  const [profile, setProfile] = useState<RemoteProfile>(() => {
    const saved = localStorage.getItem(`deck-remote-style-${device.id}`);
    return remoteProfiles.find((p) => p === saved) || remoteProfile(device);
  });
  const canKey = enabled && device.capabilities.includes("key");
  useEffect(() => {
    if (!canKey) setKeyboard(false);
  }, [canKey]);
  useEffect(() => {
    if (!keyboard || !canKey) return;
    const listener = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.isComposing ||
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      // Only the topmost dialog may capture keyboard input.
      const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
      const remote = document.querySelector('[data-keyboard-remote="true"]');
      if (dialogs.length && !dialogs[dialogs.length - 1].contains(remote))
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setKeyboard(false);
        return;
      }
      const key =
        keyboardRemoteKeys[event.key] ||
        keyboardRemoteKeys[event.key.toLowerCase()];
      if (key && supportsRemoteKey(device, key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy && !event.repeat) void sendKey(key);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [keyboard, canKey, busy, device, sendKey]);
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
      title={
        supportsRemoteKey(device, key)
          ? label
          : `${label} is unavailable with this connection`
      }
      disabled={!canKey || busy || !supportsRemoteKey(device, key)}
      onClick={() => void sendKey(key)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <section className="remote-component" data-keyboard-remote={keyboard}>
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
        onClick={() => setKeyboard((k) => !k)}
      >
        <Keyboard size={17} />
        {keyboard ? "Keyboard input on · Esc to exit" : "Keyboard input"}
      </button>
      {keyboard && (
        <p className="remote-key-help" role="status">
          Arrows / Enter · B back · H home · Space play · R rewind · F forward ·
          P replay · S special. Text goes through the field below.
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
