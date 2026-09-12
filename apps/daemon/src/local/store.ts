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
  type Event,
  type Input,
  type Artifact,
  fail,
} from "../../../../packages/core/src/local/types";
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
type LeaseRow = { payload: string; token_hash: string };
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
  reports() {
    const sessions = this.sessions(),
      events = this.events(),
      artifacts = this.artifacts();
    const byDevice = new Map<string, number>();
    for (const s of sessions) {
      const ms = Math.max(
        0,
        Math.min(s.endedAt || Date.now(), s.expiresAt) - s.createdAt,
      );
      byDevice.set(s.deviceId, (byDevice.get(s.deviceId) || 0) + ms);
    }
    return {
      sessions: sessions.length,
      reservedMs: [...byDevice.values()].reduce((a, b) => a + b, 0),
      contentions: Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS count FROM events WHERE json_extract(payload, '$.action') = 'contention'",
            )
            .get() as { count: number }
        ).count,
      ),
      captureAttempts: artifacts.length,
      captureFailures: artifacts.filter(
        (a) => a.status === "failed" || a.status === "interrupted",
      ).length,
      byDevice: [...byDevice].map(([deviceId, reservedMs]) => ({
        deviceId,
        reservedMs,
      })),
    };
  }
  close() {
    this.db.close();
  }
}
