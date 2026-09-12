import type { Config, Source, SourceConfig } from "./local/types";
export type DetectedCard = { uniqueId: string; name: string; inUse?: string };
export function mergeCaptureCards(
  configured: SourceConfig[],
  detected: DetectedCard[],
  idFor: (id: string) => string,
): Source[] {
  const byHardware = new Map<string, Source>();
  for (const source of configured.filter((s) => s.kind === "usb" && s.uniqueId))
    byHardware.set(source.uniqueId!, { ...source, status: "missing" });
  for (const card of detected) {
    const old = byHardware.get(card.uniqueId);
    byHardware.set(card.uniqueId, {
      ...(old || {
        id: idFor(card.uniqueId),
        name: card.name,
        kind: "usb",
        uniqueId: card.uniqueId,
      }),
      status: "connected",
      detail:
        card.inUse === "true" ? "In use by another application" : undefined,
    });
  }
  return [...byHardware.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function assignCaptureCard(
  config: Config,
  card: SourceConfig,
  deviceId: string | null,
): Config {
  if (card.kind !== "usb" || !card.uniqueId)
    throw new Error("Choose a physical USB capture card.");
  const next = structuredClone(config);
  const existing = next.sources.find(
    (s) => s.kind === "usb" && s.uniqueId === card.uniqueId,
  );
  const source = existing || card;
  const previous = next.devices.find((d) => d.captureSourceId === source.id);
  const device = deviceId
    ? next.devices.find((d) => d.id === deviceId)
    : undefined;
  if (deviceId && !device) throw new Error("Choose a configured device.");
  if (device?.captureSourceId && device.captureSourceId !== source.id)
    throw new Error(
      `${device.name} already has a capture input. Unassign it first in Devices or Capture Cards.`,
    );
  if (previous) previous.captureSourceId = null;
  if (device) {
    device.captureSourceId = source.id;
    if (!existing) next.sources.push(source);
  }
  return next;
}
