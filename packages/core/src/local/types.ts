import { z } from "zod";
import { reportRequestSchema, type UsageReport } from "../reports";
import type { LicenseStatus } from "../../../licensing/src";
import { streamOpenSchema, streamCredentialSchema, gestureInputSchema, pointerInputSchema, type GestureCapability } from "../live";
import { deviceFormFactor } from "../device-form-factor";
export const capabilitySchema = z.enum([
  "preview",
  "key",
  "text",
  "screenshot",
  "record",
  "restart",
  "touch",
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
    platform: z.enum(["Roku", "Android", "Apple", "Other"]),
    kind: z.enum(["physical", "virtual"]),
    model: z.string().max(256).default(""),
    tags: z
      .array(z.string().trim().min(1).max(48))
      .max(30)
      .refine((tags) => new Set(tags).size === tags.length, "Device tags must be unique.")
      .optional(),
    inputMode: z.enum(["touch", "remote"]).optional(),
    visibility: z.enum(["local", "shared"]).default("local"),
    connection: z.discriminatedUnion("type", [
      z.object({ type: z.literal("capture") }),
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
        avdName: z
          .string()
          .max(256)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
          .optional(),
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
export const tailscaleSchema = z
  .object({
    origin: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value &&
          !url.username && !url.password &&
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(url.hostname);
      } catch {
        return false;
      }
    }, "Use the canonical HTTPS origin of this Mac's Tailscale Serve address."),
    allowedUsers: z.array(z.string().min(1).max(320).regex(/^[^\s,*\x00-\x1f\x7f]+$/))
      .min(1).max(64)
      .refine((users) => new Set(users).size === users.length, "Tailscale logins must be unique."),
  })
  .strict();
const networkOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.origin === value && !url.username && !url.password;
  } catch { return false; }
}, "Use an exact HTTP or HTTPS origin, including its port when needed.");
export const networkSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9_.:-]+$/).default("127.0.0.1"),
  allowedHosts: z.array(z.string().min(1).max(260).regex(/^[A-Za-z0-9_.:\[\]-]+$/).refine((value) => {
    try {
      const url = new URL(`http://${value}`);
      return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  }, "Use a hostname or IP address, optionally with an exact port; wildcards are not supported.")
    .transform((value) => {
      const url = new URL(`http://${value}`);
      const explicitPort = /:(\d+)$/.exec(value)?.[1];
      return `${url.hostname}${explicitPort ? `:${Number(explicitPort)}` : ""}`;
    }))
    .max(128).default([]),
  allowedOrigins: z.array(networkOriginSchema).max(32).default([]),
  tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict().optional(),
  hubOrigin: networkOriginSchema.refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }, "The portal requires HTTPS; HTTP is allowed only for loopback development.").optional(),
}).strict();
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    port: z.number().int().min(0).max(65535).default(47831),
    tailscale: tailscaleSchema.optional(),
    network: networkSchema.optional(),
    devices: z.array(deviceSchema).default([]),
    sources: z.array(sourceSchema).default([]),
    ignoredCaptureCardIds: z.array(z.string().min(1).refine((id) => Boolean(id.trim()), "A capture card hardware ID cannot be blank."))
      .refine((ids) => new Set(ids).size === ids.length, "Ignored capture card hardware IDs must be unique.")
      .default([]),
    settings: settingsSchema,
    tools: z
      .object({
        adb: z.string().optional(),
        emulator: z.string().optional(),
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
export type Observation = {
  observedAt: number | null;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  nextRefreshAt: number;
};
export type Device = DeviceConfig & {
  observation?: Observation;
  readiness?: "starting" | "ready" | "offline";
  simulatorState?:
    "booted" | "shutdown" | "starting" | "stopping" | "unavailable";
  online: boolean;
  healthDetail: string;
  locked: boolean;
  lockReason?: string;
  capabilities: Capability[];
  gestureCapabilities?: GestureCapability[];
};
export const supportsSimulatorLifecycle = (d: DeviceConfig) =>
  d.kind === "virtual" &&
  (d.connection.type === "simulator" ||
    (d.connection.type === "adb" &&
      Boolean(
        d.connection.avdName || /^emulator-\d+$/.test(d.connection.serial),
      )));
export const canLaunchSimulator = (d: DeviceConfig) =>
  supportsSimulatorLifecycle(d) &&
  (d.connection.type !== "adb" || Boolean(d.connection.avdName));
export type Source = SourceConfig & {
  status: "connected" | "missing" | "unknown";
  detail?: string;
  observation?: Observation;
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
  groupId?: string;
  groupAlias?: string;
};
export type ReservationGroupMember = {
  alias: string;
  sessionId: string;
  deviceId: string;
  startedByGroup: boolean;
};
export type ReservationGroup = {
  id: string;
  owner: string;
  reason: string;
  requestHash: string;
  createdAt: number;
  expiresAt: number;
  state: "preparing" | "active" | "closing" | "closed";
  members: ReservationGroupMember[];
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
  inventoryObservation?: Observation;
  license: LicenseStatus;
  mode: "local";
  devices: Device[];
  sources: Source[];
  sessions: Session[];
  reservationGroups?: ReservationGroup[];
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
  reports: UsageReport;
};
export const selectorSchema = z
  .object({
    device: z.string().optional(),
    platform: z.enum(["Roku", "Android", "Apple", "Other"]).optional(),
    kind: z.enum(["physical", "virtual"]).optional(),
    formFactor: z.enum(["phone", "tv", "other"]).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(30).optional(),
    name: z.string().optional(),
    state: z
      .enum(["free", "reserved", "online", "offline", "locked"])
      .optional(),
    capabilities: z.array(capabilitySchema).optional(),
  })
  .strict();
export type Selector = z.infer<typeof selectorSchema>;
const reservationGroupIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/, "Use a stable CI/job identifier without spaces.");
export const reservationGroupManifestSchema = z
  .object({
    version: z.literal(1),
    groupId: reservationGroupIdSchema,
    owner: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(512),
    ttlMinutes: z.number().int().min(1).max(240).optional(),
    requests: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        z.object({ selector: selectorSchema }).strict(),
      )
      .refine((requests) => Object.keys(requests).length > 0, "At least one device request is required.")
      .refine((requests) => Object.keys(requests).length <= 32, "A group can request at most 32 devices."),
  })
  .strict();
