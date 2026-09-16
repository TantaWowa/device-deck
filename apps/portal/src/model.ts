import { machinesResponseSchema, type MachineRecord } from "../../../packages/core/src/hub";

export type Observation = {
  state: "checking" | "reachable" | "unreachable" | "standalone";
  checkedAt?: string;
  detail?: string;
};
export type MachineCache = { machines: MachineRecord[]; savedAt: string };
export const cachePrefix = "device-deck-hub-machines:";

export function cacheKey(uid: string) { return `${cachePrefix}${encodeURIComponent(uid)}`; }

export function readMachineCache(storage: Pick<Storage, "getItem">, uid: string): MachineCache | undefined {
  try {
    const cached = JSON.parse(storage.getItem(cacheKey(uid)) || "null");
    if (!cached || typeof cached.savedAt !== "string" || !Number.isFinite(Date.parse(cached.savedAt))) return;
    const { machines } = machinesResponseSchema.parse(cached);
    return { machines, savedAt: cached.savedAt };
  } catch { return; }
}

export function writeMachineCache(storage: Pick<Storage, "setItem">, uid: string, machines: MachineRecord[], now = new Date()) {
  // Deliberately project metadata: grants, pairing codes and tokens are never cached.
  const safe = machinesResponseSchema.parse({ machines }).machines;
  const data = { machines: safe, savedAt: now.toISOString() };
  try { storage.setItem(cacheKey(uid), JSON.stringify(data)); } catch { /* Storage may be disabled. */ }
  return data.savedAt;
}

export function clearMachineCache(storage: Pick<Storage, "removeItem">, uid: string) {
  try { storage.removeItem(cacheKey(uid)); } catch { /* Signing out must still work. */ }
}

export function observationLabel(value: Observation | undefined, now = Date.now()) {
  if (!value) return "Not checked";
  if (value.state === "checking") return "Checking from this browser";
  if (value.state === "standalone") return "Open standalone";
  if (!value.checkedAt || now - Date.parse(value.checkedAt) > 45_000) return "Check needed";
  return value.state === "reachable" ? "Reachable from this browser" : "Not reachable from this browser";
}

export function endpointInput(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function needsStandalone(endpoint: string, pageProtocol = "https:") {
  return pageProtocol === "https:" && new URL(endpoint).protocol === "http:";
}

export function connectionMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "Connection cancelled.";
  if (error instanceof Error && error.name === "TimeoutError") return "The machine did not respond. Check that Device Deck is running and both devices share a network or VPN connection.";
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|load failed/i.test(error.message)))
    return "This browser could not connect. Use trusted HTTPS, check your network or VPN connection, and allow Local Network access if prompted. Open the machine address to check its certificate.";
  return error instanceof Error ? error.message : "The machine could not be reached.";
}

/** No queue: a second control press is dropped while the current command runs. */
export class ControlGate {
  private active = false;
  private generation = 0;
  private controller = new AbortController();
  cancel() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.active = false;
  }
  async run<T>(action: (signal: AbortSignal, stillCurrent: () => boolean) => Promise<T>): Promise<T | undefined> {
    if (this.active) return;
    this.active = true;
    const generation = this.generation;
    const signal = this.controller.signal;
    try { return await action(signal, () => generation === this.generation && !signal.aborted); }
    finally { if (generation === this.generation) this.active = false; }
  }
}
