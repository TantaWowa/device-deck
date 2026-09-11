export type Platform =
  "roku" | "android-tv" | "android-emulator" | "apple-simulator";
export type Capability = "preview" | "input" | "screenshot" | "record";
export interface CaptureSource {
  id: string;
  name: string;
  kind: "usb-video" | "native";
  status: "connected" | "missing";
}
export interface Device {
  id: string;
  name: string;
  platform: Platform;
  kind: "physical" | "virtual";
  model: string;
  online: boolean;
  captureSourceId: string | null;
  capabilities: Capability[];
}
export interface Lease {
  id: string;
  deviceId: string;
  owner: string;
  reason: string;
  expiresAt: number;
}
export interface Artifact {
  id: string;
  deviceId: string;
  name: string;
  kind: "screenshot" | "recording";
  createdAt: number;
  simulated: boolean;
}
export interface Inventory {
  devices: Device[];
  sources: CaptureSource[];
  leases: Lease[];
}
/** Future hardware adapters are registered only after each operation has been verified. */
export interface DeviceAdapter {
  platform: Platform;
  discover(): Promise<Device[]>;
  inspect(id: string): Promise<Device>;
  input(id: string, key: string): Promise<void>;
  screenshot(id: string): Promise<Uint8Array>;
  startRecording(id: string): Promise<{ id: string }>;
  stopRecording(id: string): Promise<Artifact>;
}
export interface SessionOperations {
  reserve(
    deviceId: string,
    owner: string,
    reason: string,
    ttlSeconds: number,
  ): Promise<Lease & { credential: string }>;
  renew(credential: string, ttlSeconds: number): Promise<Lease>;
  release(credential: string): Promise<void>;
  input(credential: string, key: string): Promise<void>;
}
export const serviceContract = {
  version: 1,
  implemented: ["health", "inventory"],
  planned: [
    "discover",
    "pair",
    "reserve",
    "renew",
    "release",
    "input",
    "screenshot",
    "recording.start",
    "recording.stop",
    "artifacts",
  ],
} as const;
