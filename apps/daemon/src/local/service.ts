import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, stat, rm, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  ConfigStore,
  SerialQueue,
  sourceIdentity,
  atomicWrite,
} from "../../../../packages/config/src";
import { Adapters } from "../../../../packages/adapters/src";
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
  fail,
  type Config,
  type Device,
  type Session,
  type Artifact,
  type Operation,
  type Snapshot,
  type SourceConfig,
} from "../../../../packages/core/src/local/types";
import { Store } from "./store";
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
  private health: Device[] = [];
  private healthAt = 0;
  private healthPending?: Promise<Device[]>;
  private timer?: ReturnType<typeof setInterval>;
  private shuttingDown = false;
  private changingConfig = false;
  diagnostics: string[] = [];
  constructor(
    readonly directory: string,
    configFile = path.join(directory, "config.json"),
    adapters?: Adapters,
    capture?: CaptureEngine,
  ) {
    this.config = new ConfigStore(configFile);
    this.adapters = adapters || new Adapters(() => this.config.config);
    this.capture = capture || new CaptureEngine(this.adapters);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.config.load();
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
  private validateChange = (next: Config) => {
    const active = this.store.sessions().filter((s) => s.state !== "closed");
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
      active.length &&
      JSON.stringify(next.tools) !== JSON.stringify(this.config.config.tools)
    )
      fail(
        "device-busy",
        "Release sessions before changing adapter executables.",
        409,
      );
  };
  private async refresh() {
    await this.global.run(async () => {
      if (await this.config.refresh(this.prepareConfig)) this.healthAt = 0;
      this.changingConfig = false;
    });
  }
  private prepareConfig = async (next: Config) => {
    this.validateChange(next);
    this.changingConfig = true;
    const active = this.store.sessions().filter((s) => s.state !== "closed");
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
        else await this.capture.closeSource(source);
      }
    } catch (e) {
      this.changingConfig = false;
      throw e;
    }
  };
  async devices(force = false): Promise<Device[]> {
    if (!force && Date.now() - this.healthAt < 4000)
      return this.decorate(this.health);
    if (!this.healthPending) {
      this.healthPending = Promise.all(
        this.config.config.devices.map((d) => this.adapters.inspect(d)),
      )
        .then((ds) => {
          this.health = ds;
          this.healthAt = Date.now();
          return this.decorate(ds);
        })
        .finally(() => {
          this.healthPending = undefined;
        });
    }
    return this.healthPending;
  }
  private decorate(ds: Device[]) {
    return ds.map((d) => ({
      ...d,
      locked: !!this.store.lockReason(d.id),
      lockReason: this.store.lockReason(d.id),
    }));
  }
  async snapshot(): Promise<Snapshot> {
    await this.refresh();
    const [devices, sources] = await Promise.all([
      this.devices(),
      this.adapters.inspectSources(this.config.config.sources),
    ]);
    for (const d of devices) {
      const source = sources.find((s) => s.id === d.captureSourceId);
      if (!source || source.status === "missing")
        d.capabilities = d.capabilities.filter(
          (c) => !["preview", "screenshot", "record"].includes(c),
        );
      if (source?.kind === "native" && !d.online) source.status = "missing";
    }
    return {
      mode: "local",
      devices,
      sources,
      sessions: this.store.sessions(),
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
  ): Promise<unknown> {
    if (this.shuttingDown)
      fail("service-stopping", "Service is stopping.", 503);
    const args = operations[operation]?.parse(value) as any;
    if (!args) fail("unknown-operation", "Unknown operation.", 404);
    switch (operation) {
      case "inventory":
        return this.snapshot();
      case "discover":
        return this.adapters.discover();
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
          this.healthAt = 0;
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
          const d = matches[0];
          if (!d.online) fail("device-offline", d.healthDetail, 409);
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
      case "sessions.renew": {
        const s = this.store.validate(args.sessionId, args.leaseToken);
        s.expiresAt =
          Date.now() +
          (args.ttlMinutes || this.config.config.settings.ttl) * 60000;
        this.store.putSession(s);
        return s;
      }
      case "sessions.release": {
        const s = this.store.validate(args.sessionId, args.leaseToken, true);
        return this.closeSession(s.id, "Released");
      }
      case "sessions.takeover": {
        this.device(args.deviceId);
        const active = this.store
          .sessions()
          .find((s) => s.deviceId === args.deviceId && s.state !== "closed");
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
      case "devices.bulk":
        return Promise.all(
          [...new Set<string>(args.ids)].map((id) =>
            this.queue(id).run(async () => {
              try {
                const d = this.device(id);
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
                // A maintenance lock is established synchronously before any restart awaits.
                if (args.action === "restart") {
                  const previous = this.store.lockReason(id);
                  this.store.lock(id, "Restart in progress");
                  try {
                    await this.adapters.restart(d);
                  } finally {
                    this.store.lock(id, previous || null);
                    this.healthAt = 0;
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
            this.healthAt = 0;
            return { paired: true };
          } finally {
            clearTimeout(timeout);
          }
        });
      case "remote.input":
        return this.withLease(args, async (s) => {
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
            job = this.jobs.get(s.id);
          await this.adapters.input(this.device(s.deviceId), args);
          const key =
            args.key ||
            (args.text !== undefined
              ? `Text: ${args.text}`
              : `Tap ${args.x}, ${args.y}`);
          const inputValue = {
            at,
            sessionId: s.id,
            deviceId: s.deviceId,
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
        });
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
  async preview(deviceId: string) {
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
      return this.capture.preview(
        d,
        source,
        this.config.config.settings.previewIntervalMs,
      );
    });
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
          this.store.worker(a.id, { ...worker, path: a.path, device: d }),
      );
      a.createdAt = handle.startedAt;
      this.store.worker(a.id, {
        pid: handle.pid,
        path: a.path,
        device: d,
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
          if (current.state === "active") {
            current.state = "closing";
            current.closeReason = error;
            this.store.putSession(current);
          }
          void this.closeSession(s.id, error, true).catch((e) =>
            this.diagnostics.push(String(e)),
          );
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
        void this.closeSession(
          sessionId,
          a.error || "Recorder interrupted",
          true,
        ).catch((e) => this.diagnostics.push(String(e)));
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
    const closing = this.queue(s.deviceId)
      .run(async () => {
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
    await Promise.all(
      this.store
        .sessions()
        .filter((s) => s.state === "active" && s.expiresAt <= Date.now())
        .map((s) => this.closeSession(s.id, "Reservation expired")),
    );
  }
  private async cleanWorker(worker: any) {
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
  }
  async close() {
    this.shuttingDown = true;
    clearInterval(this.timer);
    await Promise.all(
      this.store
        .sessions()
        .filter((s) => s.state !== "closed")
        .map((s) => this.closeSession(s.id, "Service stopped")),
    );
    await this.capture.close();
    this.store.close();
  }
}
