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
  return assignCaptureCards(config, [{ card, deviceId }]);
}

function physicalCard(card: SourceConfig): SourceConfig {
  if (card.kind !== "usb" || !card.uniqueId?.trim())
    throw new Error("Choose a physical USB capture card.");
  // Discovery fields describe a live observation and must not be persisted.
  const parsed = sourceSchema.safeParse({
    id: card.id,
    name: card.name,
    kind: card.kind,
    uniqueId: card.uniqueId,
  });
  if (!parsed.success || !card.id.trim() || !card.name.trim())
    throw new Error("USB capture card details are invalid.");
  return parsed.data;
}

export function assignCaptureCards(
  config: Config,
  assignments: { card: SourceConfig; deviceId: string | null }[],
): Config {
  const next = structuredClone(config);
  const hardware = new Set<string>(), sourceIds = new Set<string>(), targets = new Set<string>();
  const changes = assignments.map(({ card, deviceId }) => {
    const parsed = physicalCard(card);
    if (hardware.has(parsed.uniqueId!))
      throw new Error("Choose each capture card only once.");
    hardware.add(parsed.uniqueId!);
    const existing = next.sources.find((source) => source.kind === "usb" && source.uniqueId === parsed.uniqueId);
    const source = existing || parsed;
    if (sourceIds.has(source.id) || !existing && next.sources.some((item) => item.id === source.id))
      throw new Error("This capture source ID is already used by another input.");
    sourceIds.add(source.id);
    const device = deviceId === null ? undefined : next.devices.find((item) => item.id === deviceId);
    if (deviceId !== null && !device)
      throw new Error("Choose a configured device.");
    if (device && targets.has(device.id))
      throw new Error("Choose each target device only once.");
    if (device) targets.add(device.id);
    return { source, existing, device };
  });
  // Clear every selected binding first so swaps are one atomic configuration edit.
  for (const device of next.devices)
    if (device.captureSourceId && sourceIds.has(device.captureSourceId))
      device.captureSourceId = null;
  for (const { source, existing, device } of changes) {
    if (!device) continue;
    if (device.captureSourceId)
      throw new Error(`${device.name} already has a capture input. Unassign it first in Devices or Capture Cards.`);
    device.captureSourceId = source.id;
    if (!existing) next.sources.push(source);
    next.ignoredCaptureCardIds = next.ignoredCaptureCardIds.filter((id) => id !== source.uniqueId);
  }
  if (next.devices.some((device) => device.connection.type === "capture" && !device.captureSourceId))
    throw new Error(
      "Capture-only devices require a USB capture input. Assign another selected card or delete the card and its capture-only device.",
    );
  return next;
}

export function deleteCaptureCards(config: Config, cards: SourceConfig[]): Config {
  const hardware = new Set(cards.map((card) => physicalCard(card).uniqueId!));
  const next = structuredClone(config);
  const removed = new Set(next.sources.filter((source) => source.kind === "usb" && hardware.has(source.uniqueId!)).map((source) => source.id));
  next.sources = next.sources.filter((source) => !removed.has(source.id));
  next.devices = next.devices.filter((device) =>
    device.connection.type !== "capture" || !device.captureSourceId || !removed.has(device.captureSourceId),
  );
  for (const device of next.devices)
    if (device.captureSourceId && removed.has(device.captureSourceId))
      device.captureSourceId = null;
  next.ignoredCaptureCardIds = [...new Set([...next.ignoredCaptureCardIds, ...hardware])];
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
  next.ignoredCaptureCardIds = next.ignoredCaptureCardIds.filter((id) => id !== source.uniqueId);
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