export type ReservationGroupManifest = z.infer<typeof reservationGroupManifestSchema>;
const leaseFields = {
  sessionId: z.string().min(1),
  leaseToken: z.string().min(1),
};
const remoteInputFields = {
  key: z.string().max(64).optional(),
  text: z.string().min(1).max(4096).optional(),
  x: z.number().min(0).max(10000).optional(),
  y: z.number().min(0).max(10000).optional(),
};
export const operations = {
  inventory: z.object({ deviceIds: z.array(z.string()).max(1000).optional() }).strict(),
  "license.status": z.object({}).strict(),
  "license.activate": z
    .object({ key: z.string().trim().min(1).max(4096) })
    .strict(),
  "license.refresh": z.object({}).strict(),
  "license.deactivate": z.object({}).strict(),
  discover: z.object({ refresh: z.boolean().optional() }).strict(),
  "capture-cards.list": z.object({ refresh: z.boolean().optional() }).strict(),
  "reports.get": reportRequestSchema,
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
  "sessions.reserveGroup": reservationGroupManifestSchema.extend({
    leaseToken: z.string().min(32).max(256),
  }),
  "sessions.renewGroup": z
    .object({
      groupId: reservationGroupIdSchema,
      leaseToken: z.string().min(1),
      ttlMinutes: z.number().int().min(1).max(240).optional(),
    })
    .strict(),
  "sessions.releaseGroup": z
    .object({
      groupId: reservationGroupIdSchema,
      leaseToken: z.string().min(1),
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
  "devices.simulator": z
    .object({
      deviceId: z.string().min(1),
      action: z.enum(["launch", "close"]),
      confirmed: z.literal(true).optional(),
    })
    .strict(),
  "devices.wake": z
    .object({
      deviceId: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      confirmed: z.literal(true).optional(),
    })
    .strict(),
  "pairing.start": z.object(leaseFields).strict(),
  "pairing.finish": z
    .object({ ...leaseFields, pin: z.string().regex(/^\d{4,6}$/) })
    .strict(),
  "remote.input": z
    .object({
      ...leaseFields,
      ...remoteInputFields,
    })
    .strict(),
  "remote.gesture": z.object({ ...leaseFields, gesture: gestureInputSchema }).strict(),
  "control.start": z.object(leaseFields).strict(),
  "control.pointer": z.object({ ...leaseFields, event: pointerInputSchema }).strict(),
  "control.stop": z.object(leaseFields).strict(),
  "streams.open": streamOpenSchema,
  "streams.ping": streamCredentialSchema,
  "streams.close": streamCredentialSchema,
  "remote.override": z
    .object({
      deviceId: z.string().min(1),
      sessionId: z.string().min(1),
      confirmed: z.literal(true),
      owner: z.string().trim().min(1).max(128),
      ...remoteInputFields,
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
  "captures.openFolder": z.object({}).strict(),
  "captures.storage": z.object({}).strict(),
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
      (!selector.kind || d.kind === selector.kind) &&
      (!selector.formFactor || deviceFormFactor(d) === selector.formFactor) &&
      (!selector.tags ||
        selector.tags.every((tag) => (d.tags || []).includes(tag))) &&
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

/** Resolve a complete set of distinct, currently claimable devices. The
 * smallest candidate sets are assigned first so broad criteria cannot steal a
 * device needed by a more specific request. Offline virtual devices remain
 * eligible: the daemon claims the set first, then starts them as one unit. */
export function matchReservationGroup(
  devices: Device[],
  sessions: Session[],
  requests: ReservationGroupManifest["requests"],
  resourceIdentity: (device: Device) => string | null | undefined =
    (device) => device.captureSourceId,
) {
  const busy = new Set(
    sessions.filter((session) => session.state !== "closed").map((session) => session.deviceId),
  );
  const entries = Object.entries(requests).map(([alias, request]) => {
    const selector = request.selector.state === "free"
      ? { ...request.selector, state: undefined }
      : request.selector;
    const candidates = matchDevices(devices, sessions, selector)
      .filter((device) => !busy.has(device.id) && !device.locked)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
    return { alias, candidates };
  }).sort((a, b) => a.candidates.length - b.candidates.length || a.alias.localeCompare(b.alias));
  const selected = new Map<string, Device>();
  const deviceIds = new Set<string>();
  const sourceIds = new Set<string>();
  const assign = (index: number): boolean => {
    if (index === entries.length) return true;
    const entry = entries[index];
    for (const device of entry.candidates) {
      const sourceKey = resourceIdentity(device);
      if (deviceIds.has(device.id) || (sourceKey && sourceIds.has(sourceKey))) continue;
      selected.set(entry.alias, device);
      deviceIds.add(device.id);
      if (sourceKey) sourceIds.add(sourceKey);
      if (assign(index + 1)) return true;
      selected.delete(entry.alias);
      deviceIds.delete(device.id);
      if (sourceKey) sourceIds.delete(sourceKey);
    }
    return false;
  };
  return assign(0) ? Object.fromEntries(selected) : undefined;
}
