import { callOperation } from "../packages/core/src/client";
import { readFile, writeFile } from "node:fs/promises";
const { config, revision } = await callOperation("config.get");
const udid = (await readFile("work/proof-tv-udid.txt", "utf8")).trim();
if (!config.devices.some((d: any) => d.id === "proof-tvos")) {
  config.devices.push({
    id: "proof-tvos",
    name: "Device Deck TV Proof",
    platform: "Apple",
    kind: "virtual",
    model: "Apple TV 4K · tvOS 26.2",
    visibility: "local",
    connection: { type: "simulator", udid, os: "tvos" },
    captureSourceId: "proof-tv-screen",
  });
  config.sources.push({
    id: "proof-tv-screen",
    name: "TV proof native screen",
    kind: "native",
    deviceId: "proof-tvos",
  });
  await callOperation("config.save", { config, revision });
}
const results: any[] = [];
const leases: any[] = [];
try {
  for (const id of ["proof-ios", "proof-tvos"]) {
    const r = await callOperation("sessions.reserve", {
      selector: { device: id },
      owner: "Parallel proof",
      reason: "Independent iOS and tvOS recordings",
    });
    leases.push({ sessionId: r.session.id, leaseToken: r.leaseToken });
  }
  await Promise.all(leases.map((l) => callOperation("recordings.start", l)));
  console.log("Both native recorders are active.");
  await callOperation("remote.input", { ...leases[1], key: "Right" });
  await callOperation("remote.input", { ...leases[1], key: "OK" });
  await callOperation("remote.input", { ...leases[0], key: "Home" });
  await new Promise((r) => setTimeout(r, 1500));
  for (const l of leases)
    results.push(await callOperation("captures.screenshot", l));
  const clips = await Promise.all(
    leases.map((l) => callOperation("recordings.stop", l)),
  );
  results.push(...clips);
  if (clips.some((c) => c.status !== "completed" || c.duration < 1))
    throw new Error(JSON.stringify(clips));
  await writeFile(
    "work/parallel-proof-result.json",
    JSON.stringify(results, null, 2),
  );
  console.log(
    clips.map((c) => ({
      device: c.deviceId,
      status: c.status,
      duration: c.duration,
      path: c.path,
    })),
  );
} finally {
  await Promise.all(leases.map((l) => callOperation("sessions.release", l)));
}
