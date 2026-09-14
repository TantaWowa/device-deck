import packageInfo from "../../../package.json";
declare const __DEVICE_DECK_VERSION__: string;
export const version = typeof __DEVICE_DECK_VERSION__ === "undefined" ? packageInfo.version : __DEVICE_DECK_VERSION__;
