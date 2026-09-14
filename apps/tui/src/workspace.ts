import { spawn } from "node:child_process";
import { browserUrl, callOperation } from "../../../packages/core/src/client";
import {
  isDeviceConfigured,
  registerDiscoveredDevices,
  registrationIssue,
  type DiscoveredDevices,
} from "../../../packages/core/src/discovery";
import {
  remoteProfile,
  supportsRemoteKey,
} from "../../../packages/core/src/remote";
import {
  supportsSimulatorLifecycle,
  canLaunchSimulator,
  type Artifact,
  type Config,
  type Device,
  type Session,
  type Snapshot,
} from "../../../packages/core/src/local/types";
import type { UsageReport } from "../../../packages/core/src/reports";
import { clean, glyphs } from "./screen";
import type { Key } from "./terminal";

export const menus = [
  "Devices",
  "Feeds",
  "Captures",
  "Sessions",
  "History",
  "Reports",
  "Settings",
  "License",
] as const;
export type View = (typeof menus)[number];
export type Row = {
  id: string;
  label: string;
  meta: string;
  detail: string[];
  tone?: "good" | "warn" | "bad";
};
export type Action = {
  key: string;
  label: string;
  run: () => void;
  disabled?: boolean;
};
export type Field = {
  label: string;
  value: string;
  max?: number;
  required?: boolean;
};
export type Dialog =
  | {
      kind: "menu";
      title: string;
      description: string;
      actions: Action[];
      index: number;
    }
  | {
      kind: "form";
      title: string;
      description: string;
      fields: Field[];
      index: number;
      submit: (values: string[]) => void;
    }
  | { kind: "info"; title: string; lines: string[]; index: number };
export type Acquired = { session: Session; leaseToken: string };
type Lease = { sessionId: string; leaseToken: string };
export type Dependencies = {
  call: typeof callOperation;
  open: (target: string) => Promise<void>;
  url: typeof browserUrl;
};
const dependencies: Dependencies = {
  call: callOperation,
  url: browserUrl,
  open: (target) =>
    new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/open", [target], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Unable to open item (${code}).`)),
      );
    }),
};
const date = (value: number) => new Date(value).toLocaleString();
export const duration = (ms: number) => `${Math.round(ms / 60000)} min`;
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export const remoteKeys: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  return: "OK",
  b: "Back",
  h: "Home",
  space: "Play",
  "[": "Rewind",
  "]": "FastForward",
  p: "Replay",
  "*": "Special",
  backspace: "Backspace",
};

