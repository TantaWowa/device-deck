import { z } from "zod";
export const capabilitySchema = z.enum([
  "preview",
  "key",
  "text",
  "screenshot",
  "record",
  "restart",
]);
export type Capability = z.infer<typeof capabilitySchema>;
export const deviceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/),
    name: z.string().trim().min(1).max(64),
    platform: z.enum(["Roku", "Android", "Apple"]),
    kind: z.enum(["physical", "virtual"]),
    model: z.string().max(256).default(""),
    visibility: z.enum(["local", "shared"]).default("local"),
    connection: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("roku"),
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[\w.:-]+$/),
        serial: z.string().min(1),
      }),
      z.object({
        type: z.literal("adb"),
        serial: z.string().min(1).max(256),
        hardwareId: z.string().min(1).max(256).optional(),
        port: z.number().int().min(1).max(65535).default(5037),
      }),
      z.object({
        type: z.literal("simulator"),
        udid: z.string().uuid(),
        os: z.enum(["ios", "tvos"]),
      }),
      z.object({
        type: z.literal("apple-tv"),
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[\w.:-]+$/),
        identifier: z.string().min(1),
      }),
      z.object({ type: z.literal("apple-device"), udid: z.string().min(1) }),
    ]),
    captureSourceId: z.string().nullable().default(null),
  })
  .strict();
export type DeviceConfig = z.infer<typeof deviceSchema>;
export const sourceSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(256),
    kind: z.enum(["usb", "native"]),
    deviceId: z.string().optional(),
    uniqueId: z.string().optional(),
  })
  .strict();
export type SourceConfig = z.infer<typeof sourceSchema>;
export const settingsSchema = z
  .object({
    folder: z.string().min(1),
    naming: z.string().default("{device}-{date}-{time}"),
    owner: z.string().trim().min(1).max(128).default("You"),
    ttl: z.number().int().min(1).max(240).default(15),
    overlay: z.boolean().default(true),
    logging: z.boolean().default(true),
    clipboard: z.boolean().default(false),
    captureMode: z.enum(["clean", "annotated"]).default("clean"),
    maxRecordingMinutes: z.number().int().min(1).max(120).default(15),
    previewIntervalMs: z.number().int().min(250).max(5000).default(750),
  })
  .strict();
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    port: z.number().int().min(0).max(65535).default(47831),
    devices: z.array(deviceSchema).default([]),
    sources: z.array(sourceSchema).default([]),
    settings: settingsSchema,
    tools: z
      .object({
        adb: z.string().optional(),
        ffmpeg: z.string().optional(),
        ffprobe: z.string().optional(),
        idb: z.string().optional(),
        python: z.string().optional(),
      })
      .strict()
      .default({}),
    savedViews: z
      .array(
        z.object({
          name: z.string().min(1).max(32),
          filters: z.record(z.string()),
        }),
      )
      .default([]),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Device = DeviceConfig & {
  online: boolean;
  healthDetail: string;
  locked: boolean;
  lockReason?: string;
  capabilities: Capability[];
};
export type Source = SourceConfig & {
  status: "connected" | "missing";
  detail?: string;
};
export type Session = {
  id: string;
  deviceId: string;
  sourceId: string | null;
  owner: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  state: "active" | "closing" | "closed";
  endedAt?: number;
  closeReason?: string;
};
export type Event = {
  id: number;
  at: number;
  deviceId: string;
  sessionId?: string;
  owner: string;
  action: string;
  detail: string;
  durationMs?: number;
};
export type Input = {
  id: number;
  at: number;
  deviceId: string;
  sessionId: string;
  key: string;
  recordingId: string | null;
  elapsedMs: number | null;
};
export type Artifact = {
  id: string;
  deviceId: string;
  sessionId: string;
  owner: string;
  sourceId: string;
  name: string;
  path: string;
  cleanPath?: string;
  logPath: string;
  logging?: boolean;
  kind: "screenshot" | "recording";
  mode: "clean" | "annotated";
  tags: string[];
  createdAt: number;
  duration: number;
  bytes: number;
  status: "recording" | "finalizing" | "completed" | "failed" | "interrupted";
  error?: string;
  deletedAt?: number;
  purgedAt?: number;
  origin: "Web" | "CLI" | "Agent" | "API";
};
export type Snapshot = {
  mode: "local";
  devices: Device[];
  sources: Source[];
  sessions: Session[];
  artifacts: Artifact[];
  events: Event[];
  inputs: Input[];
  config: Config;
  configRevision: string;
  configError: string | null;
  diagnostics: string[];
  recordings: {
    id: string;
    deviceId: string;
    sessionId: string;
    startedAt: number;
  }[];
  reports: {
    sessions: number;
    reservedMs: number;
    contentions: number;
    captureAttempts: number;
    captureFailures: number;
    byDevice: { deviceId: string; reservedMs: number }[];
  };
};
export const selectorSchema = z
  .object({
    device: z.string().optional(),
    platform: z.enum(["Roku", "Android", "Apple"]).optional(),
    name: z.string().optional(),
    state: z
      .enum(["free", "reserved", "online", "offline", "locked"])
      .optional(),
    capabilities: z.array(capabilitySchema).optional(),
  })
  .strict();
