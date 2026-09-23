import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, rm, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  ConfigStore,
  SerialQueue,
  sourceIdentity,
  atomicWrite,
} from "../../../../packages/config/src";
import { Adapters } from "../../../../packages/adapters/src";
import { supportsWake } from "../../../../packages/core/src/remote";
import {
  run,
  stop,
  type ProcessHandle,
} from "../../../../packages/adapters/src/process";
import {
  CaptureEngine,
  type RecordingHandle,
} from "../../../../packages/capture/src";
import {
  operations,
  matchDevices,
  matchReservationGroup,
  supportsSimulatorLifecycle,
  canLaunchSimulator,
  fail,
  type Config,
  type Device,
  type Session,
  type Artifact,
  type Operation,
  type Snapshot,
  type SourceConfig,
  type Source,
  type ReservationGroup,
} from "../../../../packages/core/src/local/types";
import { Store } from "./store";
import { InventoryCache } from "./inventory-cache";
import { captureStorage, openCaptureFolder } from "./capture-library";
import { CaptureThumbnails } from "./thumbnails";
import { CaptureCardThumbnails } from "./capture-card-thumbnails";
import { LiveStreams, type LiveTarget, type LiveAuthorization } from "../live";
import { phoneHardwareButtons } from "../../../../packages/core/src/remote";
import type { StreamOpen } from "../../../../packages/core/src/live";
import {
  LicenseManager,
  FEATURES,
  type EntitlementService,
} from "../../../../packages/licensing/src";
type Job = {
  artifact: Artifact;
  handle: RecordingHandle;
  timer: ReturnType<typeof setTimeout>;
  finishing?: Promise<Artifact>;
};
export class DeckService {
  readonly config: ConfigStore;
  readonly adapters: Adapters;
  readonly capture: CaptureEngine;
  readonly licensing: EntitlementService;
  readonly streams: LiveStreams;
  readonly thumbnails: CaptureThumbnails;
  readonly captureCardThumbnails = new CaptureCardThumbnails();
  store!: Store;
  private control = new Map<string, SerialQueue>();
  private global = new SerialQueue();
  private library = new SerialQueue();
  private jobs = new Map<string, Job>();
  private pairings = new Map<
    string,
    { handle: ProcessHandle; timer: ReturnType<typeof setTimeout> }
  >();
  private closing = new Map<string, Promise<Session>>();
  private groupClosing = new Map<string, Promise<ReservationGroup>>();
  private healthCache = new InventoryCache<Device>();
  // Project camera observations frequently; hardware freshness belongs to the
  // shared camera owner, not a second 30-second cache layered on top of it.
  private sourceCache = new InventoryCache<Source>(Date.now, 1000, 30_000);
  private inventoryRevision = "";
  private inventoryConfig?: Config;
  private inventoryReads: Record<string, number> = {};
  private healthPending?: Promise<Device[]>;
  private timer?: ReturnType<typeof setInterval>;
  private shuttingDown = false;
  private changingConfig = false;
  private simulatorActions = new Map<string, "launch" | "close">();
  diagnostics: string[] = [];
  inventoryDiagnostics() {
    return { requests: { ...this.inventoryReads }, ...this.adapters.inventoryStats(),
      health: this.healthCache.observation(this.config.config.devices.map((d) => d.id)) };
  }
  constructor(
    readonly directory: string,
    configFile = path.join(directory, "config.json"),
    adapters?: Adapters,
    capture?: CaptureEngine,
    licensing?: EntitlementService,
  ) {
    this.config = new ConfigStore(configFile);
    this.adapters = adapters || new Adapters(() => this.config.config);
    this.capture = capture || new CaptureEngine(this.adapters);
    this.thumbnails = new CaptureThumbnails((id) => this.store.artifact(id), () => this.adapters.tool("ffmpeg"));
    this.licensing = licensing || new LicenseManager(directory);
    this.streams = new LiveStreams({
      resolve: (args) => this.liveTarget(args),
      video: (target, profile) => {
        if (!target.source) fail("source-missing", "Configure a capture source for this device.", 404);
        return this.capture.live(target.device, target.source, profile);
      },
      interactive: (device, profile) => this.adapters.startInteractive(device, true, profile),
      report: (error) => { this.diagnostics.push(error.message); if (this.diagnostics.length > 100) this.diagnostics.shift(); },
      helperIdentity: () => JSON.stringify(this.config.config.tools),
    });
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.config.load();
    await this.licensing.init();
    this.store = new Store(path.join(this.directory, "state.sqlite"));
    await this.recover();
    this.diagnostics.push(...(await this.adapters.diagnostics()));
    this.timer = setInterval(() => {
      void this.expire().catch((e) => this.diagnostics.push(String(e)));
    }, 1000);
    this.timer.unref();
  }
  private queue(id: string) {
    let q = this.control.get(id);
    if (!q) {
      q = new SerialQueue();
      this.control.set(id, q);
    }
    return q;
  }
  private device(id: string) {
    const d = this.config.config.devices.find((d) => d.id === id);
    if (!d) fail("device-not-found", "Device is not configured.", 404);
    return d;
  }
  private source(session: Session): SourceConfig {
    const s = this.config.config.sources.find((s) => s.id === session.sourceId);
    if (!s)
      fail(
        "source-missing",
        "Configure a capture input before reserving this device.",
      );
    return s;
  }
  private configurationProtectedSessions() {
    const groupSessions = new Set(
      this.store
        .groups()
        .filter((group) => group.state !== "closed")
        .flatMap((group) => group.members.map((member) => member.sessionId)),
    );
    return this.store
      .sessions()
      .filter(
        (session) =>
          session.state !== "closed" || groupSessions.has(session.id),
      );
  }
  private deviceHasOpenGroup(deviceId: string) {
    return this.store
      .groups()
      .some(
        (group) =>
          group.state !== "closed" &&
          group.members.some((member) => member.deviceId === deviceId),
      );
  }
  private validateChange = (next: Config, lifecycleDevice?: string) => {
    for (const id of this.simulatorActions.keys()) {
      if (id === lifecycleDevice) continue;
      if (
        JSON.stringify(this.device(id)) !==
        JSON.stringify(next.devices.find((d) => d.id === id))
      )
        fail(
          "device-busy",
          "Wait for simulator launch or shutdown before changing this device.",
          409,
        );
    }
    // A failed group cleanup deliberately leaves closed member sessions under
    // a durable group lock. Keep their configuration stable so a later retry
    // can still resolve and restore every device/source with the same tools.
    const active = this.configurationProtectedSessions();
    for (const s of active) {
      if (
        JSON.stringify(
          this.config.config.devices.find((d) => d.id === s.deviceId),
        ) !== JSON.stringify(next.devices.find((d) => d.id === s.deviceId)) ||
        JSON.stringify(
          this.config.config.sources.find((x) => x.id === s.sourceId),
        ) !== JSON.stringify(next.sources.find((x) => x.id === s.sourceId))
      )
        fail(
          "device-busy",
          "Release the affected session before changing its device or capture binding.",
          409,
        );
    }
    if (
      (active.length || this.simulatorActions.size) &&
      JSON.stringify(next.tools) !== JSON.stringify(this.config.config.tools)
    )
      fail(
        "device-busy",
        "Release sessions and wait for simulator launch or shutdown before changing adapter executables.",
        409,
      );
  };
  private async refresh() {
    await this.global.run(async () => {
      if (await this.config.refresh(this.prepareConfig)) this.invalidateInventory();
      this.changingConfig = false;
    });
  }
  private prepareConfig = async (next: Config) => {
    this.validateChange(next);
    this.changingConfig = true;
    const active = this.configurationProtectedSessions();
    try {
      for (const source of this.config.config.sources) {
        if (active.some((s) => s.sourceId === source.id)) continue;
        const device = this.config.config.devices.find(
          (d) => d.captureSourceId === source.id,
        );
        if (device)
          await this.queue(device.id).run(() =>
            this.capture.closeSource(source),
          );
        else
          await this.queue(`source:${source.id}`).run(() =>
            this.capture.closeSource(source),
          );
      }
    } catch (e) {
      this.changingConfig = false;
      throw e;
    }
  };
  private invalidateInventory(deviceId?: string) {
    const current = this.config.config, previous = this.inventoryConfig;
    const configChanged = this.inventoryRevision !== this.config.revision;
    const sameTools = previous && JSON.stringify(previous.tools) === JSON.stringify(current.tools);
    const sameSource = (id?: string | null) => !id || JSON.stringify(previous?.sources.find((s) => s.id === id)) === JSON.stringify(current.sources.find((s) => s.id === id));
    const preservedDevices = sameTools ? current.devices.filter((d) =>
      JSON.stringify(previous.devices.find((old) => old.id === d.id)) === JSON.stringify(d) && sameSource(d.captureSourceId),
    ).map((d) => d.id) : [];
    const preservedSources = sameTools ? current.sources.filter((s) => sameSource(s.id) &&
      (s.kind !== "native" || !s.deviceId || preservedDevices.includes(s.deviceId)),
    ).map((s) => s.id) : [];
    const affectedSources = current.sources.filter((s) => s.kind === "native" && s.deviceId === deviceId ||
      current.devices.some((d) => d.id === deviceId && d.captureSourceId === s.id)).map((s) => s.id);
    this.inventoryRevision = this.config.revision;
    this.inventoryConfig = structuredClone(current);
    // Retain known facts for unchanged identities. A lifecycle action expires
    // only its target; unrelated live feeds must not become unknown mid-refresh.
    this.healthCache.invalidate(preservedDevices, deviceId ? [deviceId] : configChanged ? [] : preservedDevices);
    this.sourceCache.invalidate(preservedSources, deviceId ? affectedSources : configChanged ? [] : preservedSources);
    this.adapters.invalidateInventory(deviceId);
  }
  private configuredHealth(devices = this.config.config.devices): Device[] {
    const rows = new Map(this.healthCache.peek(devices.map((d) => d.id)).map((d) => [d.id, d]));
    return this.decorate(devices.map((d) => ({
      ...(rows.get(d.id) || { ...d, online: false, locked: false, capabilities: [], healthDetail: "Checking device status…" }),
      observation: this.healthCache.observation([d.id]),
    })));
  }
  private refreshHealth(devices = this.config.config.devices, force = false) {
    const due = force ? devices : devices.filter((d) => this.healthCache.observation([d.id]).stale);
    const ids = due.map((d) => d.id);
    const captured = structuredClone(due);
    const work = this.healthCache.refresh(ids, (signal, publish) => this.adapters.inspectAll(captured, signal, publish), force);
    const pending = work.then(() => this.configuredHealth(devices));
    this.healthPending = pending;
    void pending.finally(() => { if (this.healthPending === pending) this.healthPending = undefined; });
    return pending;
  }
  async devices(force = false): Promise<Device[]> {
    if (this.inventoryRevision !== this.config.revision) this.invalidateInventory();
    await this.refreshHealth(this.config.config.devices, force);
    // A scoped snapshot may have owned the previous shared cycle. A synchronous
    // caller needs its missing scope observed, not the other request's promise.
    const observed = new Set(this.healthCache.peek(this.config.config.devices.map((d) => d.id)).map((d) => d.id));
    if (this.config.config.devices.some((d) => !observed.has(d.id)))
      await this.refreshHealth(this.config.config.devices, force);
    return this.configuredHealth();
  }
  private decorate(ds: Device[]) {
    return ds.map((d) => ({
      ...d,
      ...(this.simulatorActions.has(d.id)
        ? {
            online: false,
            readiness: this.simulatorActions.get(d.id) === "launch" ? "starting" as const : "offline" as const,
            capabilities: [],
            gestureCapabilities: [],
            simulatorState:
              this.simulatorActions.get(d.id) === "launch"
                ? ("starting" as const)
                : ("stopping" as const),
            healthDetail:
              this.simulatorActions.get(d.id) === "launch"
                ? "Simulator booting…"
                : "Closing simulator…",
          }
        : {}),
      locked: !!this.store.lockReason(d.id),
      lockReason: this.store.lockReason(d.id),
    }));
  }
  async snapshot(deviceIds?: string[]): Promise<Snapshot> {
    await this.refresh();
    if (this.inventoryRevision !== this.config.revision) this.invalidateInventory();
    const selected = deviceIds ? new Set(deviceIds) : null;
    const configured = this.config.config.devices.filter((d) => !selected || selected.has(d.id));
    const configuredSources = this.config.config.sources.filter((s) => !selected || configured.some((d) => d.captureSourceId === s.id));
    void this.refreshHealth(configured);
    const capturedSources = structuredClone(configuredSources);
    void this.sourceCache.refresh(configuredSources.map((s) => s.id), () => this.adapters.inspectSources(capturedSources));
    const devices = this.configuredHealth(configured);
    const cachedSources = new Map(this.sourceCache.peek(configuredSources.map((s) => s.id)).map((s) => [s.id, s]));
    const sources: Source[] = configuredSources.map((s) => {
      const cached = cachedSources.get(s.id);
      const current = this.sourceCache.observation([s.id]);
      const observation = cached?.observation || current;
      return {
        ...(cached || { ...s, status: "unknown" as const, detail: "Checking capture source…" }),
        observation: { ...observation, refreshing: current.refreshing,
          stale: observation.observedAt === null || Date.now() - observation.observedAt >= 30_000 || Boolean(observation.error) },
      };
    });
    for (const d of devices) {
      const source = sources.find((s) => s.id === d.captureSourceId);
      if (!source || source.status === "missing")
        d.capabilities = d.capabilities.filter((c) => !["preview", "screenshot", "record"].includes(c));
      if (source?.kind === "native" && !d.online && d.observation?.observedAt !== null) source.status = "missing";
    }
    return {
      mode: "local",
      inventoryObservation: this.healthCache.observation(configured.map((d) => d.id)),
      license: this.licensing.status(),
      devices,
      sources,
      sessions: this.store.sessions(),
      reservationGroups: this.store.groups(),
      artifacts: this.store.artifacts(),
      events: this.store.events(),
      inputs: this.store.inputs(),
      config: this.config.config,
      configRevision: this.config.revision,
      configError: this.config.error,
      diagnostics: this.diagnostics,
      recordings: [...this.jobs.values()]
        .filter((j) => !j.finishing)
        .map((j) => ({
          id: j.artifact.id,
          deviceId: j.artifact.deviceId,
          sessionId: j.artifact.sessionId,
          startedAt: j.handle.startedAt,
        })),
      reports: this.store.reports(),
    };
  }
  async execute(
    operation: Operation,
    value: unknown,
    origin: Artifact["origin"] = "API",
    authorize?: LiveAuthorization,
  ): Promise<unknown> {
    if (this.shuttingDown)
      fail("service-stopping", "Service is stopping.", 503);
    const args = operations[operation]?.parse(value) as any;
    if (!args) fail("unknown-operation", "Unknown operation.", 404);
    switch (operation) {
      case "inventory":
        this.inventoryReads[`inventory:${origin}`] = (this.inventoryReads[`inventory:${origin}`] || 0) + 1;
        return this.snapshot(args.deviceIds);
      case "license.status":
        return this.licensing.status();
      case "license.activate":
        try {
          return await this.licensing.activate(args.key);
        } catch (e) {
          fail("license-activation-failed", (e as Error).message, 400);
        }
      case "license.refresh": {
        const status = await this.licensing.refresh();
        return status;
      }
      case "license.deactivate": {
        const status = await this.licensing.deactivate();
        return status;
      }
      case "reports.get":
        try {
          return this.store.reports(args);
        } catch (e) {
          fail("invalid-range", (e as Error).message, 400);
        }
      case "capture-cards.list": {
        this.inventoryReads[`capture-cards:${origin}`] = (this.inventoryReads[`capture-cards:${origin}`] || 0) + 1;
        await this.refresh();
        const cards = await this.adapters.captureCards(this.config.config.sources, args.refresh === true);
        const ignored = new Set(this.config.config.ignoredCaptureCardIds);
        return { ...cards, sources: cards.sources.filter((card) => !card.uniqueId || !ignored.has(card.uniqueId)) };
      }
      case "discover":
        this.inventoryReads[`discover:${origin}`] = (this.inventoryReads[`discover:${origin}`] || 0) + 1;
        return this.adapters.discover(args.refresh === true);
      case "config.get":
        await this.refresh();
        return {
          config: this.config.config,
          revision: this.config.revision,
          error: this.config.error,
          file: this.config.file,
        };
      case "config.save":
        return this.global.run(async () => {
          const saved = await this.config
            .save(args.config, args.revision, this.prepareConfig)
            .finally(() => {
              this.changingConfig = false;
            });
          this.invalidateInventory();
          this.store.event({
            deviceId: "",
            owner: origin,
            action: "configuration",
            detail: "Saved configuration",
          });
          return saved;
        });
      case "sessions.reserve": {
        await this.expire();
        await this.refresh();
        return this.global.run(async () => {
          const matches = matchDevices(
            await this.devices(),
            this.store.sessions(),
            args.selector,
          );
          if (!matches.length)
            fail("no-match", "No configured device matches the selector.", 404);
          if (matches.length !== 1)
            fail(
              "ambiguous-match",
              "Select one device by name or ID.",
              409,
              matches.map((d) => ({ id: d.id, name: d.name })),
            );
          if (this.simulatorActions.has(matches[0].id))
            fail("device-offline", matches[0].healthDetail, 409);
          if (this.store.lockReason(matches[0].id))
            fail("device-locked", "Device is locked for maintenance.", 409);
          const d = await this.adapters.inspect(this.device(matches[0].id));
          if (!d.online) fail("device-offline", d.healthDetail, 409);
          if (!matchDevices(this.decorate([d]), this.store.sessions(), args.selector).length)
            fail("no-match", "The device no longer matches the requested state or capabilities. Refresh and select it again.", 409);
          if (supportsSimulatorLifecycle(d) && d.connection.type === "adb") {
            const configured = this.device(d.id);
            const resolved = await this.adapters.verifyIdentity(configured);
            if (
              configured.connection.type !== "adb" ||
              resolved.connection.type !== "adb" ||
              !resolved.connection.avdName
            )
              fail(
                "emulator-identity-required",
                "Wait for this emulator's AVD identity to become available before reserving it. Discover again or set its exact AVD name in Edit device.",
                409,
              );
            const connection = {
              ...configured.connection,
              avdName: configured.connection.avdName || resolved.connection.avdName,
            };
            if (
              JSON.stringify(configured.connection) !==
              JSON.stringify(connection)
            ) {
              const next = structuredClone(this.config.config);
              next.devices = next.devices.map((device) =>
                device.id === d.id
                  ? { ...device, connection }
                  : device,
              );
              await this.config.save(
                next,
                this.config.revision,
                this.validateChange,
              );
              this.invalidateInventory(d.id);
            }
          }
          const source = this.config.config.sources.find(
            (s) => s.id === d.captureSourceId,
          );
          try {
            return this.store.reserve(
              d.id,
              source?.id || null,
              source ? sourceIdentity(source) : null,
              args.owner,
              args.reason,
              args.ttlMinutes || this.config.config.settings.ttl,
              this.licensing.status().maxSessions ?? Infinity,
            );
          } catch (e) {
            this.store.event({
              deviceId: d.id,
              owner: args.owner,
              action: "contention",
              detail: (e as Error).message,
            });
            throw e;
          }
        });
      }
      case "sessions.reserveGroup": {
        const { leaseToken: _leaseToken, ...manifest } = args;
        const requestHash = createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex");
        const existingReservation = () => {
          if (!this.store.groups().some((group) => group.id === args.groupId))
            return undefined;
          const group = this.store.validateGroup(
            args.groupId,
            args.leaseToken,
            true,
          );
          if (group.requestHash !== requestHash)
            fail(
              "group-conflict",
              "This group ID and credential already belong to a different reservation request.",
              409,
            );
          if (group.state === "preparing")
            fail(
              "group-preparing",
              "This reservation request is still preparing. Keep its result-file credential and retry shortly, or release it.",
              409,
            );
          if (group.state !== "active")
            fail(
              "group-not-active",
              `This reservation group is ${group.state}. Use a new unique run attempt ID.`,
              409,
            );
          return group;
        };
        const replayReservation = async (existing: ReservationGroup) => {
          const entries = await Promise.all(
            existing.members.map(async (member) => {
              const configured = this.device(member.deviceId);
              const inspected = await this.adapters.inspect(configured);
              if (!inspected.online)
                fail(
                  "group-not-ready",
                  `Reservation group member ${member.alias} is no longer ready: ${inspected.healthDetail}`,
                  409,
                );
              const resolved = member.binding ??
                await this.adapters.verifyIdentity(inspected);
              return [
                member.alias,
                {
                  sessionId: member.sessionId,
                  id: resolved.id,
                  name: resolved.name,
                  platform: resolved.platform,
                  kind: resolved.kind,
                  connection: resolved.connection,
                  startedByGroup: member.startedByGroup,
                },
              ] as const;
            }),
          );
          await this.global.run(async () => {
            const current = this.store.validateGroup(
              existing.id,
              args.leaseToken,
            );
            if (
              current.requestHash !== requestHash ||
              current.members.some(
                (member) =>
                  this.store.session(member.sessionId).state !== "active",
              )
            )
              fail(
                "group-not-active",
                "The reservation group changed while its ready bindings were being read.",
                409,
              );
          });
          return {
            groupId: existing.id,
            leaseToken: args.leaseToken,
            createdAt: existing.createdAt,
            expiresAt: existing.expiresAt,
            devices: Object.fromEntries(entries),
          };
        };
        await this.expire();
        await this.refresh();
        const existing = await this.global.run(async () =>
          existingReservation(),
        );
        if (existing) return replayReservation(existing);
        const admission = await this.global.run(async () => {
          // The initial replay check and admission are separate queue turns.
          // Another identical caller may have claimed this group between them,
          // so resolve that group before matching devices or attempting a new
          // Store transaction.
          const raced = existingReservation();
          if (raced)
            return { kind: "existing" as const, group: raced };
          const observed = await this.devices(true);
          const eligible = observed.filter((device) =>
            device.online ||
            (device.kind === "virtual" &&
              supportsSimulatorLifecycle(device) &&
              canLaunchSimulator(device) &&
              device.simulatorState !== "unavailable"),
          );
          const selected = matchReservationGroup(
            eligible,
            this.store.sessions(),
            args.requests,
            (device) => {
              const source = this.config.config.sources.find(
                (candidate) => candidate.id === device.captureSourceId,
              );
              return source ? sourceIdentity(source) : undefined;
            },
          );
          if (!selected)
            fail(
              "group-no-match",
              "The complete requested device set is not currently available. Physical devices must be online; configured virtual devices may be started automatically.",
              409,
              Object.fromEntries(
                Object.keys(args.requests).map((alias) => {
                  const requested = args.requests[alias].selector;
                  const selector = requested.state === "free"
                    ? { ...requested, state: undefined }
                    : requested;
                  const matches = matchDevices(
                    observed,
                    this.store.sessions(),
                    selector,
                  );
                  return [
                    alias,
                    {
                      selector: requested,
                      matchingConfigured: matches.map((device) => {
                        const session = this.store.sessions().find(
                          (item) =>
                            item.deviceId === device.id && item.state !== "closed",
                        );
                        const usable =
                          !session &&
                          !device.locked &&
                          (device.online ||
                            (device.kind === "virtual" &&
                              supportsSimulatorLifecycle(device) &&
                              canLaunchSimulator(device) &&
                              device.simulatorState !== "unavailable"));
                        return {
                          id: device.id,
                          name: device.name,
                          usable,
                          online: device.online,
                          ...(!usable
                            ? {
                                reason: session
                                  ? `reserved by ${session.owner}`
                                  : device.locked
                                    ? `locked: ${device.lockReason || "maintenance"}`
                                    : device.kind === "physical"
                                      ? "physical device is offline"
                                      : !supportsSimulatorLifecycle(device) || !canLaunchSimulator(device)
                                        ? "virtual device cannot be launched from its saved identity"
                                        : device.simulatorState === "unavailable"
                                          ? "virtual device runtime is unavailable"
                                          : device.healthDetail,
                              }
                            : {}),
                        };
                      }),
                    },
                  ];
                }),
              ),
            );
          const next = structuredClone(this.config.config);
          let learnedIdentity = false;
          for (const selectedDevice of Object.values(selected)) {
            const configured = next.devices.find((device) => device.id === selectedDevice.id);
            if (
              configured?.connection.type === "adb" &&
              selectedDevice.connection.type === "adb" &&
              !configured.connection.avdName &&
              selectedDevice.connection.avdName
            ) {
              configured.connection.avdName = selectedDevice.connection.avdName;
              learnedIdentity = true;
            }
          }
          if (learnedIdentity) {
            await this.config.save(next, this.config.revision, this.validateChange);
            this.invalidateInventory();
          }
          const members = Object.entries(selected).map(([alias, device]) => {
            const source = this.config.config.sources.find(
              (candidate) => candidate.id === device.captureSourceId,
            );
            return {
              alias,
              deviceId: device.id,
              sourceId: source?.id || null,
              sourceKey: source ? sourceIdentity(source) : null,
            };
          });
          let acquired;
          try {
            acquired = this.store.reserveGroup(
              args.groupId,
              members,
              args.owner,
              args.reason,
              requestHash,
              args.ttlMinutes || this.config.config.settings.ttl,
              args.leaseToken,
              this.licensing.status().maxSessions ?? Infinity,
            );
          } catch (error) {
            this.store.event({
              deviceId: "",
              owner: args.owner,
              action: "contention",
              detail: `Reservation group ${args.groupId}: ${(error as Error).message}`,
            });
            throw error;
          }
          // Persist ownership of every cold-start before beginning lifecycle
          // work, so restart recovery knows which virtual devices to restore.
          for (const member of acquired.group.members) {
            const device = selected[member.alias];
            if (!device.online && device.kind === "virtual") {
              member.startedByGroup = true;
              this.simulatorActions.set(device.id, "launch");
            }
          }
          this.store.putGroup(acquired.group);
          return { kind: "claimed" as const, ...acquired, selected };
        });
        if (admission.kind === "existing")
          return replayReservation(admission.group);
        const claimed = admission;
        const prepared = await Promise.allSettled(
          Object.entries(claimed.selected).map(async ([alias, observed]) => {
            const member = claimed.group.members.find((item) => item.alias === alias)!;
            const launchRequested = member.startedByGroup;
            return this.queue(observed.id).run(async () => {
              try {
                let configured = this.device(observed.id);
                if (launchRequested) {
                  configured = await this.adapters.prepareSimulator(configured);
                  const lifecycle = await this.adapters.simulator(configured, "launch");
                  if (!lifecycle.changed) {
                    member.startedByGroup = false;
                    this.store.setGroupMemberStarted(
                      claimed.group.id,
                      alias,
                      false,
                    );
                  }
                }
                let current = await this.adapters.inspect(configured);
                if (!current.online)
                  fail(
                    "device-not-ready",
                    `${current.name} did not become ready: ${current.healthDetail}`,
                    502,
                  );
                const resolved = await this.adapters.verifyIdentity(current);
                current = { ...current, connection: resolved.connection };
                return { alias, member, device: current };
              } finally {
                if (launchRequested) {
                  this.simulatorActions.delete(observed.id);
                  this.invalidateInventory(observed.id);
                }
              }
            });
          }),
        );
        const failed = prepared.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) {
          const message = (failed.reason as Error).message;
          try {
            await this.closeReservationGroup(
              claimed.group.id,
              `Preparation failed: ${message}`,
            );
          } catch (cleanupError) {
            fail(
              "cleanup-required",
              `Reservation preparation failed (${message}) and automatic cleanup needs attention: ${(cleanupError as Error).message}`,
              502,
            );
          }
          throw failed.reason;
        }
        const activated = await this.global.run(async () => {
          const current = this.store.group(claimed.group.id);
          if (
            current.state !== "preparing" ||
            current.expiresAt <= Date.now() ||
            this.shuttingDown ||
            current.members.some(
              (member) => this.store.session(member.sessionId).state !== "active",
            )
          )
            return undefined;
          for (const result of prepared) {
            const { alias, device } = (
              result as PromiseFulfilledResult<any>
            ).value;
            const member = current.members.find((item) => item.alias === alias)!;
            member.binding = {
              id: device.id,
              name: device.name,
              platform: device.platform,
              kind: device.kind,
              connection: device.connection,
            };
          }
          current.state = "active";
          this.store.putGroup(current);
          return current;
        });
        if (!activated) {
          await this.closeReservationGroup(
            claimed.group.id,
            "Reservation group expired or was cancelled during preparation",
          );
          fail(
            "group-preparation-cancelled",
            "The reservation group expired or was cancelled before every device became ready.",
            409,
          );
        }
        const devices = Object.fromEntries(
          prepared.map((result) => {
            const { alias, device } = (result as PromiseFulfilledResult<any>).value;
            const member = activated.members.find((item) => item.alias === alias)!;
            return [
              alias,
              {
                sessionId: member.sessionId,
                id: device.id,
                name: device.name,
                platform: device.platform,
                kind: device.kind,
                connection: device.connection,
                startedByGroup: member.startedByGroup,
              },
            ];
          }),
        );
        return {
          groupId: claimed.group.id,
          leaseToken: claimed.leaseToken,
          createdAt: claimed.group.createdAt,
          expiresAt: claimed.group.expiresAt,
          devices,
        };
      }
      case "sessions.renewGroup": {
        const expiresAt = Date.now() +
          (args.ttlMinutes || this.config.config.settings.ttl) * 60000;
        const group = await this.global.run(async () =>
          this.store.renewGroup(
            args.groupId,
            args.leaseToken,
            expiresAt,
            (session) => this.checkSessionEntitlement(session),
          ),
        );
        return { groupId: group.id, expiresAt: group.expiresAt };
      }
      case "sessions.releaseGroup": {
        this.store.validateGroup(args.groupId, args.leaseToken, true);
        const group = await this.closeReservationGroup(args.groupId, "Released");
        return { groupId: group.id, state: group.state, releasedAt: group.endedAt };
      }
      case "sessions.renew": {
        const s = this.store.validate(args.sessionId, args.leaseToken);
        if (s.groupId)
          fail("group-owned", "Renew this session through its reservation group.", 409);
        this.checkSessionEntitlement(s);
        if (
          this.jobs.get(s.id)?.artifact.mode === "annotated" &&
          !this.licensing.status().features.includes(FEATURES.annotations)
        )
          fail(
            "pro-required",
            "Pro access ended. This recording can finish within its existing lease; stop remains available.",
            403,
          );
        s.expiresAt =
          Date.now() +
          (args.ttlMinutes || this.config.config.settings.ttl) * 60000;
        this.store.putSession(s);
        return s;
      }
      case "sessions.release": {
        const s = this.store.validate(args.sessionId, args.leaseToken, true);
        if (s.groupId)
          fail("group-owned", "Release this session through its reservation group.", 409);
        return this.closeSession(s.id, "Released");
      }
      case "sessions.takeover": {
        this.device(args.deviceId);
        const active = this.store
          .sessions()
          .find((s) => s.deviceId === args.deviceId && s.state !== "closed");
        if (active?.groupId)
          fail("group-owned", "Release the owning reservation group before taking this device.", 409);
        if (active)
          await this.closeSession(
            active.id,
            `Taken over by ${args.owner}: ${args.reason}`,
          );
        this.store.event({
          deviceId: args.deviceId,
          owner: args.owner,
          action: "takeover",
          detail: args.reason,
        });
        return this.execute(
          "sessions.reserve",
          {
            selector: { device: args.deviceId },
            owner: args.owner,
            reason: args.reason,
          },
          origin,
        );
      }
      case "devices.wake": {
        await this.refresh();
        const validate = () => {
          if (this.changingConfig || this.shuttingDown)
            fail(
              "configuration-changing",
              "Wait for the current configuration change.",
              409,
            );
          const device = this.device(args.deviceId);
          if (!supportsWake(device))
            fail(
              "unsupported-capability",
              "Wake is not supported for this device connection.",
            );
          if (this.store.lockReason(device.id))
            fail("device-locked", "Device is locked for maintenance.", 409);
          const session = this.store.sessions().find(
            (s) => s.deviceId === device.id && s.state !== "closed",
          );
          if (
            args.sessionId &&
            (!session ||
              session.id !== args.sessionId ||
              session.state !== "active" ||
              session.expiresAt <= Date.now())
          )
            fail(
              "stale-wake",
              "This reservation changed or ended. Review the device before waking it again.",
              409,
            );
          if (session && (!args.sessionId || args.confirmed !== true))
            fail(
              "device-reserved",
              `Reserved by ${session.owner}. Waking may interrupt their work. Confirm wake with the current sessionId to continue without taking the reservation.`,
              409,
            );
          return { device, session };
        };
        validate();
        // Admission and config changes use global -> device order too. Keep that
        // order across adapter identity checks so no new lease starts mid-wake.
        return this.global.run(() =>
          this.queue(args.deviceId).run(async () => {
            const { device, session } = validate();
            try {
              const result = await this.adapters.wake(device);
              this.store.event({
                deviceId: device.id,
                sessionId: session?.id,
                owner: origin,
                action: "wake",
                detail: `Wake attempted: ${result.method}`,
              });
              return {
                deviceId: device.id,
                status: "attempted",
                method: result.method,
                ...(session ? { sessionId: session.id } : {}),
              };
            } catch (error) {
              this.store.event({
                deviceId: device.id,
                sessionId: session?.id,
                owner: origin,
                action: "wake-failed",
                detail: `Wake attempt failed: ${(error as Error).message}`,
              });
              throw error;
            } finally {
              if (this.healthPending) await this.healthPending.catch(() => {});
              this.invalidateInventory(args.deviceId);
            }
          }),
        );
      }
      case "devices.simulator": {
        await this.refresh();
        const device = await this.global.run(async () => {
          if (this.changingConfig || this.shuttingDown)
            fail(
              "configuration-changing",
              "Wait for the current configuration change.",
              409,
            );
          let device = this.device(args.deviceId);
          if (!supportsSimulatorLifecycle(device))
            fail(
              "unsupported-lifecycle",
              "Launch and close are supported for configured Apple iOS/tvOS simulators and Android emulators.",
            );
          if (args.action === "close" && args.confirmed !== true)
            fail(
              "confirmation-required",
              "Confirm before closing this simulator.",
            );
          const session = this.store
            .sessions()
            .find((s) => s.deviceId === device.id && s.state !== "closed");
          if (session)
            fail(
              "device-reserved",
              `Reserved by ${session.owner}. End its session and save any recording before ${args.action === "launch" ? "launching" : "closing"} the simulator.`,
              409,
            );
          if (this.store.lockReason(device.id))
            fail(
              "device-locked",
              "Unlock this device before changing simulator state.",
              409,
            );
          this.simulatorActions.set(device.id, args.action);
          this.store.lock(
            device.id,
            args.action === "launch"
              ? "Simulator launch in progress"
              : "Simulator shutdown in progress",
          );
          try {
            // Learn an existing emulator's AVD only from its exact live ADB transport.
            const resolved = await this.adapters.prepareSimulator(device);
            const next = structuredClone(this.config.config);
            const connection = device.connection.type === "adb" && resolved.connection.type === "adb"
              ? { ...device.connection, ...(resolved.connection.avdName ? { avdName: device.connection.avdName || resolved.connection.avdName } : {}) }
              : resolved.connection;
            let configured = { ...device, connection };
            if (args.action === "launch" && !configured.captureSourceId) {
              let source = next.sources.find((s) => s.kind === "native" && s.deviceId === device.id);
              if (!source) {
                const base = `native-${device.id}`;
                let id = base, suffix = 2;
                while (next.sources.some((s) => s.id === id)) id = `${base}-${suffix++}`;
                source = { id, name: `${device.name} screen`, kind: "native", deviceId: device.id };
                next.sources.push(source);
              }
              configured = { ...configured, captureSourceId: source.id };
            }
            if (JSON.stringify(configured) !== JSON.stringify(device)) {
              next.devices = next.devices.map((d) => d.id === device.id ? configured : d);
              await this.config.save(next, this.config.revision, (next) =>
                this.validateChange(next, device.id),
              );
              device = this.device(device.id);
              this.invalidateInventory();
            }
            return device;
          } catch (error) {
            this.simulatorActions.delete(device.id);
            this.store.lock(device.id, null);
            throw error;
          }
        });
        return this.queue(device.id).run(async () => {
          try {
            const source = this.config.config.sources.find(
              (s) => s.id === device.captureSourceId,
            );
            if (args.action === "close" && source?.kind === "native")
              await this.capture.closeSource(source);
            const result = await this.adapters.simulator(device, args.action);
            this.store.event({
              deviceId: device.id,
              owner: origin,
              action: `simulator-${args.action}`,
              detail:
                args.action === "launch"
                  ? "Launched simulator"
                  : "Closed simulator",
            });
            return { ...result, sourceId: device.captureSourceId };
          } finally {
            this.simulatorActions.delete(device.id);
            this.store.lock(device.id, null);
            if (this.healthPending) await this.healthPending.catch(() => {});
            this.invalidateInventory(device.id);
          }
        });
      }
      case "devices.bulk":
        return Promise.all(
          [...new Set<string>(args.ids)].map((id) =>
            this.queue(id).run(async () => {
              try {
                const d = this.device(id);
                if (this.simulatorActions.has(id))
                  fail(
                    "device-busy",
                    "Wait for simulator launch or close to finish.",
                    409,
                  );
                if (
                  this.store
                    .sessions()
                    .some((s) => s.deviceId === id && s.state !== "closed")
                )
                  fail(
                    "device-reserved",
                    "Release this device before maintenance.",
                    409,
                  );
                if (this.deviceHasOpenGroup(id))
                  fail(
                    "device-reserved",
                    "Finish reservation group cleanup before changing maintenance state.",
                    409,
                  );
                // A maintenance lock is established synchronously before any restart awaits.
                if (args.action === "restart") {
                  const previous = this.store.lockReason(id);
                  this.store.lock(id, "Restart in progress");
                  try {
                    await this.adapters.restart(d);
                  } finally {
                    this.store.lock(id, previous || null);
                    this.invalidateInventory(id);
                  }
                } else
                  this.store.lock(
                    id,
                    args.action === "lock" ? args.reason : null,
                  );
                this.store.event({
                  deviceId: id,
                  owner: origin,
                  action: args.action,
                  detail: args.reason,
                });
                return { id, ok: true };
              } catch (e) {
                return { id, ok: false, error: (e as Error).message };
              }
            }),
          ),
        );
      case "pairing.start":
        return this.withLease(args, async (s) => {
          if (this.pairings.has(s.id))
            fail(
              "pairing-active",
              "This session already has a pairing request.",
            );
          const handle = await this.adapters.pair(this.device(s.deviceId));
          const timer = setTimeout(() => {
            this.pairings.delete(s.id);
            void stop(handle);
          }, 120000);
          this.pairings.set(s.id, { handle, timer });
          return { waitingForPin: true, expiresInSeconds: 120 };
        });
      case "pairing.finish":
        return this.withLease(args, async (s) => {
          const pairing = this.pairings.get(s.id);
          if (!pairing) fail("pairing-missing", "Start pairing again.");
          clearTimeout(pairing.timer);
          this.pairings.delete(s.id);
          pairing.handle.child.stdin.end(args.pin + "\n");
          const timeout = setTimeout(() => void stop(pairing.handle), 20000);
          try {
            const result = await pairing.handle.completed;
            if (result.code !== 0)
              fail(
                "pairing-failed",
                pairing.handle.log() || "Pairing failed.",
                502,
              );
            this.invalidateInventory(s.deviceId);
            return { paired: true };
          } finally {
            clearTimeout(timeout);
          }
        });
      case "remote.input":
        return this.withLease(args, (session) => {
          const hardware = args.key && phoneHardwareButtons(this.device(session.deviceId)).some((button) => button.key === args.key);
          if (!hardware) return this.remoteInput(session, args);
          return this.streams.withHardwareInput(session.id, async () => {
            // The gesture barrier may outlast a grant, aborted request or lease.
            if (authorize && !await authorize()) fail("unauthorized", "Machine access expired or was revoked before the hardware button could be sent.", 401);
            const current = this.store.validate(args.sessionId, args.leaseToken);
            return this.remoteInput(current, args);
          });
        });
      case "streams.open":
        return this.streams.open(args, authorize);
      case "streams.ping":
        return this.streams.ping(args, authorize);
      case "streams.close":
        return this.streams.closeStream(args);
      case "control.start":
      case "control.pointer":
      case "remote.gesture": {
        return this.withLease(args, async (session) => {
          const target = this.liveTarget({ deviceId: session.deviceId, control: true, ...args });
          const controller = await this.streams.script(session.id, target, authorize);
          if (operation === "control.pointer") controller.control.send({ type: "pointer", event: args.event });
          if (operation === "remote.gesture") controller.control.send({ type: "gesture", gesture: args.gesture });
          await controller.control.settled();
          target.validate();
          return { capabilities: controller.source.capabilities, width: controller.source.width, height: controller.source.height };
        });
      }
      case "control.stop":
        return this.withLease(args, async (session) => { await this.streams.stopScript(session.id); return { ok: true }; });
      case "remote.override": {
        const validate = () => {
          this.device(args.deviceId);
          const session = this.store.sessions().find((s) => s.id === args.sessionId);
          if (
            !session ||
            session.deviceId !== args.deviceId ||
            session.state !== "active" ||
            session.expiresAt <= Date.now()
          )
            fail(
              "stale-override",
              "This reservation changed or ended. Choose how to control the device again.",
              409,
            );
          if (this.store.lockReason(args.deviceId))
            fail("device-locked", "Device is locked for maintenance.", 409);
          return session;
        };
        validate();
        return this.queue(args.deviceId).run(async () => {
          const session = validate();
          const input = await this.remoteInput(session, args);
          this.store.event({
            deviceId: session.deviceId,
            sessionId: session.id,
            owner: args.owner,
            action: "control-override",
            detail: `Sent remote input without taking ${session.owner}'s reservation.`,
          });
          return input;
        });
      }
      case "captures.screenshot":
        return this.withLease(args, (s) =>
          this.screenshot(s, args.mode, args.clipboard, origin),
        );
      case "recordings.start":
        return this.withLease(args, (s) =>
          this.startRecording(s, args.mode, origin),
        );
      case "recordings.stop":
        return this.withLease(args, (s) => this.finishRecording(s.id));
      case "captures.openFolder":
        await this.refresh();
        return openCaptureFolder(this.config.folder);
      case "captures.storage":
        return this.library.run(() => captureStorage(this.store.artifacts()));
      case "captures.edit":
        return this.library.run(async () => {
          const a = this.store.artifact(args.id);
          if (["recording", "finalizing"].includes(a.status))
            fail("capture-busy", "Wait for capture completion.");
          if (a.purgedAt)
            fail("capture-purged", "Capture files were permanently deleted.");
          a.name = args.name;
          a.tags = [...new Set<string>(args.tags)];
          let manifest: Record<string, unknown>;
          try {
            manifest = JSON.parse(await readFile(a.logPath, "utf8"));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            manifest = { schemaVersion: 1, inputs: [] };
          }
          await atomicWrite(
            a.logPath,
            JSON.stringify(
              { ...manifest, artifact: a, updatedAt: Date.now() },
              null,
              2,
            ) + "\n",
          );
          this.store.putArtifact(a);
          return a;
        });
      case "captures.purge":
        return this.library.run(async () => {
          const artifacts = args.ids.map((id: string) =>
            this.store.artifact(id),
          ) as Artifact[];
          if (
            artifacts.some(
              (a) =>
                !a.deletedAt || ["recording", "finalizing"].includes(a.status),
            )
          )
            fail(
              "capture-busy",
              "Only trashed, stopped captures can be permanently deleted.",
            );
          for (const a of artifacts) {
            for (const file of new Set(
              [
                a.path,
                a.cleanPath,
                a.logPath,
                ...[a.path, a.cleanPath]
                  .filter(Boolean)
                  .map((p) =>
                    path.join(
                      path.dirname(p!),
                      "annotation-" + path.basename(p!) + ".ass",
                    ),
                  ),
              ].filter(Boolean) as string[],
            ))
              await rm(file, { force: true });
            a.purgedAt = Date.now();
            this.store.putArtifact(a);
          }
          return artifacts;
        });
      case "captures.remove":
      case "captures.restore":
        return this.library.run(async () => {
          const artifacts = args.ids.map((id: string) =>
            this.store.artifact(id),
          ) as Artifact[];
          if (artifacts.some((a) => a.purgedAt))
            fail(
              "capture-purged",
              "Permanently deleted files cannot be restored.",
            );
          if (
            artifacts.some((a) =>
              ["recording", "finalizing"].includes(a.status),
            )
          )
            fail("capture-busy", "Stop selected recordings first.");
          return this.store.transaction(() =>
            artifacts.map((a) => {
              a.deletedAt =
                operation === "captures.remove" ? Date.now() : undefined;
              this.store.putArtifact(a);
              return a;
            }),
          );
        });
    }
  }
  private async remoteInput(
    session: Session,
    args: Parameters<Adapters["input"]>[1],
  ) {
    const modes =
      Number(args.key !== undefined) +
      Number(args.text !== undefined) +
      Number(args.x !== undefined || args.y !== undefined);
    if (modes !== 1 || (args.x !== undefined) !== (args.y !== undefined))
      fail(
        "invalid-input",
        "Supply exactly one key, text, or complete x/y tap.",
      );
    const at = Date.now(),
      mono = performance.now(),
      job = this.jobs.get(session.id);
    await this.adapters.input(this.device(session.deviceId), args);
    const key =
      args.key ||
      (args.text !== undefined
        ? `Text: ${args.text}`
        : `Tap ${args.x}, ${args.y}`);
    const inputValue = {
      at,
      sessionId: session.id,
      deviceId: session.deviceId,
      key,
      recordingId: job && !job.finishing ? job.artifact.id : null,
      elapsedMs:
        job && !job.finishing
          ? Math.max(0, Math.round(mono - job.handle.startedMono))
          : null,
    };
    return this.config.config.settings.logging &&
      (!job || job.artifact.logging !== false)
      ? this.store.input(inputValue)
      : { ...inputValue, id: 0 };
  }
  private withLease<T>(
    args: { sessionId: string; leaseToken: string },
    fn: (s: Session) => Promise<T>,
  ): Promise<T> {
    const s = this.store.validate(args.sessionId, args.leaseToken);
    return this.queue(s.deviceId).run(async () => {
      const current = this.store.validate(args.sessionId, args.leaseToken);
      return fn(current);
    });
  }
  private liveTarget(args: Pick<StreamOpen, "deviceId" | "sourceId" | "control" | "sessionId" | "leaseToken">): LiveTarget {
    const device = args.deviceId ? this.device(args.deviceId) : this.config.config.devices.find((d) => d.captureSourceId === args.sourceId) || null;
    const source = this.config.config.sources.find((s) => s.id === (args.sourceId || device?.captureSourceId));
    if (args.sourceId && !source) fail("source-missing", "Capture source is no longer configured.", 404);
    if (!device && !source) fail("source-missing", "Select a configured device or capture source.", 404);
    const deviceIdentity = JSON.stringify(device);
    const sourceIdentity = JSON.stringify(source);
    const toolIdentity = JSON.stringify(this.config.config.tools);
    const validate = () => {
      if (this.shuttingDown || this.changingConfig) fail("configuration-changing", "Device configuration is changing. Reconnect the viewer.", 409);
      if (JSON.stringify(this.config.config.tools) !== toolIdentity) fail("configuration-changing", "Capture tools changed. Reconnect the viewer.", 409);
      if (device) {
        if (JSON.stringify(this.device(device.id)) !== deviceIdentity) fail("identity-mismatch", "The device configuration changed. Reconnect the viewer.", 409);
        if (this.store.lockReason(device.id)) fail("device-locked", "Device is locked for maintenance.", 409);
        if (this.store.sessions().some((s) => s.deviceId === device.id && s.state === "closing")) fail("session-closing", "The device session is being released.", 409);
      }
      if (source && JSON.stringify(this.config.config.sources.find((s) => s.id === source.id)) !== sourceIdentity)
        fail("source-changed", "The capture source changed. Reconnect the viewer.", 409);
      if (args.control) {
        if (!device || !args.sessionId || !args.leaseToken) fail("lease-required", "Start a control session first.", 403);
        const session = this.store.validate(args.sessionId, args.leaseToken);
        if (session.deviceId !== device.id) fail("lease-mismatch", "This reservation belongs to another device.", 403);
        this.checkSessionEntitlement(session);
      }
    };
    validate();
    return { device, source, validate };
  }
  async preview(
    deviceId: string,
    interval = this.config.config.settings.previewIntervalMs,
  ) {
    const d = this.device(deviceId);
    return this.queue(d.id).run(async () => {
      if (this.changingConfig)
        fail(
          "configuration-changing",
          "Capture configuration is being updated.",
          409,
        );
      if (this.store.lockReason(d.id))
        fail("device-locked", "Device is locked for maintenance.", 409);
      if (
        this.store
          .sessions()
          .some((s) => s.deviceId === d.id && s.state === "closing")
      )
        fail("session-closing", "Capture source is being released.", 409);
      const source = this.config.config.sources.find(
        (s) => s.id === d.captureSourceId,
      );
      if (!source) fail("source-missing", "No capture input configured.", 404);
      return this.capture.preview(d, source, interval);
    });
  }
  async previewSource(sourceId: string) {
    const source = this.config.config.sources.find((s) => s.id === sourceId);
    if (!source || source.kind !== "usb")
      fail(
        "source-missing",
        "Register this USB capture card before viewing it.",
        404,
      );
    const device = this.config.config.devices.find(
      (d) => d.captureSourceId === source.id,
    );
    // Bound cards keep the same maintenance and release rules as device previews.
    if (device) return this.preview(device.id, 100);
    return this.queue(`source:${source.id}`).run(async () => {
      if (this.changingConfig || this.shuttingDown)
        fail(
          "configuration-changing",
          "Capture configuration is being updated.",
          409,
        );
      if (this.config.config.sources.find((s) => s.id === sourceId) !== source)
        fail(
          "configuration-changing",
          "Capture configuration changed. Retry this feed.",
          409,
        );
      return this.capture.preview(null, source, 100);
    });
  }
  async captureCardThumbnail(sourceId: string) {
    const resolve = () => {
      if (this.changingConfig || this.shuttingDown)
        fail("configuration-changing", "Capture configuration is being updated.", 409);
      const card = this.adapters.cachedCaptureCards(this.config.config.sources).sources.find((source) => source.id === sourceId);
      if (!card?.uniqueId || card.kind !== "usb" || this.config.config.ignoredCaptureCardIds.includes(card.uniqueId))
        fail("source-missing", "This capture card is no longer available. Refresh Capture Cards.", 404);
      if (card.status !== "connected")
        fail("source-missing", "Connect this capture card and refresh Capture Cards to preview it.", 404);
      const device = this.config.config.devices.find((item) => item.captureSourceId === card.id) ?? null;
      if (device && this.store.lockReason(device.id))
        fail("device-locked", "Device is locked for maintenance.", 409);
      if (device && this.store.sessions().some((session) => session.deviceId === device.id && session.state === "closing"))
        fail("session-closing", "Capture source is being released.", 409);
      const source: SourceConfig = { id: card.id, name: card.name, kind: "usb", uniqueId: card.uniqueId };
      return { source, device, key: JSON.stringify([this.config.revision, source, device]) };
    };
    const target = resolve();
    const validate = () => {
      const current = resolve();
      if (current.key !== target.key)
        fail("source-changed", "This capture card changed while its preview was loading. Try again.", 409);
    };
    const data = await this.captureCardThumbnails.get(target.key, () =>
      this.queue(target.device?.id ?? `source:${target.source.id}`).run(async () => {
        validate();
        // Share active capture work, but close a worker opened only for this still.
        const image = await this.capture.preview(target.device, target.source, 30_000, true);
        validate();
        return image;
      }),
    );
    validate();
    return data;
  }
  private artifact(
    s: Session,
    kind: Artifact["kind"],
    mode: Artifact["mode"],
    origin: Artifact["origin"],
  ): Artifact {
    const id = randomUUID(),
      now = new Date(),
      d = this.device(s.deviceId);
    const safe = (v: string) =>
      v.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    const name = safe(
      this.config.config.settings.naming
        .replaceAll("{device}", d.name)
        .replaceAll("{date}", now.toISOString().slice(0, 10))
        .replaceAll(
          "{time}",
          now.toISOString().slice(11, 23).replaceAll(":", "-"),
        ),
    );
    const file = path.join(
      this.config.folder,
      `${name}-${id.slice(0, 8)}.${kind === "recording" ? "mp4" : "png"}`,
    );
    return {
      id,
      deviceId: d.id,
      sessionId: s.id,
      owner: s.owner,
      sourceId: this.source(s).id,
      name,
      path: file,
      logPath: `${file}.json`,
      logging: this.config.config.settings.logging,
      kind,
      mode,
      tags: [],
      createdAt: Date.now(),
      duration: 0,
      bytes: 0,
      status: "recording",
      origin,
    };
  }
  private async manifest(a: Artifact) {
    await atomicWrite(
      a.logPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          artifact: a,
          inputs:
            a.logging !== false
              ? this.store
                  .inputs(a.sessionId)
                  .filter(
                    (i) => a.kind === "screenshot" || i.recordingId === a.id,
                  )
              : [],
          timeOrigin:
            "Milliseconds from recorder readiness; input timestamp is dispatch time.",
          writtenAt: Date.now(),
        },
        null,
        2,
      ) + "\n",
    );
  }
  private async screenshot(
    s: Session,
    mode: Artifact["mode"] | undefined,
    clipboard: boolean | undefined,
    origin: Artifact["origin"],
  ) {
    const a = this.artifact(
      s,
      "screenshot",
      mode || this.config.config.settings.captureMode,
      origin,
    );
    this.store.putArtifact(a);
    try {
      a.bytes = await this.capture.screenshot(
        this.device(s.deviceId),
        this.source(s),
        a.path,
      );
      if (a.mode === "annotated") {
        a.cleanPath = a.path;
        a.path = a.path.replace(/\.png$/, "-annotated.png");
        await this.capture.annotate(
          a.cleanPath,
          a.path,
          a.logging === false ? [] : this.store.inputs(s.id).slice(-1),
          this.device(s.deviceId).name,
          s.id,
          "screenshot",
        );
        a.bytes = (await stat(a.path)).size;
      }
      a.status = "completed";
      this.store.putArtifact(a);
      await this.manifest(a);
      this.store.event({
        deviceId: s.deviceId,
        sessionId: s.id,
        owner: s.owner,
        action: "screenshot",
        detail: a.name,
      });
    } catch (e) {
      a.status = "failed";
      a.error = (e as Error).message;
      this.store.putArtifact(a);
      await this.manifest(a).catch(() => {});
      throw e;
    }
    if (clipboard ?? this.config.config.settings.clipboard) {
      try {
        await this.capture.clipboard(a.path);
      } catch (e) {
        return { ...a, clipboardError: (e as Error).message };
      }
    }
    return a;
  }
  private async startRecording(
    s: Session,
    mode: Artifact["mode"] | undefined,
    origin: Artifact["origin"],
  ) {
    if (
      (mode || this.config.config.settings.captureMode) === "annotated" &&
      !this.licensing.status().features.includes(FEATURES.annotations)
    )
      fail(
        "pro-required",
        "Recording annotations require an active Pro or trial license. Clean recording remains available.",
        403,
      );
    if (this.jobs.has(s.id))
      fail("already-recording", "This session already has a recording.", 409);
    const a = this.artifact(
      s,
      "recording",
      mode || this.config.config.settings.captureMode,
      origin,
    );
    this.store.putArtifact(a);
    try {
      const d = this.device(s.deviceId),
        source = this.source(s);
      await this.manifest(a);
      const handle = await this.capture.startRecording(
        a.id,
        d,
        source,
        a.path,
        this.config.config.settings.maxRecordingMinutes,
        (worker) =>
          this.store.worker(a.id, {
            ...worker,
            path: a.path,
            device: worker.device || d,
          }),
      );
      a.createdAt = handle.startedAt;
      this.store.worker(a.id, {
        pid: handle.pid,
        path: a.path,
        device: handle.device || d,
        remotePid: handle.remotePid,
        remotePath: handle.remotePath,
      });
      const limit = Math.min(
        this.config.config.settings.maxRecordingMinutes * 60000,
        d.connection.type === "adb" && source.kind === "native"
          ? 175000
          : Infinity,
      );
      const timer = setTimeout(() => {
        void this.queue(d.id)
          .run(() =>
            this.finishRecording(s.id, undefined, "Recording duration limit"),
          )
          .catch((e) => this.diagnostics.push(String(e)));
      }, limit);
      const job: Job = { artifact: a, handle, timer };
      this.jobs.set(s.id, job);
      this.store.putArtifact(a);
      await this.manifest(a);
      void handle.ended.then((error) => {
        if (error && !job.finishing) {
          const current = this.store.session(s.id);
          if (current.groupId) {
            void this.closeReservationGroup(current.groupId, error).catch((e) =>
              this.diagnostics.push(String(e)),
            );
          } else {
            if (current.state === "active") {
              current.state = "closing";
              current.closeReason = error;
              this.store.putSession(current);
            }
            void this.closeSession(s.id, error, true).catch((e) =>
              this.diagnostics.push(String(e)),
            );
          }
        }
      });
      this.store.event({
        deviceId: s.deviceId,
        sessionId: s.id,
        owner: s.owner,
        action: "recording-started",
        detail: a.name,
      });
      return { ...a, maxDurationSeconds: limit / 1000 };
    } catch (e) {
      a.status = "failed";
      a.error = (e as Error).message;
      this.store.putArtifact(a);
      await this.manifest(a).catch(() => {});
      throw e;
    }
  }
  private async finishRecording(
    sessionId: string,
    interruption?: string,
    detail = "Recording stopped",
  ): Promise<Artifact | null> {
    const job = this.jobs.get(sessionId);
    if (!job)
      return (
        this.store
          .artifacts()
          .find((a) => a.sessionId === sessionId && a.kind === "recording") ||
        null
      );
    if (job.finishing) return job.finishing;
    clearTimeout(job.timer);
    job.finishing = (async () => {
      const a = job.artifact;
      a.status = "finalizing";
      this.store.putArtifact(a);
      try {
        const result = await job.handle.stop();
        a.duration = result.duration;
        a.bytes = result.bytes;
        a.error = interruption || result.interruption;
        a.status = a.error ? "interrupted" : "completed";
        if (a.mode === "annotated" && !a.error) {
          a.cleanPath = a.path;
          a.path = a.path.replace(/\.mp4$/, "-annotated.mp4");
          await this.capture.annotate(
            a.cleanPath,
            a.path,
            a.logging === false
              ? []
              : this.store
                  .inputs(sessionId)
                  .filter((i) => i.recordingId === a.id),
            this.device(a.deviceId).name,
            sessionId,
            "recording",
          );
          a.bytes = (await stat(a.path)).size;
        }
      } catch (e) {
        a.status = "interrupted";
        a.error = (e as Error).message;
      }
      this.store.putArtifact(a);
      await this.manifest(a).catch((e) => {
        a.error = `${a.error || ""} Manifest: ${e.message}`;
        this.store.putArtifact(a);
      });
      if (a.status === "completed") this.store.clearWorker(a.id);
      this.jobs.delete(sessionId);
      if (a.status !== "completed" && !this.closing.has(sessionId)) {
        const session = this.store.session(sessionId);
        const reason = a.error || "Recorder interrupted";
        if (session.groupId)
          void this.closeReservationGroup(session.groupId, reason).catch((e) =>
            this.diagnostics.push(String(e)),
          );
        else
          void this.closeSession(sessionId, reason, true).catch((e) =>
            this.diagnostics.push(String(e)),
          );
      }
      this.store.event({
        deviceId: a.deviceId,
        sessionId,
        owner: a.owner,
        action:
          a.status === "completed" ? "recording-completed" : "capture-failed",
        detail: a.error || detail,
        durationMs: a.duration * 1000,
      });
      return a;
    })();
    return job.finishing;
  }
  private closeReservationGroup(
    id: string,
    reason: string,
  ): Promise<ReservationGroup> {
    const prior = this.groupClosing.get(id);
    if (prior) return prior;
    const lockReason = `Reservation group ${id} cleanup`;
    const closing = this.global
      .run(async () => {
        const group = this.store.group(id);
        if (group.state === "closed") return group;
        group.state = "closing";
        group.closeReason = reason;
        this.store.putGroup(group);
        // Keep every member unavailable through the gap between session close
        // and simulator restoration. A successor can reserve only after all
        // cold-started virtual devices have been shut down.
        for (const member of group.members)
          this.store.lock(member.deviceId, lockReason);
        return group;
      })
      .then(async (group) => {
        if (group.state === "closed") return group;
        try {
          await Promise.all(
            group.members.map((member) =>
              this.closeSession(member.sessionId, reason),
            ),
          );
          await Promise.all(
            this.store
              .group(group.id)
              .members
              .filter((member) => member.startedByGroup)
              .map((member) => {
                this.simulatorActions.set(member.deviceId, "close");
                return this.queue(member.deviceId).run(async () => {
                  try {
                    const device = this.device(member.deviceId);
                    await this.adapters.simulator(device, "close");
                    this.store.event({
                      deviceId: member.deviceId,
                      sessionId: member.sessionId,
                      owner: group.owner,
                      action: "simulator-close",
                      detail: `Restored after reservation group ${group.id}`,
                    });
                  } finally {
                    this.simulatorActions.delete(member.deviceId);
                    this.invalidateInventory(member.deviceId);
                  }
                });
              }),
          );
          const completed = this.store.group(group.id);
          completed.state = "closed";
          completed.endedAt = Date.now();
          completed.closeReason = reason;
          // Lock removal and the durable closed state commit together. A
          // crash can therefore leave either a recoverable closing group or a
          // fully closed/unlocked group, never a closed group with stale locks.
          this.store.finalizeGroup(completed, lockReason);
          this.store.event({
            deviceId: "",
            owner: group.owner,
            action: "reservation-group-released",
            detail: `${group.id}: ${reason}`,
          });
          return completed;
        } catch (error) {
          const current = this.store.group(group.id);
          current.state = "closing";
          current.closeReason = `Cleanup required: ${(error as Error).message}`;
          this.store.putGroup(current);
          throw error;
        }
      })
      .finally(() => this.groupClosing.delete(id));
    this.groupClosing.set(id, closing);
    return closing;
  }
  closeSession(
    id: string,
    reason: string,
    interrupted = false,
  ): Promise<Session> {
    const prior = this.closing.get(id);
    if (prior) return prior;
    const s = this.store.session(id);
    if (s.state === "closed") return Promise.resolve(s);
    // Invalidate credentials immediately, before waiting for queued I/O or recorder finalization.
    s.state = "closing";
    s.closeReason = reason;
    this.store.putSession(s);
    const stopInput = this.streams.closeSession(s.id);
    const closing = this.queue(s.deviceId)
      .run(async () => {
        await stopInput;
        await this.finishRecording(
          s.id,
          interrupted || reason.startsWith("Service") ? reason : undefined,
        );
        for (const worker of this.store
          .workers()
          .filter((w) => this.store.artifact(w.id).sessionId === s.id))
          await this.cleanWorker(worker);
        const pairing = this.pairings.get(s.id);
        if (pairing) {
          clearTimeout(pairing.timer);
          this.pairings.delete(s.id);
          await stop(pairing.handle);
        }
        if (s.sourceId) await this.capture.closeSource(this.source(s));
        s.state = "closed";
        s.endedAt = Date.now();
        this.store.putSession(s);
        this.store.event({
          deviceId: s.deviceId,
          sessionId: s.id,
          owner: s.owner,
          action: "released",
          detail: reason,
          durationMs: s.endedAt - s.createdAt,
        });
        return s;
      })
      .finally(() => this.closing.delete(id));
    this.closing.set(id, closing);
    return closing;
  }
  async expire() {
    const now = Date.now();
    await Promise.all([
      ...this.store
        .groups()
        .filter(
          (group) =>
            group.state !== "closed" &&
            (group.expiresAt <= now || group.state === "closing"),
        )
        .map((group) =>
          this.closeReservationGroup(group.id, "Reservation group expired"),
        ),
      ...this.store
        .sessions()
        .filter(
          (session) =>
            !session.groupId &&
            session.state === "active" &&
            session.expiresAt <= now,
        )
        .map((session) => this.closeSession(session.id, "Reservation expired")),
    ]);
  }
  private permittedSessionIds() {
    const limit = this.licensing.status().maxSessions;
    const active = this.store
      .sessions()
      .filter((s) => s.state !== "closed")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return new Set(
      (limit === null ? active : active.slice(0, limit)).map((s) => s.id),
    );
  }
  private checkSessionEntitlement(session: Session) {
    if (!this.permittedSessionIds().has(session.id))
      fail(
        "pro-required",
        "Pro access ended. This extra session can finish within its existing lease but cannot be renewed.",
        403,
      );
  }
  private async cleanWorker(worker: any) {
    if (
      worker.remotePath &&
      worker.device?.connection.type === "adb" &&
      worker.device.connection.avdName
    )
      worker.device = await this.adapters.verifyIdentity(worker.device);
    const needle = worker.remotePath || worker.path;
    if (
      worker.remotePath &&
      !worker.remotePid &&
      worker.device?.connection.type === "adb"
    ) {
      const listed = await run(this.adapters.tool("adb"), [
        ...this.adapters.adb(worker.device),
        "shell",
        "ps",
        "-A",
        "-o",
        "PID,ARGS",
      ]);
      for (const line of listed.stdout.toString().split("\n")) {
        const match =
          /^\s*(\d+)\s+(?:\/system\/bin\/)?screenrecord\s+(.+)$/.exec(line);
        if (match && match[2].split(/\s+/).includes(worker.remotePath))
          worker.remotePid = match[1];
      }
    }
    if (
      worker.remotePid &&
      worker.remotePath &&
      worker.device?.connection.type === "adb"
    ) {
      // Offline ADB cannot establish that its recorder stopped. Keep the reservation closing.
      await run(this.adapters.tool("adb"), [
        ...this.adapters.adb(worker.device),
        "get-state",
      ]);
      const listing = await run(this.adapters.tool("adb"), [
        ...this.adapters.adb(worker.device),
        "shell",
        "sh",
        "-c",
        `"if [ -r /proc/${worker.remotePid}/cmdline ]; then cat /proc/${worker.remotePid}/cmdline; fi"`,
      ]);
      const command = listing.stdout.toString().split("\0");
      if (
        command[0]?.endsWith("screenrecord") &&
        command.includes(worker.remotePath)
      ) {
        await run(this.adapters.tool("adb"), [
          ...this.adapters.adb(worker.device),
          "shell",
          "kill",
          "-2",
          worker.remotePid,
        ]);
        let alive = true;
        for (let n = 0; n < 50; n++) {
          const result = await run(this.adapters.tool("adb"), [
            ...this.adapters.adb(worker.device),
            "shell",
            "sh",
            "-c",
            `"if [ -r /proc/${worker.remotePid}/cmdline ]; then cat /proc/${worker.remotePid}/cmdline; fi"`,
          ]);
          if (
            !result.stdout.toString().split("\0").includes(worker.remotePath)
          ) {
            alive = false;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (alive)
          fail(
            "cleanup-required",
            "The owned Android recorder has not stopped. Keep the device connected and retry release.",
            409,
          );
      }
    }
    if (worker.pid) {
      const command = await run("/bin/ps", [
        "-p",
        String(worker.pid),
        "-o",
        "command=",
      ]).catch(() => null);
      if (command?.stdout.toString().includes(needle)) {
        process.kill(worker.pid, "SIGINT");
        for (let n = 0; n < 80; n++) {
          const current = await run("/bin/ps", [
            "-p",
            String(worker.pid),
            "-o",
            "command=",
          ]).catch(() => null);
          if (!current?.stdout.toString().includes(needle)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const still = await run("/bin/ps", [
          "-p",
          String(worker.pid),
          "-o",
          "command=",
        ]).catch(() => null);
        if (still?.stdout.toString().includes(needle)) {
          process.kill(worker.pid, "SIGKILL");
          await new Promise((r) => setTimeout(r, 100));
          const remaining = await run("/bin/ps", [
            "-p",
            String(worker.pid),
            "-o",
            "command=",
          ]).catch(() => null);
          if (remaining?.stdout.toString().includes(needle))
            fail(
              "cleanup-required",
              "Owned recorder is still exiting. Retry release.",
              409,
            );
        }
      }
    }
    this.store.clearWorker(worker.id);
  }
  private async recover() {
    for (const worker of this.store.workers()) {
      try {
        await this.cleanWorker(worker);
      } catch (e) {
        this.diagnostics.push(
          `Recorder recovery requires attention: ${(e as Error).message}`,
        );
      }
    }
    for (const a of this.store
      .artifacts()
      .filter((a) => ["recording", "finalizing"].includes(a.status))) {
      a.status = "interrupted";
      a.error = "Service restarted before capture finalized.";
      this.store.putArtifact(a);
      await this.manifest(a).catch(() => {});
    }
    for (const s of this.store.sessions().filter((s) => s.state !== "closed")) {
      const pending = this.store
        .workers()
        .some((w) => this.store.artifact(w.id).sessionId === s.id);
      s.state = pending ? "closing" : "closed";
      s.endedAt = pending ? undefined : Date.now();
      s.closeReason = pending
        ? "Recorder cleanup requires attention. Connect the device and retry release."
        : "Service restarted";
      this.store.putSession(s);
      this.store.event({
        deviceId: s.deviceId,
        sessionId: s.id,
        owner: s.owner,
        action: pending ? "cleanup-required" : "released",
        detail: s.closeReason,
      });
    }
    for (const group of this.store.groups().filter((group) => group.state !== "closed")) {
      try {
        await this.closeReservationGroup(group.id, "Service restarted");
      } catch (error) {
        this.diagnostics.push(
          `Reservation group ${group.id} cleanup requires attention: ${(error as Error).message}`,
        );
      }
    }
  }
  async close() {
    this.licensing.close();
    this.shuttingDown = true;
    clearInterval(this.timer);
    await Promise.all(
      this.store
        .groups()
        .filter((group) => group.state !== "closed")
        .map((group) => this.closeReservationGroup(group.id, "Service stopped")),
    );
    await Promise.all(
      this.store
        .sessions()
        .filter((s) => s.state !== "closed")
        .map((s) => this.closeSession(s.id, "Service stopped")),
    );
    await Promise.all(
      [...this.simulatorActions.keys()].map((id) =>
        this.queue(id).run(async () => {}),
      ),
    );
    await this.streams.close();
    await Promise.all([this.captureCardThumbnails.close(), this.capture.close()]);
    await this.adapters.close();
    await Promise.all([this.healthCache.close(), this.sourceCache.close()]);
    await this.thumbnails.close();
    this.store.close();
  }
}
