import { callOperation } from "../../../packages/core/src/client";
import type { DiscoveredDevices } from "../../../packages/core/src/discovery";
import { DeckError } from "../../../packages/core/src/local/types";

export async function discoverRegistration(
  wanted: { udid?: string; avd?: string; serial?: string },
  discover: () => Promise<DiscoveredDevices> = () => callOperation("discover", { refresh: true }),
) {
  let diagnostics: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await discover();
    const match = found.devices.find((device) => {
      const connection = device.connection;
      return (wanted.udid && (connection.type === "simulator" || connection.type === "apple-device") && connection.udid.toLowerCase() === wanted.udid.toLowerCase()) ||
        (wanted.avd && connection.type === "adb" && connection.avdName === wanted.avd) ||
        (wanted.serial && connection.type === "adb" && connection.serial === wanted.serial);
    });
    if (match) return { found, match };
    diagnostics = found.diagnostics;
  }
  throw new DeckError("no-match", "Discovery found no device with that identifier.", 404, { diagnostics });
}
