# Architecture and reuse map

The immediate milestone is a website and reviewable product preview. The broader build brief remains the intended hardware-manager scope, not a claim of completion.

## Ownership

One local service owns devices, sessions, capture processes, and artifacts. The browser, CLI, HTTP API, and MCP are clients. The future dashboard must use the service operations, replacing `DemoModel` through a client boundary. The marketing deployment must never connect to a visitor's local devices.

Logical devices and capture sources are separate records. A network Roku input adapter and an HDMI capture adapter may serve the same device. Source discovery cannot identify the attached HDMI device. Pairing must be explicit, remembered, and stable across USB enumeration changes.

Configuration belongs in versioned JSON. Session credentials and lease history belong in transactional runtime storage, such as SQLite. A durable Tawi run is not a prerequisite. Optional correlation metadata can refer to external jobs.

The initial host is one Mac with multiple independent sources. Office-wide host discovery, team SaaS, cloud devices, billing, and distributed scheduling are deferred.

## Current implementation

`apps/app/src/demo/model.ts` owns browser-only sample state. It defines isolated simulation types and imports no service or hardware adapter. The service imports no demo data and registers no adapters. It exposes only GET health and inventory. CLI and MCP both call the shared core HTTP client. The service does not yet serve the local dashboard.

The `DeviceAdapter` and `SessionOperations` interfaces mark the intended extraction boundaries. They are preliminary, not implemented adapters. Before implementation, split optional adapter capabilities so discovery-only targets cannot accidentally advertise unsupported operations. Add capture-source coordination separate from platform input drivers.

## Source review

Reviewed 11 September 2026. Tawi revision `3398128c000402d5bc47ed8bba0027f71f13bd29`; Hosanna Tools revision `b1e5dd51d8c1b689bd5e556f78f218bb10689d12`. Source repositories remain untouched. No implementation was extracted in this milestone, so there is no copied source whose license has been silently changed.

| Existing capability                                             | Owner and source                                                        | Reuse direction and remaining gap                                                                                                                                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named inventory, discovery, transactional leases, health/expiry | TantaWowa/tawi `src/resources.ts`                                       | Preserve alias, health and SQLite locking ideas. Replace run identity with independent sessions and credentials. Audit cleanup before resource reuse.                                                                 |
| Platform/capability selection                                   | Tawi `src/resource-policy.ts`, referenced in the brief                  | Candidate selection boundary. Detailed extraction is deferred.                                                                                                                                                        |
| Background service and shared client                            | Tawi `src/daemon.ts`, `src/rpc.ts`                                      | RPC already exists. `resources.reserve` in daemon line 1069 requires a durable run and updates that run. Keep device sessions independent of this dependency.                                                         |
| MCP and browser console                                         | Tawi `src/mcp-server.ts`, `src/web-console.ts`, referenced in the brief | Existing interfaces are available. Further integration audit is deferred; they are not missing building blocks.                                                                                                       |
| Android screenshots/recording                                   | Tawi `src/android-proof.ts`                                             | Uses ADB capture and validates artifacts, bound to proof/run contracts. Extract tool execution without proof approval and ticket workflows.                                                                           |
| Roku remote and screenshots                                     | Tawi `src/roku-proof.ts`, `src/roku-device.ts`                          | ECP keys exist. Current screenshot route requires a configured credential and developer capture path. This is not evidence that arbitrary Roku apps can be captured this way. Use HDMI pairing when needed.           |
| Apple devices and simulators                                    | Tawi resources and `src/apple-proof.ts`                                 | Discovery distinguishes physical Apple from sims. Verify operation-specific capability before adding real control/capture. Physical discovery alone is insufficient.                                                  |
| AVFoundation HDMI, Mac screen/window, simulator recording       | Hosanna Tools `src/capture/video-capture.ts`                            | `VideoCaptureManager.start` refuses a second active recording per manager. Lower-level `VideoCaptureSession` may support separate concurrent sources; source locking, preview sharing and cancellation need auditing. |
| Device files and platform drivers                               | Hosanna Tools `src/device/driver-registry.ts`, `devices-file.ts`        | Registry exposes discover and resolve with platform drivers. Remove personal environment fallback and interactive selection from service/agent paths.                                                                 |
| Existing remote scripts                                         | George's Roku ECP helpers, documented in the brief                      | No script code extracted. Android/iOS script locations remain unverified and do not block the website milestone.                                                                                                      |

## Hardware implementation acceptance gates

1. Atomic exclusive reservation returns a secret credential tied to that lease. Names identify owners for display only.
2. Every client must validate the current lease on every input/capture operation. Stale credentials fail after expiry, release or takeover.
3. Reject old commands immediately. Finish capture cleanup before a successor acquires the device or shared source.
4. Serialize commands per device. Permit parallel work only for independent sources. Coordinate preview, screenshots and recording for one session.
5. Recordings survive dashboard closure. Stop produces a playable source-only file and an accurate manifest. Restart reports interrupted work.
6. Config writes are atomic, revision-checked and validated. Invalid edits retain the previous configuration. IDs and pairings survive rediscovery.
7. Add local authentication and browser-origin protections before enabling mutations. Test all clients against the same ownership failure cases.
8. Exercise a real physical session and a virtual-device session before calling adapters supported.

## Visual assets

Dashboard and session screenshots are generated from the running React prototype, then encoded as WebP for the website. The fictional FIELDNOTES screen uses an original image made with built-in imagegen: a cinematic aerial dark mountain ridge and deep teal fjord at sunset, with no text, logos, UI, people or buildings. It is artwork, not a device capture. No customer data or device addresses are embedded in public assets.
