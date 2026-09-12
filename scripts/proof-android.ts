import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { callOperation, endpoint } from "../packages/core/src/client";

// Dedicated workspace AVD, never the operator's emulator-5554.
const { config, revision } = await callOperation("config.get");
if (!config.devices.some((d: any) => d.id === "proof-android")) {
  config.devices.push({
    id: "proof-android",
    name: "Device Deck Android TV Proof",
    platform: "Android",
    kind: "virtual",
    model: "Google TV API 34",
    visibility: "local",
    connection: { type: "adb", serial: "emulator-5580", port: 5037 },
    captureSourceId: "proof-android-screen",
  });
  config.sources.push({
    id: "proof-android-screen",
    name: "Android proof native screen",
    kind: "native",
    deviceId: "proof-android",
  });
  await callOperation("config.save", { config, revision });
}
const inventory = await callOperation("inventory");
const device = inventory.devices.find((d: any) => d.id === "proof-android");
assert.equal(device.online, true);
console.log("Android capabilities:", device.capabilities);
const reservation = await callOperation("sessions.reserve", {
  selector: { device: "proof-android" },
  owner: "Android proof",
  reason: "Dedicated AVD input and recording validation",
});
const lease = {
  sessionId: reservation.session.id,
  leaseToken: reservation.leaseToken,
};
try {
  const ep = await endpoint();
  const preview = await fetch(ep.url + "/v1/preview/proof-android", {
    headers: { Authorization: `Bearer ${ep.token}` },
  });
  assert.equal(preview.status, 200);
  await writeFile(
    "work/android-preview.png",
    Buffer.from(await preview.arrayBuffer()),
  );
  await callOperation("remote.input", { ...lease, key: "Home" });
  const image = await callOperation("captures.screenshot", lease);
  assert.ok(image.bytes > 1000);
  const started = await callOperation("recordings.start", {
    ...lease,
    mode: "annotated",
  });
  assert.equal(started.status, "recording");
  await new Promise((r) => setTimeout(r, 1500));
  await callOperation("remote.input", {
    ...lease,
    key: process.env.PROOF_STATIC ? "Right" : "Down",
  });
  await new Promise((r) => setTimeout(r, 1500));
  await callOperation("remote.input", {
    ...lease,
    key: process.env.PROOF_STATIC ? "Left" : "Up",
  });
  await new Promise((r) => setTimeout(r, 1000));
  const recording = await callOperation("recordings.stop", lease);
  assert.equal(recording.status, "completed", recording.error);
  assert.ok(recording.duration >= 3);
  assert.ok(recording.bytes > 1000);
  await writeFile(
    process.env.PROOF_STATIC
      ? "work/android-static-proof-result.json"
      : "work/android-proof-result.json",
    JSON.stringify({ deviceId: device.id, image, recording }, null, 2),
  );
  console.log("Android proof:", {
    screenshot: image.path,
    video: recording.path,
    cleanPath: recording.cleanPath,
    duration: recording.duration,
    bytes: recording.bytes,
  });
} finally {
  await callOperation("sessions.release", lease);
}
await assert.rejects(
  callOperation("remote.input", { ...lease, key: "Home" }),
  /expired or closed/,
);
console.log("Android session released and stale credentials rejected.");
