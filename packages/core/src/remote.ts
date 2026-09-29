import type { DeviceConfig } from "./local/types";

/** Device class survives offline states and missing input helpers. */
export function deviceInputMode(d: Pick<DeviceConfig, "connection" | "inputMode"> & Partial<Pick<DeviceConfig, "model">>): "touch" | "remote" | "none" {
  switch (d.connection.type) {
    case "simulator": return d.connection.os === "ios" ? "touch" : "remote";
    case "apple-device": {
      // Older devicectl discoveries have no inputMode. Its hardware model is
      // trustworthy classification metadata; the user's device name is not.
      if (/^Apple\s?TV(?:\b|\d)/i.test(d.model || "")) return "remote";
      if (/^(?:iPhone|iPad|iPod)(?:\b|\d)/i.test(d.model || "")) return "touch";
      return d.inputMode || "touch";
    }
    case "roku":
    case "apple-tv": return "remote";
    case "adb": return d.inputMode || "touch";
    case "capture": return d.inputMode || "none";
  }
}

// Protocol references: https://developer.roku.com/dev/docs/external-control-api
// https://developer.android.com/reference/android/view/KeyEvent
// https://pyatv.dev/api/interface/
// Transport key names follow Roku ECP and Android KeyEvent. Apple Companion
// uses skip backward/forward for the media seek buttons (native/apple-tv.py).
export const androidKeys: Record<string, string> = {
  Up: "DPAD_UP",
  Down: "DPAD_DOWN",
  Left: "DPAD_LEFT",
  Right: "DPAD_RIGHT",
  OK: "DPAD_CENTER",
  Select: "DPAD_CENTER",
  Back: "BACK",
  Home: "HOME",
  Recents: "APP_SWITCH",
  Power: "POWER",
  Menu: "MENU",
  Special: "MENU",
  Play: "MEDIA_PLAY_PAUSE",
  "Play / pause": "MEDIA_PLAY_PAUSE",
  Rewind: "MEDIA_REWIND",
  FastForward: "MEDIA_FAST_FORWARD",
  Replay: "MEDIA_SKIP_BACKWARD",
  Backspace: "DEL",
  VolumeUp: "VOLUME_UP",
  VolumeDown: "VOLUME_DOWN",
};
export const rokuKeys: Record<string, string> = {
  ...Object.fromEntries(
    [
      "Up",
      "Down",
      "Left",
      "Right",
      "Back",
      "Home",
      "Play",
      "Backspace",
      "VolumeUp",
      "VolumeDown",
      "Rev",
      "Fwd",
      "InstantReplay",
      "Info",
    ].map((k) => [k, k]),
  ),
  OK: "Select",
  Select: "Select",
  Menu: "Info",
  Special: "Info",
  "Play / pause": "Play",
  Rewind: "Rev",
  FastForward: "Fwd",
  Replay: "InstantReplay",
};
export const hidKeys: Record<string, string> = {
  Up: "82",
  Down: "81",
  Left: "80",
  Right: "79",
  OK: "40",
  Select: "40",
  Back: "41",
  Backspace: "42",
  Play: "44",
  "Play / pause": "44",
};
// idb ui button exposes HOME, LOCK and SIDE_BUTTON. It has no volume or
// app-switcher button; iOS also has no system Back button.
// https://fbidb.io/docs/idb/ui/
export const iosHardwareKeys: Record<string, string> = {
  Home: "HOME",
  Lock: "LOCK",
  SideButton: "SIDE_BUTTON",
};
export type PhoneHardwareKey = "Back" | "Home" | "Recents" | "VolumeDown" | "VolumeUp" | "Power" | "Lock" | "SideButton";
export type PhoneHardwareButton = { key: PhoneHardwareKey; label: string };
const androidHardwareButtons: readonly PhoneHardwareButton[] = [
  { key: "Back", label: "Back" },
  { key: "Home", label: "Home" },
  { key: "Recents", label: "Recents" },
  { key: "VolumeDown", label: "Volume down" },
  { key: "VolumeUp", label: "Volume up" },
  { key: "Power", label: "Power" },
];
const iosHardwareButtons: readonly PhoneHardwareButton[] = [
  { key: "Home", label: "Home" },
  { key: "Lock", label: "Lock" },
  { key: "SideButton", label: "Side button" },
];
/** Availability follows the configured input transport, never a phone-like
 * name or a capture feed. Runtime readiness and reservation checks still apply. */
