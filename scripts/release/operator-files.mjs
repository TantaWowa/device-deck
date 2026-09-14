import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function writePrivateFile(file, data) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}
export function isFutureExpiry(value, now = Date.now()) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
}
export function environmentCreationBody(mode) {
  return { deployment_branch_policy: mode === "live" ? { protected_branches: false, custom_branch_policies: true } : null };
}
