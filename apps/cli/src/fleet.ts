import { callOperation } from "../../../packages/core/src/client";
import { deckListSchema } from "../../../packages/core/src/decks";
import { canLaunchSimulator, matchDevices, type DeviceCleanupResult, type Selector, type Snapshot } from "../../../packages/core/src/local/types";
import { decksCommand } from "./decks";

export async function fleetCommand(command: "health" | "reset-apps", deck: string, fleet: boolean, selector: Selector, confirmed: boolean) {
  const decks = fleet ? ["local", ...deckListSchema.parse(await decksCommand("list", undefined, {})).decks.map(d => d.name)] : [deck];
  return Promise.all(decks.map(async name => {
    try {
      if (command === "health") return { deck: name, devices: await callOperation("fleet.health", {}, "CLI", undefined, name) };
      const inventory: Snapshot = await callOperation("inventory", {}, "CLI", undefined, name);
      const devices = matchDevices(inventory.devices, inventory.sessions, selector);
      const held = new Set(inventory.sessions.filter(s => s.state !== "closed").map(s => s.deviceId));
      for (const group of inventory.reservationGroups ?? [])
        if (group.state !== "closed") for (const member of group.members) held.add(member.deviceId);
      const skipped: { id: string; name: string; reason: string }[] = [];
      const ids: string[] = [];
      for (const d of devices) {
        const reason = d.kind === "physical" ? "physical device" : !canLaunchSimulator(d) ? "unsupported device"
          : held.has(d.id) ? "reserved" : d.locked ? "maintenance lock" : undefined;
        if (reason) skipped.push({ id: d.id, name: d.name, reason });
        else ids.push(d.id);
      }
      const results: DeviceCleanupResult[] = [];
      if (confirmed) {
        for (let i = 0; i < ids.length; i += 100) {
          const batch: DeviceCleanupResult[] = await callOperation("devices.cleanup", {
            ids: ids.slice(i, i + 100), action: "uninstall-apps", confirmed: true, revision: inventory.configRevision,
          }, "CLI", undefined, name);
          results.push(...batch);
        }
      }
      return { deck: name, ok: results.every(row => row.ok), preview: !confirmed, selected: ids, skipped, results };
    } catch (error) {
      return { deck: name, ok: false, error: (error as Error).message };
    }
  }));
}