export function phoneHardwareButtons(d: DeviceConfig): readonly PhoneHardwareButton[] {
  if (deviceInputMode(d) !== "touch") return [];
  if (d.connection.type === "adb") return androidHardwareButtons;
  if (d.connection.type === "simulator" && d.connection.os === "ios") return iosHardwareButtons;
  return [];
}
export const remoteProfiles = [
  "Roku",
  "Fire TV",
  "Android TV",
  "Apple TV",
  "Device",
] as const;
export type RemoteProfile = (typeof remoteProfiles)[number];
export function remoteProfile(d: DeviceConfig): RemoteProfile {
  // Device names are editable labels. They must not turn a Roku connected to a
  // Samsung display into a Samsung remote, or change a key's meaning.
  switch (d.connection.type) {
    case "roku": return "Roku";
    case "apple-tv": return "Apple TV";
    case "simulator": return d.connection.os === "tvos" ? "Apple TV" : "Device";
    case "apple-device": return deviceInputMode(d) === "remote" ? "Apple TV" : "Device";
    case "adb":
      return /\b(?:AFT[A-Z0-9]+|fire[ -]?tv|amazon)\b/i.test(d.model.replaceAll("_", " "))
        ? "Fire TV" : "Android TV";
    default: return "Device";
  }
}
export type RemoteButton = { key: string; label: string };
/** Visible keys are selected by transport; aliases do not become duplicate
 * buttons. This also keeps simulator remotes honest about their smaller set. */
export function remoteLayout(d: DeviceConfig): {
  profile: RemoteProfile;
  navigation: RemoteButton[];
  top: RemoteButton[];
  media: RemoteButton[];
  tools: RemoteButton[];
} {
  const profile = remoteProfile(d);
  const supported = (buttons: RemoteButton[]) =>
    deviceInputMode(d) === "remote" ? buttons.filter(({ key }) => supportsRemoteKey(d, key)) : [];
  const apple = d.connection.type === "apple-tv";
  return {
    profile,
    navigation: supported([
      { key: "Up", label: "Up" }, { key: "Left", label: "Left" },
      { key: "OK", label: "OK" }, { key: "Right", label: "Right" },
      { key: "Down", label: "Down" },
    ]),
    top: supported([
      { key: "Back", label: "Back" }, { key: "Home", label: "Home" },
      ...(d.connection.type === "adb" ? [{ key: "Special", label: "Menu" }] : []),
    ]),
    media: supported([
      { key: "Rewind", label: apple ? "Skip back" : "Rewind" },
      { key: "Play", label: "Play / pause" },
      { key: "FastForward", label: apple ? "Skip forward" : "Fast forward" },
    ]),
    tools: supported([
      ...(!apple ? [{ key: "Replay", label: "Replay" }] : []),
      ...(d.connection.type === "roku" ? [{ key: "Special", label: "Options" }] : []),
      { key: "VolumeDown", label: "Volume down" },
      { key: "VolumeUp", label: "Volume up" },
    ]),
  };
}
export function supportsRemoteKey(d: DeviceConfig, key: string) {
  switch (d.connection.type) {
    case "roku":
      return Boolean(rokuKeys[key]);
    case "adb":
      return Boolean(androidKeys[key]);
    case "simulator":
      return d.connection.os === "ios"
        ? Boolean(iosHardwareKeys[key]) || (key !== "Back" && Boolean(hidKeys[key]))
        : key === "Home" || Boolean(hidKeys[key]);
    case "apple-tv":
      return [
        "Up",
        "Down",
        "Left",
        "Right",
        "OK",
        "Select",
        "Back",
        "Menu",
        "Special",
        "Home",
        "Play",
        "Play / pause",
        "Rewind",
        "FastForward",
        "Replay",
        "VolumeUp",
        "VolumeDown",
      ].includes(key);
    default:
      return false;
  }
}
/** Wake is determined by the configured transport, never the remote's appearance. */
export function supportsWake(d: DeviceConfig): boolean {
  return ["roku", "adb", "apple-tv", "simulator"].includes(d.connection.type);
}
export function wakeDescription(d: DeviceConfig): string {
  switch (d.connection.type) {
    case "roku":
      return "Attempt to wake this Roku. Players receive Home, which may leave the current app; Roku TVs receive Power On.";
    case "adb":
      return "Attempt to wake the screen. Devices that are already awake stay awake.";
    case "apple-tv":
      return "Attempt to turn on this Apple TV using its paired Companion connection.";
    case "simulator":
      return "Send Home to wake a running simulator. This may leave the current app; stopped simulators must be launched first.";
    default:
      return "Wake is unavailable for this device's configured connection.";
  }
}
export const keyboardRemoteKeys: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "OK",
  Backspace: "Backspace",
  " ": "Play",
  b: "Back",
  h: "Home",
  r: "Rewind",
  f: "FastForward",
  p: "Replay",
  s: "Special",
};
