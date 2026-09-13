import type { Device } from "../../../packages/core/src/local/types";
import { runWorkspace } from "./run";
import type { Acquired } from "./workspace";
export async function interactiveRemote(device: Device, acquired: Acquired) {
  await runWorkspace({ remoteId: device.id, acquired, remoteOnly: true });
}
