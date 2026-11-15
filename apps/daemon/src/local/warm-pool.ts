import type { WarmDevice, WarmPoolSettings } from "../../../../packages/core/src/local/types";

export type WarmPoolReason = "idle" | "pool limit" | "memory pressure" | "warm pool disabled";
/** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export type MemoryPressure = 1 | 2 | 4;
export type WarmPoolInput = {
  now: number;
  settings: WarmPoolSettings;
  entries: WarmDevice[];
  /** Every booted virtual device in the inventory, owned by the pool or not. */
  booted: string[];
  /** Devices known to be shut down or no longer configured. */
  gone: string[];
  /** Reserved, locked, viewed, or changing devices. These are never closed. */
  busy: string[];
  pressure: MemoryPressure;
};
/** A busy development Mac reports warning-level pressure for hours. At that
 * level only a device unused for this long is closed, so warm devices stay
 * quick to reuse; critical pressure closes one device per tick. */
export const WARNING_PRESSURE_IDLE_MS = 30 * 60_000;
export type WarmPoolDecision = {
  drop: string[];
  close: { deviceId: string; reason: WarmPoolReason }[];
};

/** Decide which warm-pool devices to shut down this tick, least recently used
 * first. Booted devices the pool does not own count toward `maxBooted` but are
 * never chosen. */
export function decideWarmPool(input: WarmPoolInput): WarmPoolDecision {
  const gone = new Set(input.gone), booted = new Set(input.booted), busy = new Set(input.busy);
  const drop = input.entries.filter((entry) => gone.has(entry.deviceId)).map((entry) => entry.deviceId);
  const candidates = input.entries
    .filter((entry) => !gone.has(entry.deviceId) && booted.has(entry.deviceId) && !busy.has(entry.deviceId))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.deviceId.localeCompare(b.deviceId));
  const close: WarmPoolDecision["close"] = [];
  const take = (reason: WarmPoolReason) => {
    const next = candidates.shift();
    if (next) close.push({ deviceId: next.deviceId, reason });
    return Boolean(next);
  };
  if (!input.settings.enabled) {
    while (take("warm pool disabled"));
    return { drop, close };
  }
  while (candidates[0] && input.now - candidates[0].lastUsedAt > input.settings.idleMinutes * 60_000)
    take("idle");
  let excess = booted.size - close.length - input.settings.maxBooted;
  while (excess-- > 0 && take("pool limit"));
  const pressure = input.settings.memoryPressure ? input.pressure : 1;
  if (pressure === 4 || (pressure === 2 && candidates[0] &&
    input.now - candidates[0].lastUsedAt > WARNING_PRESSURE_IDLE_MS)) take("memory pressure");
  return { drop, close };
}

/** Parse `sysctl -n kern.memorystatus_vm_pressure_level`; anything unexpected is normal. */
export function parseMemoryPressure(output: string): MemoryPressure {
  const level = Number(output.trim());
  return level === 4 ? 4 : level === 2 ? 2 : 1;
}
