import type {
  Artifact,
  Device,
  Inventory,
  Lease,
} from "../../../../packages/core/src/index";
export const seedDevices: Device[] = [
  {
    id: "roku-desk",
    name: "Desk Roku",
    platform: "roku",
    kind: "physical",
    model: "Roku Ultra",
    online: true,
    captureSourceId: "hdmi-a",
    capabilities: ["preview", "input", "screenshot", "record"],
  },
  {
    id: "android-tv",
    name: "Living room TV",
    platform: "android-tv",
    kind: "physical",
    model: "Android TV",
    online: true,
    captureSourceId: "hdmi-b",
    capabilities: ["preview", "input", "screenshot", "record"],
  },
  {
    id: "pixel-emulator",
    name: "Pixel emulator",
    platform: "android-emulator",
    kind: "virtual",
    model: "Android emulator",
    online: true,
    captureSourceId: "emulator-native",
    capabilities: ["preview", "input", "screenshot", "record"],
  },
  {
    id: "apple-sim",
    name: "Apple TV simulator",
    platform: "apple-simulator",
    kind: "virtual",
    model: "tvOS simulator",
    online: true,
    captureSourceId: "sim-native",
    capabilities: ["preview", "input", "screenshot", "record"],
  },
];
/** Browser-only simulation. Never imports or contacts a hardware adapter. */
export class DemoModel {
  inventory: Inventory = {
    devices: structuredClone(seedDevices),
    sources: [
      {
        id: "hdmi-a",
        name: "HDMI capture A",
        kind: "usb-video",
        status: "connected",
      },
      {
        id: "hdmi-b",
        name: "HDMI capture B",
        kind: "usb-video",
        status: "connected",
      },
      {
        id: "emulator-native",
        name: "Native emulator screen",
        kind: "native",
        status: "connected",
      },
      {
        id: "sim-native",
        name: "Native simulator screen",
        kind: "native",
        status: "connected",
      },
    ],
    leases: [],
  };
  artifacts: Artifact[] = [];
  recordings = new Map<string, number>();
  constructor(private now = () => Date.now()) {
    this.inventory.leases = [
      {
        id: "demo-you",
        deviceId: "roku-desk",
        owner: "You",
        reason: "Check the browse screen",
        expiresAt: this.now() + 900000,
      },
      {
        id: "demo-agent",
        deviceId: "android-tv",
        owner: "Agent · regression",
        reason: "Nightly navigation checks",
        expiresAt: this.now() + 660000,
      },
    ];
  }
  expire() {
    for (const lease of [...this.inventory.leases])
      if (lease.expiresAt <= this.now()) this.cleanup(lease);
  }
  private cleanup(lease: Lease) {
    if (this.recordings.has(lease.deviceId))
      this.finishRecording(lease.deviceId);
    this.inventory.leases = this.inventory.leases.filter(
      (l) => l.id !== lease.id,
    );
  }
  reserve(deviceId: string, reason: string) {
    this.expire();
    if (this.inventory.leases.some((l) => l.deviceId === deviceId))
      throw new Error("This device already has an owner.");
    if (!reason.trim()) throw new Error("Add a reason for this session.");
    const lease = {
      id: crypto.randomUUID(),
      deviceId,
      owner: "You",
      reason,
      expiresAt: this.now() + 900000,
    };
    this.inventory.leases.push(lease);
    return lease;
  }
  requireOwner(deviceId: string) {
    this.expire();
    const lease = this.inventory.leases.find((l) => l.deviceId === deviceId);
    if (!lease || lease.owner !== "You")
      throw new Error("Reserve this device before controlling it.");
    return lease;
  }
  release(deviceId: string) {
    this.cleanup(this.requireOwner(deviceId));
  }
  renew(deviceId: string) {
    this.requireOwner(deviceId).expiresAt = this.now() + 900000;
  }
  capture(deviceId: string) {
    this.requireOwner(deviceId);
    return this.artifact(deviceId, "screenshot");
  }
  toggleRecording(deviceId: string) {
    this.requireOwner(deviceId);
    if (this.recordings.has(deviceId)) return this.finishRecording(deviceId);
    this.recordings.set(deviceId, this.now());
  }
  private finishRecording(deviceId: string) {
    this.recordings.delete(deviceId);
    return this.artifact(deviceId, "recording");
  }
  private artifact(deviceId: string, kind: "screenshot" | "recording") {
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      deviceId,
      name: `${deviceId}-${String(this.artifacts.length + 1).padStart(2, "0")}.${kind === "screenshot" ? "png" : "mp4"}`,
      kind,
      createdAt: this.now(),
      simulated: true,
    };
    this.artifacts.unshift(artifact);
    return artifact;
  }
}
