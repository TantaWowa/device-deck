import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  created: z.string(),
  version: z.literal(2).optional(),
});
// Keep the OS lock alive even if a caller temporarily drops its release callback.
const heldLocks = new Set<DatabaseSync>();
function exclusive(directory: string) {
  const file = path.join(directory, "worker-owner.sqlite"),
    db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  try {
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE",
    );
    return db;
  } catch {
    db.close();
    throw new Error(
      "A billing worker lock exists and is held by a live worker; recovery refuses an alive owner",
    );
  }
}
export function acquireWorkerLock(directory: string) {
  // A dedicated SQLite transaction supplies an OS advisory lock across processes
  // and container PID namespaces. The OS releases it after a crash.
  const db = exclusive(directory),
    file = path.join(directory, "worker.lock"),
    temporary = path.join(directory, `.worker-${randomUUID()}`);
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    created: new Date().toISOString(),
    version: 2 as const,
  };
  try {
    if (
      existsSync(file) &&
      !ownerSchema.parse(JSON.parse(readFileSync(file, "utf8"))).version
    )
      throw new Error(
        "A legacy billing worker lock exists. Stop its owner and run billing:recover-lock before upgrading",
      );
    writeFileSync(temporary, JSON.stringify(owner), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
  } catch (e) {
    if (existsSync(temporary)) unlinkSync(temporary);
    db.close();
    throw e;
  }
  heldLocks.add(db);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (
        existsSync(file) &&
        ownerSchema.parse(JSON.parse(readFileSync(file, "utf8"))).token ===
          owner.token
      )
        unlinkSync(file);
    } finally {
      heldLocks.delete(db);
      db.close();
    }
  };
}
export function recoverWorkerLock(directory: string) {
  const db = exclusive(directory),
    file = path.join(directory, "worker.lock");
  try {
    if (!existsSync(file)) return;
    const source = readFileSync(file, "utf8"),
      owner = ownerSchema.parse(JSON.parse(source));
    if (!owner.version) {
      // Older versions used only a PID file. Require the previous process to be
      // stopped; never signal it or remove an unrelated process's record.
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        if (readFileSync(file, "utf8") !== source)
          throw new Error("Worker lock changed; inspect before recovery");
        unlinkSync(file);
        return;
      }
      throw new Error(
        `Refusing recovery while worker PID ${owner.pid} is alive`,
      );
    }
    // Holding the exclusive lock proves no version-2 worker is using this home.
    unlinkSync(file);
  } finally {
    db.close();
  }
}
