import { DeckError } from "../../core/src/local/types";
import { run } from "./process";

// Newer idb_companion builds keep a dead HID connection after their simulator
// is shut down and booted again. Every later `idb ui ...` call then fails until
// that companion exits; describe, accessibility and screenshots keep working, so
// they cannot detect it. The error means nothing was delivered.
export const isStaleHidConnection = (message: string) => /dtuhidd connection .*(invalidated|interrupted)/i.test(message);
export type InputHealth = { available: true } | { available: false; reason: string; at: number };
export type IdbInputDeps = {
  execute: typeof run;
  listProcesses: () => Promise<{ pid: number; command: string }[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
// `ps -x` without `-a` lists only the current user's processes.
export const listUserProcesses = async () => (await run("/bin/ps", ["-x", "-o", "pid=,command="], 5000)).stdout.toString().split("\n")
  .map((line) => line.trim().match(/^(\d+)\s+(.+)$/)).filter((m) => m !== null).map((m) => ({ pid: Number(m![1]), command: m![2] }));
const defaults: IdbInputDeps = {
  execute: run,
  listProcesses: listUserProcesses,
  kill: (pid, signal) => process.kill(pid, signal),
  alive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};
/** True only for an idb_companion launched for exactly this UDID. */
export function isCompanionFor(command: string, udid: string) {
  const parts = command.trim().split(/\s+/);
  if (parts[0]?.split("/").at(-1) !== "idb_companion") return false;
  const index = parts.indexOf("--udid");
  return index >= 0 && parts[index + 1]?.toLowerCase() === udid.toLowerCase();
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class IdbInput {
  private readonly deps: IdbInputDeps;
  private readonly states = new Map<string, InputHealth>();
  private readonly recoveries = new Map<string, { generation: number; pending?: Promise<string | undefined> }>();
  constructor(deps: Partial<IdbInputDeps> = {}) { this.deps = { ...defaults, ...deps }; }
  health(udid: string): InputHealth { return this.states.get(udid.toLowerCase()) ?? { available: true }; }
  /** Forget a recorded failure, e.g. after the simulator is relaunched. */
  reset(udid: string) { this.states.delete(udid.toLowerCase()); }
  /** Run one `idb ui ...` input for `udid`, restarting its stale companion and retrying once. */
  async run(idb: string, args: string[], options: { timeout?: number; execute?: typeof run } = {}) {
    const index = args.indexOf("--udid"), udid = args[index + 1];
    if (index < 0 || !udid) throw new DeckError("invalid-input", "Simulator input must target one UDID.", 400);
    const execute = options.execute ?? this.deps.execute, key = udid.toLowerCase();
    const recovery = this.recoveries.get(key) ?? { generation: 0 };
    this.recoveries.set(key, recovery);
    const generation = recovery.generation;
    try {
      const result = await execute(idb, args, options.timeout);
      this.states.delete(key);
      return result;
    } catch (error) {
      if (!isStaleHidConnection(message(error))) throw error;
    }
    // Concurrent inputs that failed on the same dead companion share one restart.
    let restartError: string | undefined;
    if (recovery.pending) restartError = await recovery.pending;
    else if (recovery.generation === generation) {
      recovery.pending = this.restart(idb, udid, execute);
      try { restartError = await recovery.pending; } finally { recovery.pending = undefined; recovery.generation++; }
    }
    try {
      const result = await execute(idb, args, options.timeout);
      this.states.delete(key);
      return result;
    } catch (error) {
      if (!isStaleHidConnection(message(error))) throw error;
      const reason = `This simulator's idb_companion lost its HID connection. Device Deck restarted it and input still fails${restartError ? ` (restart failed: ${restartError})` : ""}. Shut down and relaunch the simulator through its reservation, and update idb_companion.`;
      this.states.set(key, { available: false, reason, at: this.deps.now() });
      throw new DeckError("input-unavailable", reason, 503, { cause: message(error) });
    }
  }
  /** Terminate only this UDID's companions, then drop idb's stored entry so the retry spawns a new one. */
  private async restart(idb: string, udid: string, execute: typeof run): Promise<string | undefined> {
    const problems: string[] = [];
    try {
      const pids = (await this.deps.listProcesses()).filter((p) => p.pid !== process.pid && isCompanionFor(p.command, udid)).map((p) => p.pid);
      for (const pid of pids) try { this.deps.kill(pid, "SIGTERM"); } catch {}
      for (let waited = 0; waited < 2000 && pids.some(this.deps.alive); waited += 100) await this.deps.sleep(100);
      const stubborn = pids.filter(this.deps.alive);
      for (const pid of stubborn) try { this.deps.kill(pid, "SIGKILL"); } catch {}
      if (stubborn.length) await this.deps.sleep(200);
      const survivors = pids.filter(this.deps.alive);
      if (survivors.length) problems.push(`idb_companion ${survivors.join(", ")} did not exit`);
    } catch (error) { problems.push(message(error)); }
    // `idb disconnect UDID` removes only this UDID from idb's companion set.
    try { await execute(idb, ["disconnect", udid], 10000); } catch (error) { problems.push(message(error)); }
    // The daemon log is the only record of a recovery that then succeeds.
    console.error(`Restarted idb_companion for simulator ${udid} after a stale HID connection${problems.length ? ` (${problems.join("; ")})` : ""}.`);
    return problems.length ? problems.join("; ") : undefined;
  }
}
/** Shared by every simulator input path so recovery and health are per UDID, process-wide. */
export const idbInput = new IdbInput();
