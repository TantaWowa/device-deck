import {
  configSchema,
  type Device,
  type Session,
  type Snapshot,
} from "../../packages/core/src/local/types";

// Fictional data only. This fixture never imports the daemon or reads a profile.
export const screenshotTime = Date.parse("2026-09-14T10:15:00Z");
export function marketingWorkspace(): Snapshot {
  const config = configSchema.parse({
    schemaVersion: 1,
    settings: {
      folder: "~/Movies/Device Deck samples",
      owner: "Demo operator",
    },
    sources: [
      {
        id: "sample-hdmi-1",
        name: "HDMI 1 · Studio Roku",
        kind: "usb",
        uniqueId: "Fictional capture card A",
      },
      {
        id: "sample-hdmi-2",
        name: "HDMI 2 · Lounge Roku",
        kind: "usb",
        uniqueId: "Fictional capture card B",
      },
      {
        id: "sample-hdmi-3",
        name: "HDMI 3 · Fire TV",
        kind: "usb",
        uniqueId: "Fictional capture card C",
      },
      {
        id: "native-apple-tv",
        name: "Native simulator",
        kind: "native",
        deviceId: "sample-apple-tv",
      },
      {
        id: "native-pixel",
        name: "Native Android screen",
        kind: "native",
        deviceId: "sample-pixel",
      },
      {
        id: "native-iphone",
        name: "Native simulator",
        kind: "native",
        deviceId: "sample-iphone",
      },
    ],
    devices: [
      {
        id: "sample-roku-studio",
        name: "Studio Roku",
        model: "Roku Ultra",
        platform: "Roku",
        kind: "physical",
        connection: {
          type: "roku",
          host: "studio.example.test",
          serial: "SAMPLE-ROKU-A",
        },
        captureSourceId: "sample-hdmi-1",
      },
      {
        id: "sample-roku-lounge",
        name: "Lounge Roku",
        model: "Streaming Stick 4K",
        platform: "Roku",
        kind: "physical",
        connection: {
          type: "roku",
          host: "lounge.example.test",
          serial: "SAMPLE-ROKU-B",
        },
        captureSourceId: "sample-hdmi-2",
      },
      {
        id: "sample-fire-tv",
        name: "Fire TV",
        model: "Amazon Fire TV Stick 4K",
        platform: "Android",
        kind: "physical",
        connection: {
          type: "adb",
          serial: "SAMPLE-FIRE-TV",
          hardwareId: "SAMPLE-FIRE-TV",
          port: 5037,
        },
        captureSourceId: "sample-hdmi-3",
      },
      {
        id: "sample-apple-tv",
        name: "Apple TV simulator",
        model: "tvOS simulator",
        platform: "Apple",
        kind: "virtual",
        connection: {
          type: "simulator",
          os: "tvos",
          udid: "11111111-1111-4111-8111-111111111111",
        },
        captureSourceId: "native-apple-tv",
      },
      {
        id: "sample-pixel",
        name: "Pixel emulator",
        model: "Android virtual device",
        platform: "Android",
        kind: "virtual",
        connection: {
          type: "adb",
          serial: "emulator-5554",
          avdName: "Sample_Pixel",
          port: 5037,
        },
        captureSourceId: "native-pixel",
      },
      {
        id: "sample-iphone",
        name: "iPhone simulator",
        model: "iOS simulator",
        platform: "Apple",
        kind: "virtual",
        connection: {
          type: "simulator",
          os: "ios",
          udid: "22222222-2222-4222-8222-222222222222",
        },
        captureSourceId: "native-iphone",
      },
    ],
  });
  const devices: Device[] = config.devices.map((device) => {
    const stopped = device.connection.type === "simulator";
    return {
      ...device,
      online: !stopped,
      locked: false,
      healthDetail: stopped
        ? "Ready to launch"
        : device.connection.type === "roku"
          ? "ECP connected"
          : "ADB connected",
      capabilities: stopped
        ? []
        : ["key", "text", "preview", "screenshot", "record", "restart"],
      ...(device.kind === "virtual"
        ? {
            simulatorState: stopped
              ? ("shutdown" as const)
              : ("booted" as const),
          }
        : {}),
    };
  });
  const session: Session = {
    id: "sample-session",
    deviceId: "sample-roku-lounge",
    sourceId: "sample-hdmi-2",
    owner: "Demo QA",
    reason: "Playback regression",
    state: "active",
    createdAt: screenshotTime - 120000,
    expiresAt: screenshotTime + 1800000,
  };
  return {
    mode: "local",
    license: {
      tier: "pro",
      state: "active",
      configured: true,
      message: "Fictional screenshot fixture",
      features: [
        "DEVICE_DECK_CONCURRENT_SESSIONS",
        "DEVICE_DECK_RECORDING_ANNOTATIONS",
      ],
      maxSessions: null,
    },
    devices,
    sources: config.sources.map((source) => ({
      ...source,
      status:
        source.kind === "usb" || source.deviceId === "sample-pixel"
          ? "connected"
          : "missing",
    })),
    sessions: [session],
    artifacts: [],
    events: [],
    inputs: [],
    config,
    configRevision: "fictional-marketing-fixture",
    configError: null,
    diagnostics: [],
    recordings: [
      {
        id: "sample-recording",
        deviceId: session.deviceId,
        sessionId: session.id,
        startedAt: screenshotTime - 60000,
      },
    ],
    reports: {
      range: {
        preset: "day",
        start: "2026-09-14",
        end: "2026-09-14",
        startMs: screenshotTime - 3600000,
        endMs: screenshotTime + 3600000,
        asOf: screenshotTime,
        timeZone: "UTC",
      },
      sessions: 1,
      reservedMs: 120000,
      contentions: 0,
      captureAttempts: 1,
      captureFailures: 0,
      byDevice: [],
    },
  };
}
