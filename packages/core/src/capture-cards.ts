import {
  deviceSchema,
  sourceSchema,
  type Config,
  type Source,
  type SourceConfig,
} from "./local/types";
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

export function assignCustomCaptureCard(
  config: Config,
  card: SourceConfig,
  custom: { id: string; name: string },
): Config {
  if (
    card.kind !== "usb" ||
    typeof card.uniqueId !== "string" ||
    !card.uniqueId.trim()
  )
    throw new Error("Choose a physical USB capture card.");
  // Discovery adds live status fields; only persist source configuration.
  const parsedCard = sourceSchema.safeParse({
    id: card.id,
    name: card.name,
    kind: card.kind,
    uniqueId: card.uniqueId,
  });
  if (!parsedCard.success || !card.id.trim() || !card.name.trim())
    throw new Error("USB capture card details are invalid.");
  const parsedName = deviceSchema.shape.name.safeParse(custom.name);
  if (!parsedName.success)
    throw new Error("Enter a device name between 1 and 64 characters.");
  if (!deviceSchema.shape.id.safeParse(custom.id).success)
    throw new Error("Enter a valid device ID.");
  const existing = config.sources.find(
    (source) => source.kind === "usb" && source.uniqueId === card.uniqueId,
  );
  const source = existing || parsedCard.data;
  if (!existing && config.sources.some((item) => item.id === source.id))
    throw new Error("This capture source ID is already used by another input.");
  const previous = config.devices.find(
    (device) => device.captureSourceId === source.id,
  );
  const renamedId =
    previous?.connection.type === "capture" ? previous.id : undefined;
  if (
    config.devices.some(
      (device) =>
        device.id !== renamedId &&
        device.name.toLowerCase() === parsedName.data.toLowerCase(),
    )
  )
    throw new Error("A device with this name already exists.");
  if (
    !renamedId &&
    config.devices.some(
      (device) => device.id.toLowerCase() === custom.id.toLowerCase(),
    )
  )
    throw new Error("This device ID is already in use.");

  const next = structuredClone(config);
  if (renamedId) {
    // Keeping the ID also keeps reservations, history and captures associated.
    next.devices.find((device) => device.id === renamedId)!.name =
      parsedName.data;
    return next;
  }
  if (previous)
    next.devices.find((device) => device.id === previous.id)!.captureSourceId =
      null;
  if (!existing) next.sources.push(parsedCard.data);
  next.devices.push({
    id: custom.id,
    name: parsedName.data,
    platform: "Other",
    kind: "physical",
    model: "USB capture",
    visibility: "local",
    connection: { type: "capture" },
    captureSourceId: source.id,
  });
  return next;
}
