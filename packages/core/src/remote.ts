import type { DeviceConfig } from "./local/types";

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
export const remoteProfiles = [
  "Roku",
  "Fire TV",
  "Android TV",
  "Apple TV",
  "Samsung",
  "LG",
] as const;
export type RemoteProfile = (typeof remoteProfiles)[number];
export function remoteProfile(d: DeviceConfig): RemoteProfile {
  const name = `${d.name} ${d.model}`;
  if (/fire|amazon/i.test(name)) return "Fire TV";
  if (/samsung/i.test(name)) return "Samsung";
  if (/\blg\b|webos/i.test(name)) return "LG";
  return d.platform === "Roku"
    ? "Roku"
    : d.platform === "Apple"
      ? "Apple TV"
      : "Android TV";
}
export function supportsRemoteKey(d: DeviceConfig, key: string) {
  switch (d.connection.type) {
    case "roku":
      return Boolean(rokuKeys[key]);
    case "adb":
      return Boolean(androidKeys[key]);
    case "simulator":
      return key === "Home" || Boolean(hidKeys[key]);
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
