import type { DeviceConfig } from "./local/types";
import { deviceInputMode } from "./remote";

export type DeviceFormFactor = "tv" | "phone" | "other";
export type DeviceFormFactorMetadata = Partial<Pick<DeviceConfig, "connection" | "inputMode" | "model" | "platform">>;

/** Form factor is independent of physical/simulated environment and readiness.
 * Use the same discovered hardware/input metadata as the remote/touch controls;
 * display names and the temporary availability of input helpers are irrelevant. */
export function deviceFormFactor(device?: DeviceFormFactorMetadata): DeviceFormFactor {
  if (!device) return "other";
  if (device.connection) {
    const mode = deviceInputMode({ connection: device.connection, inputMode: device.inputMode, model: device.model });
    return mode === "remote" ? "tv" : mode === "touch" ? "phone" : "other";
  }
  // Older capture-library callers may retain only partial device metadata.
  // Roku is unambiguous; Apple/Android alone could mean either a TV or a phone.
  if (device.platform === "Roku") return "tv";
  if (/^Apple\s?TV(?:\b|\d)/i.test(device.model || "")) return "tv";
  if (/^(?:iPhone|iPad|iPod)(?:\b|\d)/i.test(device.model || "")) return "phone";
  return device.inputMode === "remote" ? "tv" : device.inputMode === "touch" ? "phone" : "other";
}