/** State and commands are independent of terminal IO, including lease ownership. */
export class Workspace {
  snapshot?: Snapshot;
  view: View = "Devices";
  focus: "menu" | "items" = "items";
  indices: Record<string, number> = {};
  filter = "";
  platform = "";
  kind = "";
  trash = false;
  discovery?: DiscoveredDevices;
  selectedDevices = new Set<string>();
  selectedFeeds = new Set<string>();
  report?: UsageReport;
  reportPreset: "day" | "week" | "month" = "day";
  remoteId?: string;
  dialog?: Dialog;
  status = "Connecting to the local daemon…";
  error = false;
  busy = "";
  refreshing = false;
  done = false;
  pageSize = 10;
  version = 0;
  private leases = new Map<string, Lease>();
  pending?: Promise<void>;
  private remoteOnly: boolean;
  private initialRemote?: string;
  private generation = 0;
  private sendingKeys = false;
  private inputQueue: string[] = [];
  constructor(
    readonly io: Dependencies = dependencies,
    options: {
      remoteId?: string;
      acquired?: Acquired;
      remoteOnly?: boolean;
    } = {},
  ) {
    this.initialRemote = options.remoteId;
    this.remoteOnly = Boolean(options.remoteOnly);
    if (options.acquired)
      this.leases.set(options.acquired.session.deviceId, {
        sessionId: options.acquired.session.id,
        leaseToken: options.acquired.leaseToken,
      });
  }
  changed() {
    this.version++;
  }
  notice(message: string, error = false) {
    this.status = clean(message);
    this.error = error;
    this.changed();
  }
  get key() {
    return this.discovery ? "Discovery" : this.view;
  }
  get index() {
    return this.indices[this.key] || 0;
  }
  set index(value: number) {
    this.indices[this.key] = Math.max(
      0,
      Math.min(value, this.rows().length - 1),
    );
  }
  get selected() {
    return this.rows()[this.index];
  }
  get remote() {
    return this.snapshot?.devices.find((d) => d.id === this.remoteId);
  }
  session(id: string) {
    return this.snapshot?.sessions.find(
      (s) => s.deviceId === id && s.state !== "closed",
    );
  }
  lease(id: string) {
    const lease = this.leases.get(id),
      session = this.session(id);
    return lease &&
      session?.id === lease.sessionId &&
      session.state === "active"
      ? lease
      : undefined;
  }
  recording(id: string) {
    return this.snapshot?.recordings.find((r) => r.deviceId === id);
  }
  deviceName(id: string) {
    return this.snapshot?.devices.find((d) => d.id === id)?.name || id;
  }
  async refresh() {
    if (this.refreshing || this.done) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const snapshot: Snapshot = await this.io.call("inventory");
      if (this.done || generation !== this.generation) return;
      const selection = this.selected?.id;
      this.snapshot = snapshot;
      for (const [id, lease] of this.leases)
        if (
          !snapshot.sessions.some(
            (s) => s.id === lease.sessionId && s.state !== "closed",
          )
        )
          this.leases.delete(id);
      const rows = this.rows(),
        next = rows.findIndex((r) => r.id === selection);
      this.index = next >= 0 ? next : this.index;
      if (this.initialRemote) {
        this.remoteId = this.initialRemote;
        this.initialRemote = undefined;
      }
      if (this.status.startsWith("Connecting"))
        this.notice("Ready. Select an item; Enter shows its actions.");
      this.changed();
    } catch (e) {
      this.notice(
        `${(e as Error).message} · R retries; W opens the dashboard.`,
        true,
      );
    } finally {
      this.refreshing = false;
    }
  }
  run(
    label: string,
    work: () => Promise<void>,
    after?: () => void,
    refreshAfter = true,
  ) {
    if (this.busy) return;
    this.generation++;
    this.busy = label;
    this.changed();
    this.pending = (async () => {
      let succeeded = false;
      try {
        await work();
        succeeded = true;
      } catch (e) {
        this.notice((e as Error).message, true);
      } finally {
        if (refreshAfter) await this.refresh();
        this.busy = "";
        this.changed();
      }
      if (succeeded) after?.();
    })();
  }
  switchView(view: View) {
    this.view = view;
    this.discovery = undefined;
    this.remoteId = undefined;
    this.dialog = undefined;
    this.changed();
  }
  menu(title: string, actions: Action[], description = "") {
    this.dialog = { kind: "menu", title, description, actions, index: 0 };
    this.changed();
  }
  form(
    title: string,
    fields: Field[],
    submit: (values: string[]) => void,
    description = "",
  ) {
    this.dialog = {
      kind: "form",
      title,
      fields,
      index: 0,
      submit,
      description,
    };
    this.changed();
  }
  info(title: string, lines: string[]) {
    this.dialog = { kind: "info", title, lines, index: 0 };
    this.changed();
  }
  confirm(title: string, description: string, proceed: () => void) {
    this.menu(
      title,
      [
        { key: "n", label: "Cancel", run: () => {} },
        { key: "y", label: "Confirm", run: proceed },
      ],
      description,
    );
  }
  rows(): Row[] {
    const s = this.snapshot;
    if (!s) return [];
    if (this.discovery)
      return this.discovery.devices.map((d) => {
        const issue = isDeviceConfigured(s.config, d)
          ? "Already added"
          : registrationIssue(d);
        return {
          id: d.id,
          label: `${issue ? "[-]" : this.selectedDevices.has(d.id) ? "[x]" : "[ ]"} ${d.name}`,
          meta: `${d.platform} · ${issue || "Ready to add"}`,
          detail: [
            d.name,
            d.platform,
            d.model,
            issue ||
              "Space selects this device. A selects all available devices.",
            ...this.discovery!.diagnostics,
          ],
          tone: issue ? "warn" : "good",
        };
      });
    switch (this.view) {
      case "Devices":
        return s.devices
          .filter(
            (d) =>
              (!this.filter ||
                d.name.toLowerCase().includes(this.filter.toLowerCase())) &&
              (!this.platform || d.platform === this.platform) &&
              (!this.kind || d.kind === this.kind),
          )
          .map((d) => {
            const session = this.session(d.id),
              recording = this.recording(d.id);
            return {
              id: d.id,
              label: d.name,
              meta: `${d.platform} · ${d.kind === "virtual" ? "Sim" : "Real"} · ${recording ? "REC" : d.simulatorState === "starting" ? "Launching" : d.simulatorState === "stopping" ? "Closing" : d.locked ? "LOCKED" : session ? "RESERVED" : d.online ? "Ready" : d.simulatorState === "shutdown" ? "Stopped" : "Offline"}`,
              detail: [
                d.name,
                `${d.platform} · ${d.kind} · ${d.model}`,
                d.healthDetail,
                d.locked ? `Locked: ${d.lockReason || ""}` : "",
                session
                  ? `${this.lease(d.id) ? "Your TUI session" : session.owner}: ${session.reason}`
                  : "Available for reservation",
                session ? `Expires ${date(session.expiresAt)}` : "",
                recording ? `Recording since ${date(recording.startedAt)}` : "",
                `Capture: ${s.sources.find((c) => c.id === d.captureSourceId)?.name || "None linked"}`,
                `Controls: ${d.capabilities.join(", ")}`,
              ].filter(Boolean),
              tone: d.locked || session ? "warn" : d.online ? "good" : "bad",
            };
          });
      case "Feeds":
        return s.sources.map((c) => ({
          id: c.id,
          label: `${this.selectedFeeds.has(c.id) ? "[x]" : "[ ]"} ${c.name}`,
          meta: `${c.kind.toUpperCase()} · ${c.status}`,
          detail: [
            c.name,
            c.detail || c.status,
            `Device: ${s.devices.find((d) => d.captureSourceId === c.id)?.name || "Unassigned"}`,
            "Space selects feeds. G opens the selection as a split screen in the browser.",
            "Enter opens feed actions.",
          ],
          tone: c.status === "connected" ? "good" : "warn",
        }));
      case "Captures":
        return s.artifacts
          .filter((a) => !a.purgedAt && Boolean(a.deletedAt) === this.trash)
          .map((a) => ({
            id: a.id,
            label: a.name,
            meta: `${a.kind === "recording" ? "VIDEO" : "PHOTO"} · ${a.status}`,
            detail: [
              a.name,
              `${a.kind} · ${a.mode} · ${a.status}`,
              this.deviceName(a.deviceId),
              `${a.owner} · ${date(a.createdAt)}`,
              `${size(a.bytes)}${a.duration ? ` · ${a.duration.toFixed(1)} sec` : ""}`,
              `Tags: ${a.tags.join(", ") || "None"}`,
              a.path,
              a.error || "",
            ].filter(Boolean),
            tone: a.status === "failed" ? "bad" : undefined,
          }));
      case "Sessions":
        return s.sessions
          .filter((a) => a.state !== "closed")
          .map((a) => ({
            id: a.id,
            label: this.deviceName(a.deviceId),
            meta: `${this.lease(a.deviceId) ? "YOURS" : a.owner} · ${a.state}`,
            detail: [
              this.deviceName(a.deviceId),
              `Owner: ${a.owner}`,
              `Reason: ${a.reason}`,
              `Started ${date(a.createdAt)}`,
              `Expires ${date(a.expiresAt)}`,
              this.recording(a.deviceId)
                ? "Recording in progress"
                : "No recording",
              this.lease(a.deviceId)
                ? "This TUI holds the session credential."
                : "Owned by another client. Taking over needs confirmation.",
            ],
            tone: "warn",
          }));
      case "History":
        return s.events.map((e) => ({
          id: String(e.id),
          label: `${new Date(e.at).toLocaleTimeString()} ${e.action}`,
          meta: this.deviceName(e.deviceId),
          detail: [
            date(e.at),
            this.deviceName(e.deviceId),
            e.owner,
            e.action,
            e.detail,
          ],
        }));
      case "Reports":
        return (this.report || s.reports).byDevice.map((d) => ({
          id: d.deviceId,
          label: this.deviceName(d.deviceId),
          meta: `${d.sessions} sessions · ${duration(d.reservedMs)}`,
          detail: [
            this.deviceName(d.deviceId),
            `Reservations: ${d.sessions}`,
            `Reserved: ${duration(d.reservedMs)}`,
            `Capture attempts: ${d.captureAttempts}`,
            `Capture failures: ${d.captureFailures}`,
            `Contentions: ${d.contentions}`,
          ],
        }));
      case "Settings":
        return (
          [
            "owner",
            "folder",
            "ttl",
            "maxRecordingMinutes",
            "captureMode",
            "overlay",
            "logging",
            "clipboard",
            "previewIntervalMs",
          ] as const
        ).map((key) => ({
          id: key,
          label: settingLabels[key],
          meta: String(s.config.settings[key]),
          detail: [
            settingLabels[key],
            String(s.config.settings[key]),
            settingHelp[key],
            "Enter edits this setting.",
          ],
        }));
      case "License":
        return [
          {
            id: "status",
            label: `${s.license.tier} license`,
            meta: s.license.state,
            detail: [
              s.license.message,
              `Sessions: ${s.license.maxSessions ?? "Unlimited"}`,
              `Features: ${s.license.features.join(", ") || "Free features"}`,
              "R refreshes license status.",
              "W opens License in the web app for activation.",
            ],
          },
        ];
    }
  }
  subtitle() {
    if (this.discovery)
      return `${this.selectedDevices.size} selected · ${this.discovery.devices.length} discovered`;
    if (this.remote)
      return `${remoteProfile(this.remote)} remote · ${this.remote.name}`;
    if (this.view === "Devices")
      return `${this.platform || "All platforms"} · ${this.kind === "virtual" ? "Sim" : this.kind === "physical" ? "Real" : "Sim + Real"}${this.filter ? ` · “${this.filter}”` : ""}`;
    if (this.view === "Feeds")
      return `${this.selectedFeeds.size} selected · video opens in the browser`;
    if (this.view === "Captures")
      return this.trash
        ? "Trash · restore items here"
        : "Saved screenshots and recordings";
    if (this.view === "Reports") {
      const r = this.report || this.snapshot?.reports;
      return `${this.reportPreset} · ${r?.sessions || 0} sessions · ${duration(r?.reservedMs || 0)} reserved`;
    }
    if (this.view === "Settings") return "Local daemon preferences";
    return "Select an item for details and actions";
  }
  hints() {
    if (this.discovery)
      return [
        "Space Select   A Select all / none   Enter Add selected",
        "D Discover again   Esc Back to Devices",
      ];
    if (this.remote)
      return [
        "Arrows Navigate   Enter OK   B Back   H Home   Space Play",
        "[ / ] Seek   P Replay   * Special   T Text   S Shot   V Record",
      ];
    switch (this.view) {
      case "Devices":
        return [
          this.activeDevice() &&
          supportsSimulatorLifecycle(this.activeDevice()!)
            ? "O Launch / close sim   C Remote   R Reserve   S Shot   V Record"
            : "C Remote   R Reserve   S Screenshot   V Record   W View",
          "/ Search   F Filters   X Clear   D Discover   Enter Actions",
        ];
      case "Feeds":
        return [
          "Space Select   A All / none   G Split screen   W Single feed",
          "C Remote   S Screenshot   V Record   R Reserve   Enter Actions",
        ];
      case "Captures":
        return [
          "O Open   N Rename   X Trash / restore   T Toggle trash",
          "Enter Actions",
        ];
      case "Sessions":
        return [
          "C Remote   U Renew   E End session   T Take over",
          "Enter Actions",
        ];
      case "History":
        return [
          "Enter Event details   W Web history",
          "PgUp / PgDn Scroll   Home / End First / last",
        ];
      case "Reports":
        return [
          "D Day   W Week   M Month   Enter Details",
          "Report times use the daemon’s local time zone",
        ];
      case "Settings":
        return [
          "Enter Edit   D Diagnostics   W Web settings",
          "Changes apply to the local daemon",
        ];
      case "License":
        return [
          "R Refresh license   W Open license settings",
          "Enter License details",
        ];
    }
  }
  openWeb(
    view = this.view.toLowerCase(),
    sources: string[] = [],
    grid = false,
  ) {
    this.run("Opening browser", async () => {
      const query = new URLSearchParams({ view });
      if (sources.length) {
        query.set("sources", sources.join(","));
        query.set("active", sources[0]);
        query.set("layout", grid ? "grid" : "single");
      }
      await this.io.open(await this.io.url(query));
      this.notice("Opened in the browser.");
    });
  }
  reserve(device: Device, next?: () => void, force = false) {
    if (this.lease(device.id) && !force) {
      next?.();
      if (!next) this.notice("You already hold this reservation.");
      return;
    }
    const existing = this.session(device.id);
    const ask = () =>
      this.form(
        existing ? "Take over device" : "Reserve device",
        [
          {
            label: "Owner",
            value: this.snapshot!.config.settings.owner,
            required: true,
            max: 128,
          },
          { label: "Reason", value: "", required: true, max: 512 },
        ],
        ([owner, reason]) =>
          this.run(
            "Reserving device",
            async () => {
              const acquired: Acquired = await this.io.call(
                existing ? "sessions.takeover" : "sessions.reserve",
                existing
                  ? { deviceId: device.id, owner, reason, confirmed: true }
                  : { selector: { device: device.id }, owner, reason },
              );
              this.leases.set(device.id, {
                sessionId: acquired.session.id,
                leaseToken: acquired.leaseToken,
              });
              // Make the acquired credential available to the follow-up action immediately.
              if (this.snapshot)
                this.snapshot.sessions = this.snapshot.sessions
                  .filter(
                    (s) => s.deviceId !== device.id || s.state === "closed",
                  )
                  .concat(acquired.session);
              this.notice(`Reserved ${device.name}.`);
            },
            next,
          ),
        device.name,
      );
    if (existing)
      this.confirm(
        "Device is in use",
        `${existing.owner}: ${existing.reason}. Taking over ends that session and saves its recording, if running.`,
        ask,
      );
    else ask();
  }
  withLease(device: Device, work: (lease: Lease) => void) {
    const lease = this.lease(device.id);
    if (lease) work(lease);
    else
      this.reserve(device, () => {
        const acquired = this.lease(device.id);
        if (acquired) work(acquired);
      });
  }
  startRemote(device: Device) {
    if (
      !device.capabilities.includes("key") &&
      !device.capabilities.includes("text")
    ) {
      this.notice(
        "This device has no remote transport. Configure its connection in Devices on the web.",
        true,
      );
      return;
    }
    this.withLease(device, () => {
      this.remoteId = device.id;
      this.notice(
        "Remote active. Esc returns to the workspace; the reservation stays active.",
      );
    });
  }
  capture(device: Device, recording: boolean, clipboard = false) {
    if (!device.capabilities.includes(recording ? "record" : "screenshot")) {
      this.notice(
        "This device does not support that capture action. Check its capture source in the web app.",
        true,
      );
      return;
    }
    this.withLease(device, (lease) =>
      this.run(
        recording ? "Updating recording" : "Taking screenshot",
        async () => {
          const result = await this.io.call(
            recording
              ? this.recording(device.id)
                ? "recordings.stop"
                : "recordings.start"
              : "captures.screenshot",
            recording ? lease : { ...lease, clipboard },
          );
          this.notice(
            result.path
              ? `${result.status}: ${result.path}`
              : "Recording started. V stops and saves it.",
          );
        },
      ),
    );
  }
  endSession(device: Device) {
    const lease = this.lease(device.id);
    if (!lease) {
      this.notice(
        "Another client owns this session. T offers an explicit takeover.",
        true,
      );
      return;
    }
    this.confirm(
      "End session?",
      `Release ${device.name}${this.recording(device.id) ? " and save its current recording" : ""}?`,
      () =>
        this.run("Ending session", async () => {
          await this.io.call("sessions.release", lease);
          this.leases.delete(device.id);
          this.remoteId = undefined;
          this.notice("Session ended.");
        }),
    );
  }
  renew(device: Device) {
    const lease = this.lease(device.id);
    if (!lease) {
      this.notice(
        "Renew is available only for sessions reserved by this TUI.",
        true,
      );
      return;
    }
    this.run("Renewing reservation", async () => {
      await this.io.call("sessions.renew", lease);
      this.notice("Reservation renewed.");
    });
  }
  deviceActions(device: Device): Action[] {
    return [
      ...(supportsSimulatorLifecycle(device)
        ? [
            {
              key: "o",
              label:
                device.simulatorState === "starting"
                  ? "Launching simulator…"
                  : device.simulatorState === "stopping"
                    ? "Closing simulator…"
                    : device.online
                      ? "Close simulator…"
                      : "Launch simulator",
              disabled:
                device.locked ||
                (!device.online && !canLaunchSimulator(device)) ||
                ["starting", "stopping", "unavailable"].includes(
                  device.simulatorState || "",
                ),
              run: () => this.simulator(device),
            },
          ]
        : []),
      {
        key: "c",
        label: "Open remote",
        run: () => this.startRemote(device),
        disabled:
          !device.capabilities.includes("key") &&
          !device.capabilities.includes("text"),
      },
      { key: "r", label: "Reserve device", run: () => this.reserve(device) },
      {
        key: "s",
        label: "Screenshot",
        run: () => this.capture(device, false),
        disabled: !device.capabilities.includes("screenshot"),
      },
      {
        key: "v",
        label: this.recording(device.id)
          ? "Stop and save recording"
          : "Start recording",
        run: () => this.capture(device, true),
        disabled: !device.capabilities.includes("record"),
      },
      {
        key: "w",
        label: "View feed in browser",
        run: () =>
          device.captureSourceId
            ? this.openWeb("feeds", [device.captureSourceId])
            : this.openWeb("devices"),
      },
      {
        key: "i",
        label: "Inspect device details",
        run: () =>
          this.info(
            device.name,
            this.selected?.detail || [device.healthDetail],
          ),
      },
      {
        key: "u",
        label: "Renew reservation",
        run: () => this.renew(device),
        disabled: !this.lease(device.id),
      },
      {
        key: "e",
        label: "End session and save recording",
        run: () => this.endSession(device),
        disabled: !this.lease(device.id),
      },
      {
        key: "t",
        label: "Take over session…",
        run: () => this.reserve(device, undefined, true),
        disabled: !this.session(device.id) || Boolean(this.lease(device.id)),
      },
      {
        key: "l",
        label: device.locked ? "Unlock device" : "Lock for maintenance…",
        run: () =>
          this.form(
            "Maintenance",
            [{ label: "Reason", value: "", required: true, max: 512 }],
            ([reason]) =>
              this.run("Updating device lock", async () => {
                const results: { ok: boolean; error?: string }[] =
                  await this.io.call("devices.bulk", {
                    ids: [device.id],
                    action: device.locked ? "unlock" : "lock",
                    reason,
                  });
                const failure = results.find((r) => !r.ok);
                if (failure)
                  throw new Error(
                    failure.error || "Unable to change the device lock.",
                  );
                this.notice(
                  device.locked ? "Device unlocked." : "Device locked.",
                );
              }),
          ),
      },
    ];
  }
  simulator(device: Device) {
    if (!supportsSimulatorLifecycle(device)) return;
    const action = device.online ? "close" : "launch";
    const session = this.session(device.id),
      lease = this.lease(device.id);
    if (session && !lease) {
      this.info("Simulator is reserved", [
        `${session.owner}: ${session.reason}`,
        "End the current session before changing simulator state. T offers an explicit takeover; then E ends and saves its recording.",
      ]);
      return;
    }
    const work = () =>
      this.run(
        action === "close" ? "Closing simulator" : "Launching simulator",
        async () => {
          if (session && lease) {
            await this.io.call("sessions.release", lease);
            this.leases.delete(device.id);
            if (this.remoteId === device.id) this.remoteId = undefined;
          }
          await this.io.call("devices.simulator", {
            deviceId: device.id,
            action,
            ...(action === "close" ? { confirmed: true } : {}),
          });
          this.notice(
            `${device.name} ${action === "close" ? "closed" : "launched"}.`,
          );
        },
      );
    if (action === "close" || session)
      this.confirm(
        `${action === "close" ? "Close" : "Launch"} simulator?`,
        `${device.name}. ${session ? `This ends your session${this.recording(device.id) ? " and stops and saves its recording" : ""} first. ` : ""}Other simulators stay open.`,
        work,
      );
    else work();
  }
  activeDevice() {
    const s = this.snapshot,
      row = this.selected;
    if (!s || !row) return;
    if (this.view === "Devices") return s.devices.find((d) => d.id === row.id);
    if (this.view === "Sessions")
      return s.devices.find(
        (d) => d.id === s.sessions.find((a) => a.id === row.id)?.deviceId,
      );
    if (this.view === "Feeds")
      return s.devices.find((d) => d.captureSourceId === row.id);
  }
  actions(): Action[] {
    const row = this.selected,
      s = this.snapshot;
    if (!row || !s) return [];
    const device = this.activeDevice();
    if (device) return this.deviceActions(device);
    if (this.view === "Feeds")
      return [
        {
          key: "w",
          label: "View this feed",
          run: () => this.openWeb("feeds", [row.id]),
        },
        {
          key: "g",
          label: "Open selected feeds as split screen",
          run: () => this.openGrid(),
        },
        {
          key: "b",
          label: "Configure device / capture binding",
          run: () => this.openWeb("devices"),
        },
      ];
    if (this.view === "Captures") {
      const a = s.artifacts.find((a) => a.id === row.id)!;
      return [
        {
          key: "o",
          label: "Open file",
          run: () =>
            this.run("Opening capture", async () => {
              await this.io.open(a.path);
              this.notice("Opened capture.");
            }),
          disabled: a.status !== "completed" || Boolean(a.deletedAt),
        },
        {
          key: "n",
          label: "Rename / edit tags",
          disabled: Boolean(a.deletedAt),
          run: () =>
            this.form(
              "Edit capture",
              [
                { label: "Name", value: a.name, required: true, max: 180 },
                {
                  label: "Tags (comma separated)",
                  value: a.tags.join(", "),
                  max: 1500,
                },
              ],
              ([name, tags]) =>
                this.run("Saving capture", async () => {
                  await this.io.call("captures.edit", {
                    id: a.id,
                    name,
                    tags: tags
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  });
                  this.notice("Capture updated.");
                }),
            ),
        },
        {
          key: "x",
          label: a.deletedAt ? "Restore capture" : "Move to trash…",
          run: () => this.trashCapture(a),
          disabled: ["recording", "finalizing"].includes(a.status),
        },
      ];
    }
    if (this.view === "Settings")
      return [
        {
          key: "return",
          label: "Edit setting",
          run: () => this.editSetting(row.id as keyof typeof settingLabels),
        },
      ];
    return [
      {
        key: "return",
        label: "Show details",
        run: () => this.info(row.label, row.detail),
      },
    ];
  }
  trashCapture(a: Artifact) {
    const work = () =>
      this.run(
        a.deletedAt ? "Restoring capture" : "Moving to trash",
        async () => {
          await this.io.call(
            a.deletedAt ? "captures.restore" : "captures.remove",
            a.deletedAt ? { ids: [a.id] } : { ids: [a.id], confirmed: true },
          );
          this.notice(
            a.deletedAt
              ? "Capture restored."
              : "Capture moved to trash. T opens trash.",
          );
        },
      );
    if (a.deletedAt) work();
    else this.confirm("Move capture to trash?", a.name, work);
  }
  editSetting(key: keyof typeof settingLabels) {
    const value = this.snapshot!.config.settings[key];
    const save = (next: string | number | boolean) =>
      this.run("Saving settings", async () => {
        const { config, revision }: { config: Config; revision: string } =
          await this.io.call("config.get");
        const changed = {
          ...config,
          settings: { ...config.settings, [key]: next },
        };
        await this.io.call("config.save", { config: changed, revision });
        this.notice("Setting saved.");
      });
    if (typeof value === "boolean")
      this.menu(settingLabels[key], [
        { key: "y", label: "Enabled", run: () => save(true) },
        { key: "n", label: "Disabled", run: () => save(false) },
      ]);
    else if (key === "captureMode")
      this.menu("Capture mode", [
        { key: "c", label: "Clean", run: () => save("clean") },
        { key: "a", label: "Annotated", run: () => save("annotated") },
      ]);
    else
      this.form(
        settingLabels[key],
        [
          {
            label: settingLabels[key],
            value: String(value),
            required: true,
            max: key === "owner" ? 128 : 4096,
          },
        ],
        ([next]) => {
          if (typeof value === "number" && !/^\d+$/.test(next)) {
            this.notice("Enter a whole number.", true);
            return;
          }
          save(typeof value === "number" ? Number(next) : next);
        },
        settingHelp[key],
      );
  }
  filters() {
    this.menu(
      "Filter devices",
      [
        ...(["", "Apple", "Roku", "Android", "Other"] as const).map((p, i) => ({
          key: String(i),
          label: `${this.platform === p ? "●" : "○"} ${p || "All platforms"}`,
          run: () => {
            this.platform = p;
            this.index = 0;
          },
        })),
        ...(["", "physical", "virtual"] as const).map((kind, i) => ({
          key: ["a", "r", "s"][i],
          label: `${this.kind === kind ? "●" : "○"} ${["Sim + Real", "Real devices", "Simulators"][i]}`,
          run: () => {
            this.kind = kind;
            this.index = 0;
          },
        })),
      ],
      "Platform and device type filters combine. X clears all filters.",
    );
  }
  discover() {
    this.run("Discovering devices", async () => {
      this.discovery = await this.io.call("discover");
      this.selectedDevices.clear();
      this.index = 0;
      this.notice(
        "Space selects devices. A selects all available; Enter adds the selection.",
      );
    });
  }
  eligibleDiscovery() {
    return (
      this.discovery?.devices.filter(
        (d) =>
          !isDeviceConfigured(this.snapshot!.config, d) &&
          !registrationIssue(d),
      ) || []
    );
  }
  addDiscovered() {
    if (!this.selectedDevices.size || !this.discovery) {
      this.notice("Select devices with Space or A first.");
      return;
    }
    const discovery = this.discovery,
      ids = [...this.selectedDevices];
    this.run("Adding selected devices", async () => {
      const { config, revision } = await this.io.call("config.get");
      const result = registerDiscoveredDevices(config, discovery, ids);
      await this.io.call("config.save", { config: result.config, revision });
      this.discovery = undefined;
      this.selectedDevices.clear();
      this.notice(`Added ${result.added.length} devices.`);
    });
  }
  openGrid() {
    const ids = this.snapshot!.sources.filter(
      (c) =>
        c.status === "connected" &&
        (!this.selectedFeeds.size || this.selectedFeeds.has(c.id)),
    ).map((c) => c.id);
    if (!ids.length) {
      this.notice("No connected feeds selected.", true);
      return;
    }
    this.openWeb("feeds", ids, true);
  }
  loadReport(preset: "day" | "week" | "month") {
    this.run("Loading report", async () => {
      this.report = await this.io.call("reports.get", { preset });
      this.reportPreset = preset;
      this.index = 0;
      this.notice(`Showing ${preset} report.`);
    });
  }
  quit() {
    if (this.busy) {
      this.notice("Wait for the current action to finish before quitting.");
      return;
    }
    if (!this.leases.size) {
      this.done = true;
      return;
    }
    this.confirm(
      "End your sessions and quit?",
      `This TUI holds ${this.leases.size} reservation(s). Quitting releases them and saves any recordings. Other clients’ sessions stay active.`,
      () =>
        this.run("Releasing sessions", async () => {
          for (const [id, lease] of this.leases) {
            await this.io.call("sessions.release", lease);
            this.leases.delete(id);
          }
          this.done = true;
        }),
    );
  }
  dialogKey(key: Key) {
    const dialog = this.dialog!,
      name = key.name || key.sequence || "";
    if (name === "escape") {
      this.dialog = undefined;
      return;
    }
    if (dialog.kind === "info") {
      if (["down", "j", "pagedown"].includes(name))
        dialog.index += name === "pagedown" ? 8 : 1;
      if (["up", "k", "pageup"].includes(name))
        dialog.index = Math.max(0, dialog.index - (name === "pageup" ? 8 : 1));
      if (name === "return") this.dialog = undefined;
    } else if (dialog.kind === "menu") {
      if (name === "up")
        dialog.index =
          (dialog.index + dialog.actions.length - 1) % dialog.actions.length;
      else if (name === "down" || name === "tab")
        dialog.index = (dialog.index + 1) % dialog.actions.length;
      else {
        const action =
          name === "return"
            ? dialog.actions[dialog.index]
            : dialog.actions.find(
                (a) => a.key === name || a.key === key.sequence,
              );
        if (action && !action.disabled) {
          this.dialog = undefined;
          action.run();
        } else if (action)
          this.notice("This action is unavailable for the current item.");
      }
    } else {
      const field = dialog.fields[dialog.index];
      if (name === "tab" || name === "down")
        dialog.index =
          (dialog.index + (key.shift ? dialog.fields.length - 1 : 1)) %
          dialog.fields.length;
      else if (name === "up")
        dialog.index =
          (dialog.index + dialog.fields.length - 1) % dialog.fields.length;
      else if (name === "backspace")
        field.value = glyphs(field.value).slice(0, -1).join("");
      else if (key.ctrl && name === "u") field.value = "";
      else if (name === "return") {
        if (dialog.index < dialog.fields.length - 1) dialog.index++;
        else if (dialog.fields.some((f) => f.required && !f.value.trim()))
          this.notice("Complete all required fields.", true);
        else {
          this.dialog = undefined;
          dialog.submit(dialog.fields.map((f) => f.value.trim()));
        }
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        !/[\x00-\x1f\x7f-\x9f]/.test(key.sequence)
      )
        field.value = (field.value + clean(key.sequence)).slice(
          0,
          field.max || 4096,
        );
    }
  }
  remoteKey(key: Key) {
    const device = this.remote!,
      name = key.name || key.sequence || "";
    if (name === "escape" || name === "q") {
      if (this.remoteOnly) this.quit();
      else this.remoteId = undefined;
      return;
    }
    if (name === "t")
      this.form(
        "Send text",
        [{ label: "Text", value: "", required: true, max: 4096 }],
        ([text]) =>
          this.withLease(device, (lease) =>
            this.run(
              "Sending text",
              async () => {
                await this.io.call("remote.input", { ...lease, text });
                this.notice("Text sent.");
              },
              undefined,
              false,
            ),
          ),
      );
    else if (name === "s" || name === "c")
      this.capture(device, false, name === "c");
    else if (name === "v" || name === "r") this.capture(device, true);
    else if (name === "u") this.renew(device);
    else if (name === "e") this.endSession(device);
    else if (name === "m") this.menu(device.name, this.deviceActions(device));
    else {
      const command = remoteKeys[name] || remoteKeys[key.sequence || ""];
      if (command && supportsRemoteKey(device, command))
        this.withLease(device, (lease) => {
          this.inputQueue.push(command);
          this.run(
            "Sending remote keys",
            async () => {
              this.sendingKeys = true;
              try {
                while (this.inputQueue.length) {
                  const key = this.inputQueue.shift()!;
                  await this.io.call("remote.input", { ...lease, key });
                  this.notice(`Sent ${key}.`);
                }
              } finally {
                this.inputQueue = [];
                this.sendingKeys = false;
              }
            },
            undefined,
            false,
          );
        });
      else if (command)
        this.notice(`${command} is not supported by this device.`, true);
    }
  }
  handle(key: Key) {
    const name = key.name || key.sequence || "";
    if (["tick", "resize"].includes(name)) return;
    this.changed();
    if (key.ctrl && name === "c") {
      this.quit();
      return;
    }
    if (this.busy) {
      if (this.sendingKeys && this.remote) {
        const command = remoteKeys[name] || remoteKeys[key.sequence || ""];
        if (name === "escape") {
          this.inputQueue = [];
          if (!this.remoteOnly) this.remoteId = undefined;
        } else if (
          command &&
          supportsRemoteKey(this.remote, command) &&
          this.inputQueue.length < 16
        )
          this.inputQueue.push(command);
      }
      if (name === "q")
        this.notice("Wait for the current action to finish before quitting.");
      return;
    }
    if (this.dialog) {
      this.dialogKey(key);
      return;
    }
    if (this.remote) {
      this.remoteKey(key);
      return;
    }
    if (name === "q") {
      this.quit();
      return;
    }
    if (/^[1-8]$/.test(name)) {
      this.switchView(menus[Number(name) - 1]);
      this.focus = "items";
      return;
    }
    if (name === "tab") {
      this.focus = this.focus === "menu" ? "items" : "menu";
      return;
    }
    if (name === "escape" || name === "left") {
      if (this.discovery) this.discovery = undefined;
      else this.focus = "menu";
      return;
    }
    if (name === "right") {
      this.focus = "items";
      return;
    }
    if (this.focus === "menu") {
      if (["up", "k", "down", "j"].includes(name))
        this.switchView(
          menus[
            (menus.indexOf(this.view) +
              (["up", "k"].includes(name) ? menus.length - 1 : 1)) %
              menus.length
          ],
        );
      if (name === "return") this.focus = "items";
      return;
    }
    if (
      ["up", "k", "down", "j", "pageup", "pagedown", "home", "end"].includes(
        name,
      )
    ) {
      this.index =
        name === "home"
          ? 0
          : name === "end"
            ? this.rows().length - 1
            : this.index +
              (["up", "k", "pageup"].includes(name) ? -1 : 1) *
                (["pageup", "pagedown"].includes(name) ? this.pageSize : 1);
      return;
    }
    if (!this.snapshot) {
      if (name === "r") void this.refresh();
      if (name === "w") this.openWeb();
      return;
    }
    if (this.discovery) {
      if (name === "space") {
        const id = this.selected?.id;
        if (id && this.eligibleDiscovery().some((d) => d.id === id))
          this.selectedDevices.has(id)
            ? this.selectedDevices.delete(id)
            : this.selectedDevices.add(id);
      }
      if (name === "a") {
        const ids = this.eligibleDiscovery().map((d) => d.id);
        this.selectedDevices = new Set(
          ids.every((id) => this.selectedDevices.has(id)) ? [] : ids,
        );
      }
      if (name === "return") this.addDiscovered();
      if (name === "d") this.discover();
      return;
    }
    if (this.view === "Devices") {
      if (name === "f") {
        this.filters();
        return;
      }
      if (name === "/" || key.sequence === "/") {
        this.form(
          "Search devices",
          [{ label: "Name contains", value: this.filter, max: 128 }],
          ([text]) => {
            this.filter = text;
            this.index = 0;
          },
        );
        return;
      }
      if (name === "x") {
        this.filter = this.platform = this.kind = "";
        this.index = 0;
        return;
      }
      if (name === "d") {
        this.discover();
        return;
      }
    }
    if (this.view === "Feeds") {
      if (name === "space") {
        const id = this.selected?.id;
        if (id)
          this.selectedFeeds.has(id)
            ? this.selectedFeeds.delete(id)
            : this.selectedFeeds.add(id);
        return;
      }
      if (name === "a") {
        const ids = this.snapshot.sources
          .filter((c) => c.status === "connected")
          .map((c) => c.id);
        this.selectedFeeds = new Set(
          ids.every((id) => this.selectedFeeds.has(id)) ? [] : ids,
        );
        return;
      }
      if (name === "g") {
        this.openGrid();
        return;
      }
    }
    if (this.view === "Captures" && name === "t") {
      this.trash = !this.trash;
      this.index = 0;
      return;
    }
    if (this.view === "Reports" && ["d", "w", "m"].includes(name)) {
      this.loadReport(
        ({ d: "day", w: "week", m: "month" } as const)[name as "d" | "w" | "m"],
      );
      return;
    }
    if (this.view === "Settings" && name === "d") {
      this.info("Diagnostics", [
        ...(this.snapshot.configError ? [this.snapshot.configError] : []),
        ...this.snapshot.diagnostics,
      ]);
      return;
    }
    if (this.view === "License" && name === "r") {
      this.run("Refreshing license", async () => {
        await this.io.call("license.refresh");
        this.notice("License refreshed.");
      });
      return;
    }
    const actions = this.actions();
    if (name === "return") {
      if (actions.length === 1) actions[0].run();
      else if (actions.length) this.menu(this.selected!.label, actions);
      return;
    }
    const action = actions.find((a) => a.key === name);
    if (action) {
      if (!action.disabled) action.run();
      else this.notice("This action is unavailable for the current item.");
    } else if (name === "w") this.openWeb();
    else if (name === "r") void this.refresh();
    else if (name === "?")
      this.info("Keyboard help", [
        "1–8: switch workspace views",
        "Tab: switch focus between menu and items",
        "Arrows or J/K: move selection",
        "PgUp/PgDn, Home/End: move through long lists",
        "Enter: actions for the selected item",
        "Each view lists its action keys at the bottom",
        "Esc: dismiss a form, close the remote, or focus menus",
        "Q / Ctrl+C: quit (asks to release sessions owned by this TUI)",
        "Forms: Tab or arrows change fields, Ctrl+U clears a field",
        "Remote: arrows and Enter control the device; M opens actions",
      ]);
  }
}
export const settingLabels = {
  owner: "Default owner",
  folder: "Capture folder",
  ttl: "Reservation TTL",
  maxRecordingMinutes: "Recording limit",
  captureMode: "Capture mode",
  overlay: "Overlay",
  logging: "Input logging",
  clipboard: "Copy screenshots",
  previewIntervalMs: "Preview interval",
};
const settingHelp: Record<keyof typeof settingLabels, string> = {
  owner: "Owner label used when reserving a device.",
  folder: "Absolute folder for capture files.",
  ttl: "Reservation length in minutes (1–240).",
  maxRecordingMinutes: "Maximum recording length in minutes (1–120).",
  captureMode: "Save clean or annotated captures.",
  overlay: "Include the configured overlay in annotated captures.",
  logging: "Save remote input logs with recordings.",
  clipboard: "Copy screenshots to the Mac clipboard.",
  previewIntervalMs: "Preview refresh interval in milliseconds (250–5000).",
};
