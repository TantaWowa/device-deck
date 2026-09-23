import type { DeviceConfig } from "./local/types";

export function deviceEditorMetadata(
  device: DeviceConfig | undefined,
  tags: string,
) {
  return {
    model: device?.model || "",
    ...(device?.inputMode ? { inputMode: device.inputMode } : {}),
    tags: [
      ...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean)),
    ],
  };
}
