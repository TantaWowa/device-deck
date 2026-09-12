import {
  aggregateReport,
  resolveReportRange,
  type ReportRequest,
  type ReportSession,
  type ReportCapture,
} from "../../../../packages/core/src/reports";
/** Browser-only simulation. This module never imports or contacts the local service. */
export type Platform = "Roku" | "Android" | "Apple";
export type Device = {
  id: string;
  name: string;
  platform: Platform;
  kind: "physical" | "virtual";
  model: string;
  online: boolean;
  locked: boolean;
  visibility: "local" | "shared";
  captureSourceId: string;
  input: boolean;
};
export type Source = {
  uniqueId?: string;
  id: string;
  name: string;
  status: "connected" | "missing";
  kind: "usb" | "native";
};
export type Lease = {
  id: string;
  deviceId: string;
  owner: string;
  reason: string;
  expiresAt: number;
  mine: boolean;
};
export type InputEntry = {
  id: string;
  deviceId: string;
  sessionId: string;
  key: string;
  at: number;
  elapsedMs: number | null;
  recordingId: string | null;
  simulated: true;
  screenIndex: number;
};
export type Artifact = {
  id: string;
  deviceId: string;
  sessionId: string;
  name: string;
  tags: string[];
  kind: "screenshot" | "recording";
  createdAt: number;
  duration: number;
  origin: "Web" | "CLI" | "Agent";
  mode: "clean" | "annotated";
  sourceId: string;
  folder: string;
  log: InputEntry[];
  simulated: true;
};
export type HistoryEvent = {
  id: string;
  deviceId: string;
  sessionId?: string;
  at: number;
  action: string;
  owner: string;
  detail: string;
  captureId?: string;
};
export type Settings = {
  folder: string;
  naming: string;
  owner: string;
  clipboard: boolean;
  overlay: boolean;
  logging: boolean;
  captureMode: "clean" | "annotated";
  ttl: number;
};
export type Filters = {
  search: string;
  platform: string;
  health: string;
  reserved: string;
  locked: string;
  kind: string;
  visibility: string;
};
export const emptyFilters: Filters = {
  search: "",
  platform: "",
  health: "",
  reserved: "",
  locked: "",
  kind: "",
  visibility: "",
};
export const defaultSettings: Settings = {
  folder: "~/Movies/Device Deck",
  naming: "{device}-{date}-{time}",
  owner: "You",
  clipboard: false,
  overlay: true,
  logging: true,
  captureMode: "clean",
  ttl: 15,
};
export const seedDevices: Device[] = [
  {
    id: "roku-desk",
    name: "Desk Roku",
    platform: "Roku",
    kind: "physical",
    model: "Roku Ultra · ECP",
    online: true,
    locked: false,
    visibility: "shared",
    captureSourceId: "cam-link",
    input: true,
  },
  {
    id: "android-tv",
    name: "Living room TV",
    platform: "Android",
    kind: "physical",
    model: "Android TV · ADB",
    online: true,
    locked: false,
    visibility: "shared",
    captureSourceId: "hd60",
    input: true,
  },
  {
    id: "apple-sim",
    name: "Apple TV simulator",
    platform: "Apple",
    kind: "virtual",
    model: "tvOS simulator",
    online: true,
    locked: false,
    visibility: "local",
    captureSourceId: "native",
    input: true,
  },
  {
    id: "pixel-emulator",
    name: "Pixel emulator",
    platform: "Android",
    kind: "virtual",
    model: "Pixel 9 · Android emulator",
    online: true,
    locked: false,
    visibility: "local",
    captureSourceId: "native",
    input: true,
  },
  {
    id: "roku-stick",
    name: "Travel Roku",
    platform: "Roku",
    kind: "physical",
    model: "Roku Streaming Stick",
    online: false,
    locked: false,
    visibility: "local",
    captureSourceId: "",
    input: true,
  },
  {
    id: "shield",
    name: "Shield test bench",
    platform: "Android",
    kind: "physical",
    model: "Shield TV · ADB",
    online: true,
    locked: true,
    visibility: "shared",
    captureSourceId: "",
    input: true,
  },
  {
    id: "apple-tv",
    name: "Apple TV hardware",
    platform: "Apple",
    kind: "physical",
    model: "Apple TV 4K · discovery only",
    online: true,
    locked: false,
    visibility: "local",
    captureSourceId: "",
    input: false,
  },
  {
    id: "android-spare",
    name: "Android spare",
    platform: "Android",
    kind: "physical",
    model: "Google TV · ADB",
    online: true,
    locked: false,
    visibility: "shared",
    captureSourceId: "usb-video",
    input: true,
  },
];
export const sources: Source[] = [
  {
    id: "cam-link",
    uniqueId: "demo-usb-elgato-camlink-a1",
    name: "Cam Link 4K · USB 01 / HDMI",
    kind: "usb",
    status: "connected",
  },
  {
    id: "hd60",
    uniqueId: "demo-usb-elgato-hd60-b2",
    name: "Elgato HD60 X · USB 02 / HDMI",
    kind: "usb",
    status: "connected",
  },
  {
    id: "avermedia",
    uniqueId: "demo-usb-avermedia-c3",
    name: "AVerMedia Mini · USB 03 / HDMI",
    kind: "usb",
    status: "connected",
  },
  {
    id: "usb-video",
    uniqueId: "demo-usb-video-d4",
    name: "USB Video · USB 04 / HDMI",
    kind: "usb",
    status: "missing",
  },
  {
    id: "native",
    name: "Native emulator / simulator",
    kind: "native",
    status: "connected",
  },
];
export function filterDevices(devices: Device[], leases: Lease[], f: Filters) {
  return devices.filter(
    (d) =>
      (!f.search ||
        `${d.name} ${d.model}`
          .toLowerCase()
          .includes(f.search.toLowerCase())) &&
      (!f.platform || d.platform === f.platform) &&
      (!f.health || (d.online ? "online" : "offline") === f.health) &&
      (!f.reserved ||
        (leases.some((l) => l.deviceId === d.id) ? "reserved" : "free") ===
          f.reserved) &&
      (!f.locked || (d.locked ? "locked" : "unlocked") === f.locked) &&
      (!f.kind || d.kind === f.kind) &&
      (!f.visibility || d.visibility === f.visibility),
  );
}
export function cliCommand(d: Device) {
  return `devdeck remote --device '${d.name.replaceAll("'", "'\\''")}'`;
}
export function validateDevice(
  d: Device,
  devices: Device[],
  captureSources: Source[],
) {
  if (!d.name.trim()) throw new Error("Enter a friendly name.");
  if (d.name.length > 64)
    throw new Error("Use 64 characters or fewer for the name.");
  if (
    devices.some(
      (x) =>
        x.id !== d.id && x.name.toLowerCase() === d.name.trim().toLowerCase(),
    )
  )
    throw new Error("That friendly name is already in use.");
  if (
    d.captureSourceId &&
    !captureSources.some((s) => s.id === d.captureSourceId)
  )
    throw new Error("Choose a configured capture source.");
  if (d.captureSourceId === "native" && d.kind !== "virtual")
    throw new Error("Native capture requires an emulator or simulator.");
  const conflict =
    d.captureSourceId &&
    d.captureSourceId !== "native" &&
    devices.find(
      (x) => x.id !== d.id && x.captureSourceId === d.captureSourceId,
    );
  if (conflict)
    throw new Error(
      `Source conflict: already bound to ${conflict.name}. Choose another input or remove that binding first.`,
    );
}
type Recording = {
  id: string;
  startedAt: number;
  sessionId: string;
  mode: Settings["captureMode"];
  sourceId: string;
  folder: string;
  naming: string;
};
export class DemoModel {
  inventory = {
    devices: structuredClone(seedDevices),
    sources: structuredClone(sources),
    leases: [] as Lease[],
  };
  settings = { ...defaultSettings };
  artifacts: Artifact[] = [];
  recordings = new Map<string, Recording>();
  inputs: InputEntry[] = [];
  screenFocus: Record<string, number> = {};
  history: HistoryEvent[] = [];
  savedViews: { name: string; filters: Filters }[] = [];
  reportSessions: (ReportSession & { id: string })[] = [];
  reportCaptures: (ReportCapture & { id: string })[] = [];
  reportContentions: { deviceId: string; at: number }[] = [];
  report(request: ReportRequest = {}) {
    return aggregateReport(
      resolveReportRange(request, this.now()),
      this.reportSessions,
      this.reportCaptures,
      this.reportContentions,
    );
  }
  constructor(private now = () => Date.now()) {
    this.inventory.leases = [
      {
        id: "session-desk",
        deviceId: "roku-desk",
        owner: "You",
        reason: "Browse screen review",
        expiresAt: this.now() + 900000,
        mine: true,
      },
      {
        id: "session-agent",
        deviceId: "android-tv",
        owner: "Agent · regression",
        reason: "Nightly navigation checks",
        expiresAt: this.now() + 1800000,
        mine: false,
      },
    ];
    for (let i = 0; i < 6; i++) {
      const deviceId = ["roku-desk", "android-tv", "apple-sim"][i % 3];
      const sessionId =
        deviceId === "roku-desk"
          ? "session-desk"
          : deviceId === "android-tv"
            ? "session-agent"
            : "session-sim";
      const kind = i % 2 ? "recording" : "screenshot";
      this.artifacts.push({
        id: `sample-${i}`,
        deviceId,
        sessionId,
        name:
          [
            "browse-focus",
            "navigation-check",
            "launch-screen",
            "remote-walkthrough",
            "detail-page",
            "playback-check",
          ][i] + (kind === "screenshot" ? ".png" : ".mp4"),
        tags: i % 2 ? ["regression"] : ["review", "navigation"],
        kind,
        createdAt: this.now() - (i + 1) * 3600000,
        duration: kind === "recording" ? 42 + i * 17 : 0,
        origin: (["Web", "Agent", "CLI"] as const)[i % 3],
        mode: i % 2 ? "annotated" : "clean",
        sourceId: this.device(deviceId).captureSourceId,
        folder: defaultSettings.folder,
        log: [],
        simulated: true,
      });
    }
    this.history = this.artifacts.map((a) => ({
      id: `history-${a.id}`,
      deviceId: a.deviceId,
      sessionId: a.sessionId,
      at: a.createdAt,
      action: "Capture saved",
      owner: a.origin === "Agent" ? "Agent · regression" : "You",
      detail: a.name,
      captureId: a.id,
    }));
    this.history.unshift(
      {
        id: "h-reserve",
        deviceId: "roku-desk",
        sessionId: "session-desk",
        at: this.now() - 300000,
        action: "Session reserved",
        owner: "You",
        detail: "Browse screen review",
      },
      {
        id: "h-lock",
        deviceId: "shield",
        at: this.now() - 900000,
        action: "Maintenance locked",
        owner: "You",
        detail: "Firmware update and cable checks",
      },
      {
        id: "h-restart",
        deviceId: "apple-sim",
        at: this.now() - 4000000,
        action: "Restarted",
        owner: "You",
        detail: "Simulator restarted successfully",
      },
    );
    this.reportSessions = this.inventory.leases.map((l, i) => ({
      id: l.id,
      deviceId: l.deviceId,
      createdAt: this.now() - (i + 1) * 300000,
    }));
    for (const [index, days] of [1, 3, 10, 20].entries()) {
      const date = new Date(this.now());
      date.setDate(date.getDate() - days);
      date.setHours(10, 0, 0, 0);
      this.reportSessions.push({
        id: `report-seed-${index}`,
        deviceId: ["roku-desk", "android-tv", "apple-sim", "shield"][index],
        createdAt: date.getTime(),
        endedAt: date.getTime() + (index + 1) * 1800000,
      });
    }
    this.reportCaptures = this.artifacts.map((a) => ({
      id: a.id,
      deviceId: a.deviceId,
      createdAt: a.createdAt,
      status: "completed",
    }));
    this.reportCaptures.push(
      {
        id: "report-failed-1",
        deviceId: "android-spare",
        createdAt: this.now() - 900000,
        status: "failed",
      },
      {
        id: "report-failed-2",
        deviceId: "android-spare",
        createdAt: this.now() - 25 * 3600000,
        status: "interrupted",
      },
    );
    this.reportContentions = [
      { deviceId: "roku-desk", at: this.now() - 1800000 },
      { deviceId: "android-tv", at: this.now() - 49 * 3600000 },
    ];
  }
  assignCard(sourceId: string, deviceId: string | null) {
    const card = this.inventory.sources.find(
      (s) => s.id === sourceId && s.kind === "usb",
    );
    if (!card) throw new Error("Choose a physical USB capture card.");
    const previous = this.inventory.devices.find(
      (d) => d.captureSourceId === sourceId,
    );
    const next = deviceId ? this.device(deviceId) : undefined;
    for (const d of [previous, next])
      if (d && (this.lease(d.id) || this.recordings.has(d.id)))
        throw new Error(
          "Release the reserved device and stop recording before changing its binding.",
        );
    if (next?.captureSourceId && next.captureSourceId !== sourceId)
      throw new Error(
        `${next.name} already has a capture input. Unassign it first.`,
      );
    if (previous) previous.captureSourceId = "";
    if (next) next.captureSourceId = sourceId;
    this.event(
      next?.id || previous?.id || this.inventory.devices[0].id,
      "Capture card assigned",
      `${card.name} · ${next?.name || "Unassigned"}`,
    );
  }
  device(id: string) {
    const d = this.inventory.devices.find((x) => x.id === id);
    if (!d) throw new Error("Device not found.");
    return d;
  }
  lease(id: string) {
    return this.inventory.leases.find((x) => x.deviceId === id);
  }
  sourceIssue(id: string) {
    const d = this.device(id);
    if (!d.online) return "Device offline";
    if (!d.captureSourceId) return "No capture input configured";
    const s = this.inventory.sources.find((x) => x.id === d.captureSourceId);
    if (!s || s.status === "missing") return "Capture input disconnected";
    if (
      s.kind === "usb" &&
      this.inventory.devices.some(
        (x) => x.id !== id && x.captureSourceId === s.id,
      )
    )
      return "Capture source conflict";
    return "";
  }
  event(
    id: string,
    action: string,
    detail: string,
    sessionId?: string,
    captureId?: string,
    owner = this.lease(id)?.owner || this.settings.owner,
  ) {
    this.history.unshift({
      id: crypto.randomUUID(),
      deviceId: id,
      at: this.now(),
      action,
      detail,
      owner,
      sessionId,
      captureId,
    });
  }
  expire() {
    for (const l of [...this.inventory.leases])
      if (l.expiresAt <= this.now()) this.cleanup(l, "Session expired");
  }
  private cleanup(l: Lease, action: string) {
    const row = this.reportSessions.find((s) => s.id === l.id);
    if (row) row.endedAt = this.now();
    if (this.recordings.has(l.deviceId)) this.finishRecording(l.deviceId);
    this.inventory.leases = this.inventory.leases.filter((x) => x.id !== l.id);
    this.event(
      l.deviceId,
      action,
      `${l.owner} · ${l.reason}`,
      l.id,
      undefined,
      l.owner,
    );
  }
  reserve(id: string, reason: string, owner = this.settings.owner) {
    this.expire();
    const d = this.device(id);
    if (!d.online || d.locked)
      throw new Error("Device must be online and unlocked.");
    if (this.lease(id)) {
      this.reportContentions.push({ deviceId: id, at: this.now() });
      throw new Error("This device already has an owner.");
    }
    if (!reason.trim() || !owner.trim())
      throw new Error("Enter an owner label and a session reason.");
    const l = {
      id: crypto.randomUUID(),
      deviceId: id,
      owner: owner.trim(),
      reason: reason.trim(),
      expiresAt: this.now() + this.settings.ttl * 60000,
      mine: true,
    };
    this.inventory.leases.push(l);
    this.reportSessions.push({ id: l.id, deviceId: id, createdAt: this.now() });
    this.event(id, "Session reserved", l.reason, l.id);
    return l;
  }
  requireOwner(id: string) {
    this.expire();
    const l = this.lease(id);
    if (!l?.mine)
      throw new Error(
        "Reserve this device before controlling or capturing it.",
      );
    const d = this.device(id);
    if (!d.online || d.locked)
      throw new Error("Device is offline or maintenance locked.");
    return l;
  }
  release(id: string) {
    const l = this.lease(id);
    if (!l?.mine) throw new Error("Only your demo session can be released.");
    this.cleanup(l, "Session released");
  }
  renew(id: string) {
    this.requireOwner(id).expiresAt = this.now() + this.settings.ttl * 60000;
  }
  saveDevice(d: Device) {
    validateDevice(d, this.inventory.devices, this.inventory.sources);
    const existing = this.inventory.devices.find((x) => x.id === d.id);
    if (
      existing &&
      existing.captureSourceId !== d.captureSourceId &&
      this.lease(d.id)
    )
      throw new Error(
        "Stop recording and release the reserved device before changing its binding; wait for the other owner if needed.",
      );
    if (
      existing &&
      (this.recordings.has(d.id) ||
        (this.lease(d.id) && !this.lease(d.id)?.mine))
    )
      throw new Error(
        "Stop recording or wait for the other owner to release before editing.",
      );
    if (existing) Object.assign(existing, d, { name: d.name.trim() });
    else this.inventory.devices.push({ ...d, name: d.name.trim() });
    this.event(
      d.id,
      existing ? "Device updated" : "Device added",
      `${d.name} · ${d.captureSourceId || "No capture input"}`,
    );
  }
  bindSource(id: string, source: string) {
    this.saveDevice({ ...this.device(id), captureSourceId: source });
  }
  eligibility(id: string, action: "lock" | "unlock" | "restart") {
    const d = this.device(id);
    if (action === "unlock") return d.locked ? "" : "Already unlocked";
    if (this.lease(id)) return "Reserved: release the session first";
    if (action === "lock") return d.locked ? "Already locked" : "";
    if (d.locked) return "Maintenance locked";
    if (!d.online) return "Device offline";
    if (!d.input) return "Restart capability unavailable";
    return "";
  }
  bulk(ids: string[], action: "lock" | "unlock" | "restart") {
    this.expire();
    return ids.map((id) => {
      const reason = this.eligibility(id, action);
      if (reason) return { id, ok: false, detail: reason };
      const d = this.device(id);
      if (action !== "restart") d.locked = action === "lock";
      const detail =
        action === "restart"
          ? "Restarted successfully"
          : action === "lock"
            ? "Maintenance locked"
            : "Maintenance unlocked";
      this.event(id, detail, "Simulated bulk operation");
      return { id, ok: true, detail };
    });
  }
  input(id: string, key: string) {
    const l = this.requireOwner(id);
    if (!this.device(id).input)
      throw new Error("Remote input is unavailable on this device.");
    const r = this.recordings.get(id);
    const previous = this.screenFocus[id] || 0;
    this.screenFocus[id] =
      key === "Right" || key === "Down"
        ? (previous + 1) % 3
        : key === "Left" || key === "Up"
          ? (previous + 2) % 3
          : key === "Home"
            ? 0
            : previous;
    const entry: InputEntry = {
      id: crypto.randomUUID(),
      deviceId: id,
      sessionId: l.id,
      key,
      screenIndex: this.screenFocus[id],
      at: this.now(),
      elapsedMs: r ? this.now() - r.startedAt : null,
      recordingId: r?.id || null,
      simulated: true,
    };
    if (this.settings.logging) this.inputs.unshift(entry);
    return entry;
  }
  private requireSource(id: string) {
    this.requireOwner(id);
    const issue = this.sourceIssue(id);
    if (issue) throw new Error(issue);
  }
  capture(id: string) {
    this.requireSource(id);
    return this.artifact(id, "screenshot");
  }
  toggleRecording(id: string) {
    if (this.recordings.has(id)) {
      this.requireOwner(id);
      return this.finishRecording(id);
    }
    this.requireSource(id);
    const r = {
      id: crypto.randomUUID(),
      startedAt: this.now(),
      sessionId: this.lease(id)!.id,
      mode: this.settings.captureMode,
      sourceId: this.device(id).captureSourceId,
      folder: this.settings.folder,
      naming: this.settings.naming,
    };
    this.recordings.set(id, r);
    this.reportCaptures.push({
      id: r.id,
      deviceId: id,
      createdAt: r.startedAt,
      status: "recording",
    });
    this.event(id, "Recording started", "Simulated recording", r.sessionId);
  }
  private finishRecording(id: string) {
    const r = this.recordings.get(id)!;
    this.recordings.delete(id);
    return this.artifact(id, "recording", r);
  }
  private artifact(id: string, kind: Artifact["kind"], r?: Recording) {
    const time = new Date(this.now()).toISOString();
    const name = (r?.naming || this.settings.naming)
      .replaceAll(
        "{device}",
        this.device(id)
          .name.toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-"),
      )
      .replaceAll("{date}", time.slice(0, 10))
      .replaceAll("{time}", time.slice(11, 19).replaceAll(":", ""));
    const folder = r?.folder || this.settings.folder;
    const extension = kind === "screenshot" ? "png" : "mp4";
    let fileName = `${name}.${extension}`;
    let sequence = 2;
    while (
      this.artifacts.some((a) => a.folder === folder && a.name === fileName)
    ) {
      fileName = `${name}-${sequence++}.${extension}`;
    }
    const a: Artifact = {
      id: crypto.randomUUID(),
      deviceId: id,
      sessionId: r?.sessionId || this.lease(id)!.id,
      name: fileName,
      tags: [],
      kind,
      createdAt: this.now(),
      duration: r
        ? Math.max(1, Math.round((this.now() - r.startedAt) / 1000))
        : 0,
      origin: "Web",
      mode: r?.mode || this.settings.captureMode,
      sourceId: r?.sourceId || this.device(id).captureSourceId,
      folder,
      log: r
        ? this.inputs
            .filter((x) => x.recordingId === r.id)
            .slice()
            .reverse()
        : this.inputs
            .filter(
              (x) => x.deviceId === id && x.sessionId === this.lease(id)?.id,
            )
            .slice(0, 1),
      simulated: true,
    };
    this.artifacts.unshift(a);
    const attempt = r
      ? this.reportCaptures.find((c) => c.id === r.id)
      : undefined;
    if (attempt) attempt.status = "completed";
    else
      this.reportCaptures.push({
        id: a.id,
        deviceId: id,
        createdAt: r?.startedAt || a.createdAt,
        status: "completed",
      });
    this.event(
      id,
      "Capture saved",
      `${a.name} · simulated metadata`,
      a.sessionId,
      a.id,
    );
    return a;
  }
  editCapture(id: string, name: string, tags: string) {
    if (!name.trim() || /[\\/]/.test(name))
      throw new Error("Enter a file name without slashes.");
    const a = this.artifacts.find((x) => x.id === id);
    if (!a) throw new Error("Capture not found.");
    a.name = name.trim();
    a.tags = [
      ...new Set(
        tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
  }
  removeCaptures(ids: string[]) {
    const removed = this.artifacts.filter((a) => ids.includes(a.id));
    this.artifacts = this.artifacts.filter((a) => !ids.includes(a.id));
    return removed;
  }
  undoRemove(items: Artifact[]) {
    this.artifacts = [
      ...items.filter((a) => !this.artifacts.some((x) => x.id === a.id)),
      ...this.artifacts,
    ].sort((a, b) => b.createdAt - a.createdAt);
  }
  saveSettings(s: Settings) {
    if (!s.folder.trim() || !/^(~\/|\/)/.test(s.folder.trim()))
      throw new Error("Use an absolute Mac folder or a path starting with ~/.");
    if (!s.owner.trim()) throw new Error("Enter a default owner label.");
    if (
      !s.naming.trim() ||
      /[\\/]/.test(s.naming) ||
      !s.naming.includes("{time}")
    )
      throw new Error("Naming must include {time} and contain no slashes.");
    if (!Number.isFinite(s.ttl) || s.ttl < 1 || s.ttl > 240)
      throw new Error("Reservation length must be between 1 and 240 minutes.");
    this.settings = { ...s, folder: s.folder.trim() };
  }
  serialize() {
    return JSON.stringify({
      version: 2,
      reportSessions: this.reportSessions,
      reportCaptures: this.reportCaptures,
      reportContentions: this.reportContentions,
      inventory: this.inventory,
      artifacts: this.artifacts,
      inputs: this.inputs,
      screenFocus: this.screenFocus,
      history: this.history,
      settings: this.settings,
      savedViews: this.savedViews,
      recordings: [...this.recordings],
    });
  }
  restore(raw: string) {
    try {
      const data = JSON.parse(raw);
      if (
        data.version !== 2 ||
        !Array.isArray(data.inventory?.devices) ||
        !Array.isArray(data.inventory?.leases) ||
        !Array.isArray(data.inventory?.sources) ||
        !Array.isArray(data.artifacts) ||
        !Array.isArray(data.inputs) ||
        !Array.isArray(data.history) ||
        !Array.isArray(data.savedViews)
      )
        return false;
      for (const d of data.inventory.devices) {
        if (
          typeof d.id !== "string" ||
          typeof d.name !== "string" ||
          typeof d.model !== "string" ||
          !["Roku", "Android", "Apple"].includes(d.platform)
        )
          return false;
        validateDevice(d, data.inventory.devices, data.inventory.sources);
      }
      this.saveSettings({ ...defaultSettings, ...data.settings });
      this.inventory = data.inventory;
      this.artifacts = data.artifacts;
      this.inputs = data.inputs;
      this.screenFocus = data.screenFocus || {};
      this.history = data.history;
      this.reportSessions =
        data.reportSessions ||
        this.inventory.leases.map((l: Lease) => ({
          id: l.id,
          deviceId: l.deviceId,
          createdAt: this.now(),
        }));
      this.reportCaptures =
        data.reportCaptures ||
        this.artifacts.map((a) => ({
          id: a.id,
          deviceId: a.deviceId,
          createdAt: a.createdAt,
          status: "completed",
        }));
      this.reportContentions = data.reportContentions || [];
      for (const [, r] of data.recordings || []) {
        const attempt = this.reportCaptures.find((c) => c.id === r.id);
        if (attempt) attempt.status = "interrupted";
      }
      this.savedViews = data.savedViews;
      // A browser reload cannot resume a real recording. Retain an explicit interruption event.
      for (const [id, r] of data.recordings || [])
        this.event(
          id,
          "Recording interrupted",
          "Page reloaded; no playable video was created.",
          r.sessionId,
        );
      this.expire();
      return true;
    } catch {
      return false;
    }
  }
}
