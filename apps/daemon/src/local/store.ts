import {
  aggregateReport,
  resolveReportRange,
  type ReportRequest,
} from "../../../../packages/core/src/reports";
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync } from "node:fs";
import {
  type Session,
  type DeviceConfig,
  type Event,
  type Input,
  type Artifact,
  type ReservationGroup,
  type SimulatorLaunchOwnership,
  fail,
} from "../../../../packages/core/src/local/types";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
type LeaseRow = { payload: string; token_hash: string };
type OwnedInteraction = { sessionId: string; device: DeviceConfig; wdaSessionId: string };
export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, source_key TEXT, state TEXT NOT NULL, token_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS device_exclusive ON sessions(device_id) WHERE state != 'closed';
      CREATE UNIQUE INDEX IF NOT EXISTS source_exclusive ON sessions(source_key) WHERE state != 'closed' AND source_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS locks(device_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, recording_id TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(artifact_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interaction_ownership(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservation_groups(id TEXT PRIMARY KEY, state TEXT NOT NULL, token_hash TEXT NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(action: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  sessions() {
    return (
      this.db.prepare("SELECT payload FROM sessions").all() as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as Session);
  }
  ownedInteractions() {
    return (this.db.prepare("SELECT payload FROM interaction_ownership").all() as { payload: string }[]).map((row) => JSON.parse(row.payload) as OwnedInteraction);
  }
  putOwnedInteraction(value: OwnedInteraction) {
    this.db.prepare("INSERT OR REPLACE INTO interaction_ownership VALUES (?,?)").run(value.sessionId, JSON.stringify(value));
  }
  clearOwnedInteraction(sessionId: string) {
    this.db.prepare("DELETE FROM interaction_ownership WHERE session_id=?").run(sessionId);
  }
  session(id: string) {
    const row = this.db
      .prepare("SELECT payload FROM sessions WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row) fail("session-not-found", "Session not found.", 404);
    return JSON.parse(row.payload) as Session;
  }
  validate(id: string, token: string, allowClosed = false) {
    const row = this.db
      .prepare("SELECT payload,token_hash FROM sessions WHERE id=?")
      .get(id) as LeaseRow | undefined;
    if (
      !row ||
      !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(token)))
    )
      fail("invalid-lease", "The credential does not own this session.", 403);
    const session = JSON.parse(row.payload) as Session;
    if (
      !allowClosed &&
      (session.state !== "active" || session.expiresAt <= Date.now())
    )
      fail(
        "stale-lease",
        "This reservation is expired or closed. Reserve the device again.",
        409,
      );
    return session;
  }
  reserve(
    deviceId: string,
    sourceId: string | null,
    sourceKey: string | null,
    owner: string,
    reason: string,
    ttlMinutes: number,
    maxSessions = Infinity,
  ) {
    return this.transaction(() => {
      if (this.lockReason(deviceId))
        fail("device-locked", "Device is locked for maintenance.", 409);
      const active = this.sessions().filter((s) => s.state !== "closed");
      if (active.some((s) => s.deviceId === deviceId))
        fail(
          "device-reserved",
          "Device is already reserved.",
          409,
          active.find((s) => s.deviceId === deviceId),
        );
      if (
        sourceKey &&
        this.db
          .prepare(
            "SELECT id FROM sessions WHERE source_key=? AND state != 'closed'",
          )
          .get(sourceKey)
      )
        fail(
          "source-reserved",
          "Capture source is in use by another session.",
          409,
        );
      if (active.length >= maxSessions)
        fail(
          "session-limit",
          "The configured session limit has been reached.",
          403,
        );
      const session: Session = {
        id: randomUUID(),
        deviceId,
        sourceId,
        owner,
        reason,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMinutes * 60000,
        state: "active",
      };
      const leaseToken = randomBytes(32).toString("base64url");
      this.db
        .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)")
        .run(
          session.id,
          deviceId,
          sourceKey,
          session.state,
          hash(leaseToken),
          JSON.stringify(session),
        );
      this.event({
        deviceId,
        sessionId: session.id,
        owner,
        action: "reserved",
        detail: reason,
      });
      return { session, leaseToken };
    });
  }
  reserveGroup(
    id: string,
    members: {
      alias: string;
      deviceId: string;
      sourceId: string | null;
      sourceKey: string | null;
    }[],
    owner: string,
    reason: string,
    requestHash: string,
    ttlMinutes: number,
    leaseToken: string,
    maxSessions = Infinity,
  ) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM reservation_groups WHERE id=?").get(id))
        fail(
          "group-exists",
          "A reservation group with this ID already exists. Release it or use a unique run attempt ID.",
          409,
        );
      const active = this.sessions().filter((session) => session.state !== "closed");
      if (active.length + members.length > maxSessions)
        fail(
          "session-limit",
          `This reservation group needs ${members.length} concurrent device sessions, but the configured limit permits ${maxSessions}.`,
          403,
        );
      const requestedDevices = new Set<string>();
      const requestedSources = new Set<string>();
      for (const member of members) {
        if (requestedDevices.has(member.deviceId))
          fail("group-conflict", "A reservation group cannot assign one device to multiple requests.", 409);
        requestedDevices.add(member.deviceId);
        if (this.lockReason(member.deviceId))
          fail("device-locked", `Device ${member.deviceId} is locked for maintenance.`, 409);
        if (active.some((session) => session.deviceId === member.deviceId))
          fail("device-reserved", `Device ${member.deviceId} is already reserved.`, 409);
        if (member.sourceKey) {
          if (requestedSources.has(member.sourceKey))
            fail("source-reserved", "Two requested devices share one capture source.", 409);
          requestedSources.add(member.sourceKey);
          if (
            this.db
              .prepare("SELECT id FROM sessions WHERE source_key=? AND state != 'closed'")
              .get(member.sourceKey)
          )
            fail("source-reserved", "A requested capture source is in use by another session.", 409);
        }
      }
      const createdAt = Date.now();
      const expiresAt = createdAt + ttlMinutes * 60000;
      const tokenHash = hash(leaseToken);
      const sessions = members.map((member) => {
        const session: Session = {
          id: randomUUID(),
          deviceId: member.deviceId,
          sourceId: member.sourceId,
          owner,
          reason,
          createdAt,
          expiresAt,
          state: "active",
          groupId: id,
          groupAlias: member.alias,
        };
        this.db
          .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)")
          .run(
            session.id,
            session.deviceId,
            member.sourceKey,
            session.state,
            tokenHash,
            JSON.stringify(session),
          );
        this.event({
          deviceId: session.deviceId,
          sessionId: session.id,
          owner,
          action: "reserved",
          detail: `${reason} (group ${id}, ${member.alias})`,
        });
        return session;
      });
      const group: ReservationGroup = {
        id,
        owner,
        reason,
        requestHash,
        createdAt,
        expiresAt,
        state: "preparing",
        members: sessions.map((session) => ({
          alias: session.groupAlias!,
          sessionId: session.id,
          deviceId: session.deviceId,
          startedByGroup: false,
        })),
      };
      this.db
        .prepare("INSERT INTO reservation_groups VALUES (?,?,?,?)")
        .run(group.id, group.state, tokenHash, JSON.stringify(group));
      return { group, sessions, leaseToken };
    });
  }
  groups() {
    return (
      this.db.prepare("SELECT payload FROM reservation_groups").all() as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ReservationGroup);
  }
  group(id: string) {
    const row = this.db
      .prepare("SELECT payload FROM reservation_groups WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row) fail("group-not-found", "Reservation group not found.", 404);
    return JSON.parse(row.payload) as ReservationGroup;
  }
  validateGroup(id: string, token: string, allowClosed = false) {
    const row = this.db
      .prepare("SELECT payload,token_hash FROM reservation_groups WHERE id=?")
      .get(id) as LeaseRow | undefined;
    if (!row)
      fail("group-not-found", "Reservation group not found.", 404);
    if (!timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(token))))
      fail("invalid-lease", "The credential does not own this reservation group.", 403);
    const group = JSON.parse(row.payload) as ReservationGroup;
    if (
      !allowClosed &&
      (group.state !== "active" || group.expiresAt <= Date.now())
    )
      fail("stale-lease", "This reservation group is expired, closed, or not ready.", 409);
    return group;
  }
  putGroup(group: ReservationGroup) {
    this.db
      .prepare("UPDATE reservation_groups SET state=?,payload=? WHERE id=?")
      .run(group.state, JSON.stringify(group), group.id);
  }
  setGroupMemberStarted(
    id: string,
    alias: string,
    startedByGroup: boolean,
    simulatorLaunch?: SimulatorLaunchOwnership,
  ) {
    return this.transaction(() => {
      const group = this.group(id);
      const member = group.members.find((item) => item.alias === alias);
      if (!member)
        fail("group-member-not-found", "Reservation group member not found.", 404);
      member.startedByGroup = startedByGroup;
      if (startedByGroup && simulatorLaunch)
        member.simulatorLaunch = simulatorLaunch;
      if (!startedByGroup) delete member.simulatorLaunch;
      this.putGroup(group);
      return group;
    });
  }
  renewGroup(
    id: string,
    token: string,
    expiresAt: number,
    authorize: (session: Session) => void,
  ) {
    return this.transaction(() => {
      const group = this.validateGroup(id, token);
      const sessions = group.members.map((member) => this.session(member.sessionId));
      for (const session of sessions) {
        if (session.state !== "active")
          fail("stale-lease", "A member of this reservation group is no longer active.", 409);
        authorize(session);
      }
      for (const session of sessions) {
        session.expiresAt = expiresAt;
        this.putSession(session);
      }
      group.expiresAt = expiresAt;
      this.putGroup(group);
      return group;
    });
  }
  finalizeGroup(group: ReservationGroup, cleanupLockReason: string) {
    return this.transaction(() => {
      for (const member of group.members)
        this.db
          .prepare("DELETE FROM locks WHERE device_id=? AND reason=?")
          .run(member.deviceId, cleanupLockReason);
      this.putGroup(group);
      return group;
    });
  }
  putSession(s: Session) {
    this.db
      .prepare("UPDATE sessions SET state=?,payload=? WHERE id=?")
      .run(s.state, JSON.stringify(s), s.id);
  }
  lockReason(id: string) {
    return (
      this.db.prepare("SELECT reason FROM locks WHERE device_id=?").get(id) as
        { reason: string } | undefined
    )?.reason;
  }
  lock(id: string, reason: string | null) {
    if (reason === null)
      this.db.prepare("DELETE FROM locks WHERE device_id=?").run(id);
    else
      this.db
        .prepare("INSERT OR REPLACE INTO locks VALUES (?,?)")
        .run(id, reason);
  }
  event(value: Omit<Event, "id" | "at">) {
    const event = { at: Date.now(), ...value };
    const row = this.db
      .prepare("INSERT INTO events(payload) VALUES (?)")
      .run(JSON.stringify(event));
    return { ...event, id: Number(row.lastInsertRowid) };
  }
  events() {
    return (
      this.db
        .prepare("SELECT id,payload FROM events ORDER BY id DESC LIMIT 2000")
        .all() as { id: number; payload: string }[]
    ).map((r) => ({ ...JSON.parse(r.payload), id: r.id }) as Event);
  }
  input(value: Omit<Input, "id">) {
    const row = this.db
      .prepare(
        "INSERT INTO inputs(session_id,recording_id,payload) VALUES (?,?,?)",
      )
      .run(value.sessionId, value.recordingId, JSON.stringify(value));
    return { ...value, id: Number(row.lastInsertRowid) };
  }
  inputs(sessionId?: string) {
    const rows = (
      sessionId
        ? this.db
            .prepare(
              "SELECT id,payload FROM inputs WHERE session_id=? ORDER BY id",
            )
            .all(sessionId)
        : this.db
            .prepare(
              "SELECT id,payload FROM inputs ORDER BY id DESC LIMIT 2000",
            )
            .all()
    ) as { id: number; payload: string }[];
    const inputs = rows.map(
      (r) => ({ ...JSON.parse(r.payload), id: r.id }) as Input,
    );
    return sessionId ? inputs : inputs.reverse();
  }
  artifacts() {
    return (
      this.db
        .prepare("SELECT payload FROM artifacts ORDER BY rowid DESC")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as Artifact);
  }
  artifact(id: string) {
    const row = this.db
      .prepare("SELECT payload FROM artifacts WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row) fail("artifact-not-found", "Capture not found.", 404);
    return JSON.parse(row.payload) as Artifact;
  }
  putArtifact(a: Artifact) {
    this.db
      .prepare(
        "INSERT INTO artifacts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(a.id, a.sessionId, JSON.stringify(a));
  }
  worker(id: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO workers VALUES (?,?)")
      .run(id, JSON.stringify(value));
  }
  clearWorker(id: string) {
    this.db.prepare("DELETE FROM workers WHERE artifact_id=?").run(id);
  }
  workers() {
    return (
      this.db.prepare("SELECT artifact_id,payload FROM workers").all() as {
        artifact_id: string;
        payload: string;
      }[]
    ).map((r) => ({ id: r.artifact_id, ...JSON.parse(r.payload) }));
  }
  reports(request: ReportRequest = {}, now = Date.now()) {
    const range = resolveReportRange(request, now);
    const contentions = this.db
      .prepare(
        "SELECT json_extract(payload, '$.deviceId') AS deviceId,json_extract(payload, '$.at') AS at FROM events WHERE json_extract(payload, '$.action') = 'contention' AND json_extract(payload, '$.at') >= ? AND json_extract(payload, '$.at') < ?",
      )
      .all(range.startMs, range.endMs) as { deviceId: string; at: number }[];
    return aggregateReport(
      range,
      this.sessions(),
      this.artifacts(),
      contentions,
    );
  }
  close() {
    this.db.close();
  }
}