export type Selector = z.infer<typeof selectorSchema>;
const leaseFields = {
  sessionId: z.string().min(1),
  leaseToken: z.string().min(1),
};
export const operations = {
  inventory: z.object({}).strict(),
  discover: z.object({}).strict(),
  "config.get": z.object({}).strict(),
  "config.save": z
    .object({ config: configSchema, revision: z.string() })
    .strict(),
  "sessions.reserve": z
    .object({
      selector: selectorSchema,
      owner: z.string().trim().min(1).max(128),
      reason: z.string().trim().min(1).max(512),
      ttlMinutes: z.number().int().min(1).max(240).optional(),
    })
    .strict(),
  "sessions.renew": z
    .object({
      ...leaseFields,
      ttlMinutes: z.number().int().min(1).max(240).optional(),
    })
    .strict(),
  "sessions.release": z.object(leaseFields).strict(),
  "sessions.takeover": z
    .object({
      deviceId: z.string(),
      reason: z.string().trim().min(1),
      owner: z.string().trim().min(1),
      confirmed: z.literal(true),
    })
    .strict(),
  "devices.bulk": z
    .object({
      ids: z.array(z.string()).min(1).max(100),
      action: z.enum(["lock", "unlock", "restart"]),
      reason: z.string().trim().min(1),
    })
    .strict(),
  "pairing.start": z.object(leaseFields).strict(),
  "pairing.finish": z
    .object({ ...leaseFields, pin: z.string().regex(/^\d{4,6}$/) })
    .strict(),
  "remote.input": z
    .object({
      ...leaseFields,
      key: z.string().max(64).optional(),
      text: z.string().min(1).max(4096).optional(),
      x: z.number().min(0).max(10000).optional(),
      y: z.number().min(0).max(10000).optional(),
    })
    .strict(),
  "captures.screenshot": z
    .object({
      ...leaseFields,
      mode: z.enum(["clean", "annotated"]).optional(),
      clipboard: z.boolean().optional(),
    })
    .strict(),
  "recordings.start": z
    .object({ ...leaseFields, mode: z.enum(["clean", "annotated"]).optional() })
    .strict(),
  "recordings.stop": z.object(leaseFields).strict(),
  "captures.edit": z
    .object({
      id: z.string(),
      name: z.string().min(1).max(180),
      tags: z.array(z.string().trim().min(1).max(48)).max(30),
    })
    .strict(),
  "captures.remove": z
    .object({
      ids: z.array(z.string()).min(1).max(100),
      confirmed: z.literal(true),
    })
    .strict(),
  "captures.purge": z
    .object({
      ids: z.array(z.string()).min(1).max(100),
      confirmed: z.literal(true),
    })
    .strict(),
  "captures.restore": z
    .object({ ids: z.array(z.string()).min(1).max(100) })
    .strict(),
} as const;
export type Operation = keyof typeof operations;
export class DeckError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): never {
  throw new DeckError(code, message, status, details);
}
export function matchDevices(
  devices: Device[],
  sessions: Session[],
  selector: Selector,
) {
  return devices.filter(
    (d) =>
      (!selector.device ||
        [d.id.toLowerCase(), d.name.toLowerCase()].includes(
          selector.device.toLowerCase(),
        )) &&
      (!selector.platform || d.platform === selector.platform) &&
      (!selector.name ||
        d.name
          .toLowerCase()
          .includes(selector.name.toLowerCase().replaceAll("*", ""))) &&
      (!selector.capabilities ||
        selector.capabilities.every((c) => d.capabilities.includes(c))) &&
      (!selector.state ||
        (selector.state === "free"
          ? !sessions.some(
              (s) => s.deviceId === d.id && s.state !== "closed",
            ) &&
            !d.locked &&
            d.online
          : selector.state === "reserved"
            ? sessions.some((s) => s.deviceId === d.id && s.state !== "closed")
            : selector.state === "locked"
              ? d.locked
              : selector.state === "online"
                ? d.online
                : !d.online)),
  );
}
