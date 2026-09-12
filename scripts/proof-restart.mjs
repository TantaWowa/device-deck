import { readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
const directory = process.env.DEVICE_DECK_HOME;
if (!directory?.endsWith("/work/proof-home"))
  throw new Error("Use the isolated proof home.");
let ep = JSON.parse(
  await readFile(path.join(directory, "endpoint.json"), "utf8"),
);
const api = async (op, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${ep.port}/v1/operations/${op}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.message);
  return body;
};
const r = await api("sessions.reserve", {
  selector: { device: "proof-tvos" },
  owner: "Crash recovery proof",
  reason: "Verify interrupted recorder recovery",
});
const lease = { sessionId: r.session.id, leaseToken: r.leaseToken };
const capture = await api("recordings.start", lease);
await new Promise((r) => setTimeout(r, 1500));
process.kill(ep.pid, "SIGKILL");
await new Promise((r) => setTimeout(r, 500));
const log = openSync(path.join(directory, "restart-proof.log"), "a", 0o600);
const daemon = spawn(process.execPath, ["build/daemon.mjs"], {
  env: process.env,
  detached: true,
  stdio: ["ignore", log, log],
});
daemon.unref();
closeSync(log);
let snapshot;
for (let i = 0; i < 200; i++) {
  try {
    ep = JSON.parse(
      await readFile(path.join(directory, "endpoint.json"), "utf8"),
    );
    snapshot = await api("inventory");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}
if (!snapshot) throw new Error("Restarted daemon did not become ready");
const artifact = snapshot.artifacts.find((a) => a.id === capture.id),
  session = snapshot.sessions.find((s) => s.id === lease.sessionId);
if (artifact.status !== "interrupted" || session.state !== "closed")
  throw new Error(JSON.stringify({ artifact, session }));
try {
  await api("remote.input", { ...lease, key: "Home" });
  throw new Error("Stale lease accepted");
} catch (e) {
  if (!e.message.includes("expired or closed")) throw e;
}
const next = await api("sessions.reserve", {
  selector: { device: "proof-tvos" },
  owner: "After restart",
  reason: "Confirm cleaned source is reusable",
});
await api("sessions.release", {
  sessionId: next.session.id,
  leaseToken: next.leaseToken,
});
await writeFile(
  "work/restart-proof-result.json",
  JSON.stringify(
    { artifact, session, staleLeaseRejected: true, sourceReacquired: true },
    null,
    2,
  ),
);
console.log(
  "Real daemon crash, owned-recorder cleanup, interrupted status, stale credential rejection and reacquisition passed.",
);
