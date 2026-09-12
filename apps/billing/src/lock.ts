import { readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  created: z.string(),
});
export function acquireWorkerLock(directory: string) {
  const file = path.join(directory, "worker.lock"),
    temporary = path.join(directory, `.worker-${randomUUID()}`);
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    created: new Date().toISOString(),
  };
  writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "A billing worker lock exists. Stop the owner, then run npm run billing:recover-lock -- <billing-home>. Recovery refuses a live PID.",
      );
    throw e;
  } finally {
    unlinkSync(temporary);
  }
  return () => {
    if (
      ownerSchema.parse(JSON.parse(readFileSync(file, "utf8"))).token ===
      owner.token
    )
      unlinkSync(file);
  };
}
export function recoverWorkerLock(directory: string) {
  const file = path.join(directory, "worker.lock"),
    claim = path.join(directory, "worker.recovery");
  // Only one operator recovery may inspect/remove an old owner at a time.
  linkSync(file, claim);
  try {
    const owner = ownerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      // No automatic deletion during startup. This operator-invoked path removes
      // one complete dead-owner record, and never signals an unrelated process.
      if (readFileSync(file, "utf8") !== JSON.stringify(owner))
        throw new Error("Worker lock changed; inspect it before recovery");
      unlinkSync(file);
      return;
    }
    throw new Error(`Refusing recovery while worker PID ${owner.pid} is alive`);
  } finally {
    unlinkSync(claim);
  }
}
