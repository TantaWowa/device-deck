import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callOperation } from "../packages/core/src/client";
const exec = promisify(execFile);
const command = (args: string[]) =>
  exec(
    process.execPath,
    ["--import", "tsx", "apps/cli/src/index.ts", ...args],
    { env: process.env },
  );
const inventory = JSON.parse(
  (await command(["devices", "--platform", "apple", "--json"])).stdout,
);
if (inventory.length !== 2) throw new Error("Lowercase CLI selector failed.");
try {
  await command(["devices", "--platform", "invalid", "--json"]);
  throw new Error("Invalid platform accepted");
} catch (e) {
  if ((e as any).code !== 2) throw e;
}
const acquired = JSON.parse(
  (
    await command([
      "reserve",
      "--device",
      "Device Deck TV Proof",
      "--owner",
      "CLI proof",
      "--reason",
      "Native clipboard screenshot check",
      "--json",
    ])
  ).stdout,
);
const lease = {
  sessionId: acquired.session.id,
  leaseToken: acquired.leaseToken,
};
try {
  const args = ["--session", lease.sessionId, "--lease", lease.leaseToken];
  await command(["input", ...args, "--key", "Down"]);
  const image = JSON.parse(
    (await command(["screenshot", ...args, "--clipboard", "--json"])).stdout,
  );
  if (image.status !== "completed" || image.clipboardError)
    throw new Error(JSON.stringify(image));
  console.log(
    "CLI lowercase selector, invalid-selector exit code, real input and native clipboard screenshot passed.",
  );
} finally {
  await callOperation("sessions.release", lease);
}
