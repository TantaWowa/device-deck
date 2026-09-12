import { callOperation, endpoint } from "../packages/core/src/client";
import { writeFile } from "node:fs/promises";
const inventory = await callOperation("inventory");
console.log(
  "Inventory:",
  inventory.devices.map((d: any) => ({
    name: d.name,
    online: d.online,
    capabilities: d.capabilities,
  })),
);
const { session, leaseToken } = await callOperation("sessions.reserve", {
  selector: { device: "proof-ios" },
  owner: "Device Deck proof",
  reason: "Isolated real simulator session",
});
const lease = { sessionId: session.id, leaseToken };
try {
  const ep = await endpoint();
  const preview = await fetch(ep.url + "/v1/preview/proof-ios", {
    headers: { Authorization: `Bearer ${ep.token}` },
  });
  if (!preview.ok) throw new Error(await preview.text());
  await writeFile(
    "work/proof-preview.png",
    Buffer.from(await preview.arrayBuffer()),
  );
  console.log("Real preview saved.");
  console.log(
    "Input:",
    await callOperation("remote.input", { ...lease, key: "Home" }),
  );
  const image = await callOperation("captures.screenshot", lease);
  console.log("Screenshot:", image.path, image.bytes);
  const record = await callOperation("recordings.start", {
    ...lease,
    mode: "annotated",
  });
  console.log("Recording started:", record.id);
  await new Promise((r) => setTimeout(r, 1500));
  await callOperation("remote.input", { ...lease, key: "Home" });
  await new Promise((r) => setTimeout(r, 1800));
  const stopped = await callOperation("recordings.stop", lease);
  console.log("Recording:", {
    path: stopped.path,
    cleanPath: stopped.cleanPath,
    status: stopped.status,
    duration: stopped.duration,
    bytes: stopped.bytes,
    error: stopped.error,
  });
  await writeFile(
    "work/proof-result.json",
    JSON.stringify(
      { image, recording: stopped, sessionId: session.id },
      null,
      2,
    ),
  );
} finally {
  await callOperation("sessions.release", lease);
  console.log("Session released.");
}
try {
  await callOperation("remote.input", { ...lease, key: "Home" });
  throw new Error("Stale credential was accepted");
} catch (e) {
  if (!(e as Error).message.includes("expired or closed")) throw e;
  console.log("Released credential rejected.");
}
