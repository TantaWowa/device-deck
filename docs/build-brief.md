> Scope note, 11 September 2026: this is the broader intended product brief. The first milestone builds the marketing site, an explicitly simulated dashboard, and service/client boundaries. The hardware acceptance criteria below are not yet satisfied. `Device Deck` is the provisional name and `devdeck` the current proposed CLI name. Source paths were replaced with private repository references for portability.

# Build brief: Local TV Device Manager

**Owner:** George Cook
**Status:** Implementation brief, 11 September 2026
**Working CLI name:** `devmgr`; product naming remains open.

## Objective

Build a standalone local device manager that a human or an AI agent can use equally well through a command line, a browser, a documented API and MCP. Use editable JSON configuration files.

The product brings together George's existing tools for device discovery, reservations, remote input, screenshots and video. It manages the customer's own physical devices, USB HDMI capture cards, Android emulators and Apple simulators. It must work with ordinary applications on those devices, independently of the Hosanna framework or a Tawi job.

The first useful result is George running a regression session through one workflow:

**Find a device → reserve it → view/control it → capture evidence → release it.**

## Scope and decisions

- Build for one Mac with multiple devices and capture cards first. Keep a host identity in the model so additional hosts can be added later.
- Provide a background service, local web dashboard, CLI, JSON API and MCP in the first usable release.
- Make JSON the source of truth for operator configuration: devices, friendly names, capture mappings, defaults and output settings.
- Keep transactional runtime state, such as active leases, separate from editable configuration. Reusing SQLite for runtime state is appropriate.
- Reuse the existing TypeScript/Node implementation where practical. Choose native helpers only where capture, input or OS integration requires them.
- Start with Roku, Android/Android TV, Android emulators and Apple iOS/tvOS simulator support. Integrate existing physical Apple capabilities honestly; discovery alone does not establish control or capture support.
- Keep the initial product independent of team accounts, cloud hosting, billing, a distributed scheduler and any particular test runner.

## 1. Inspect and reuse the existing code

Start by reading applicable repository guidance and tracing the sources below. Produce a short reuse map: existing capability, source owner, usable interface, coupling to remove, and missing work. Then implement. This is a build assignment; discovery is the first step.

### Tawi

Local checkout: [tw-harness](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29).

Verified starting points:

- [resources.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/resources.ts): discovery, inventory, transactional reservations, expiry, owner checks and resource health.
- [resource-policy.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/resource-policy.ts): selection by alias, pool, platform and capabilities.
- [daemon.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/daemon.ts), [rpc.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/rpc.ts): service ownership and client boundary.
- [mcp-server.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/mcp-server.ts), [web-console.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/web-console.ts): existing MCP and browser access.
- [apple-proof.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/apple-proof.ts), [android-proof.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/android-proof.ts), [roku-device.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/roku-device.ts), [roku-proof.ts](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/src/roku-proof.ts): platform capture, device access and evidence handling.
- [Resource documentation](https://github.com/TantaWowa/tawi/blob/3398128c000402d5bc47ed8bba0027f71f13bd29/docs/resources.md) and corresponding tests.

Tawi currently requires an existing durable Tawi run when reserving through its daemon. Replace that dependency with a generic device session owned by a human, CLI process or agent. Tawi run IDs can remain optional correlation metadata. Preserve useful locking and recovery behavior without importing ticket workflows or proof-approval machinery.

### Hosanna Tools

Local checkout: [hosanna-tools](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12).

- [video-capture.ts](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12/src/capture/video-capture.ts) and [capture documentation](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12/docs/video-capture.md): Apple simulator recording, ffmpeg/AVFoundation capture, screen/window capture, session results and manifests.
- [devices-file.ts](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12/src/device/devices-file.ts), [device-cli.ts](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12/src/device/device-cli.ts), [driver-registry.ts](https://github.com/TantaWowa/hosanna-tools/blob/b1e5dd51d8c1b689bd5e556f78f218bb10689d12/src/device/driver-registry.ts) and platform drivers: inventory, discovery and device operations.

The reviewed VideoCaptureManager permits one active recording per manager instance. Audit how to support concurrent sources; do not assume this means the lower-level capture library cannot run parallel sessions.

### Remote-input scripts

George has existing Roku, Android and iOS remote tools to reuse. Verified Roku entry points are:

- [functions.zsh](private-source/remote-scripts/functions.zsh): `sendText`, `sendInteractive` and ECP helpers.
- [roku-ecp-interactive.py](private-source/remote-scripts/scripts/roku-ecp-interactive.py) and its tests under the sibling tests directory.

Locate the Android/iOS script entry points during discovery; their exact paths have not yet been established. Trace implementations and their dependencies rather than rebuilding from their names.

Use these checkouts as source material. The delivered package must run without George's absolute paths, shell setup or development checkouts. Reuse through suitable modules or narrowly extracted adapters, preserving source attribution and dependency licenses. Keep the product separate from Hosanna UI framework source.

**Complete when:** every required capability has a source or an explicit implementation gap, and the new package has a clear home and dependency boundary.

## 2. Build one service with several clients

The service owns inventory, reservations, device connections, capture processes and artifacts. CLI, web UI, HTTP API and MCP call the same application operations and return consistent results.

Use a small adapter boundary for discovery, inspection, remote input and capture capabilities. A physical Roku might use network ECP for input and a USB card for video. An emulator uses its own control and screen source. Model the logical device and its capture source separately.

Capabilities must describe operations the adapter can actually perform. Expose unsupported operations clearly. Keep any Hosanna-specific debugger integration optional.

The service should run in the foreground for development or as a per-user background service at login. Supply install/start/stop/status/uninstall commands and useful dependency diagnostics. Closing a browser, CLI invocation or MCP connection must not implicitly kill an active recording.

**Complete when:** a human and an MCP client can inspect the same inventory and operate the same session through a running background service.

## 3. Define usable configuration and access contracts

### JSON configuration

Provide a versioned JSON schema, a small example file, validation, import/export and documented configuration precedence. The web editor and CLI modify the same configuration through the service, using atomic writes and conflict detection. Invalid edits preserve the last valid running configuration.

Use stable logical IDs. Rediscovery must preserve names and mappings. USB enumeration indexes can change; a missing or ambiguous source must not silently become another card.

Illustrative shape, to refine against the reused adapters:

```json
{
  "schemaVersion": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 0
  },
  "captureSources": [
    {
      "id": "capture-card-1",
      "kind": "usb-video",
      "selector": {
        "deviceId": "REPLACE_WITH_DISCOVERED_SOURCE_ID"
      }
    }
  ],
  "devices": [
    {
      "id": "roku-desk",
      "name": "Desk Roku",
      "platform": "roku",
      "connection": {
        "kind": "roku-ecp",
        "host": "192.0.2.10"
      },
      "captureSourceId": "capture-card-1"
    }
  ],
  "reservations": {
    "defaultTtlSeconds": 900
  },
  "capture": {
    "outputDirectory": "./captures"
  }
}
```

The example address and source identifier are placeholders. Port zero means an OS-assigned port; clients need a documented local endpoint-discovery mechanism. Resolve relative paths consistently against the configuration file. Keep secrets out of ordinary status output; support references to local credentials where required.

### CLI, API and MCP

Cover these operation groups through all applicable surfaces:

| Group     | Operations                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| Setup     | Initialize, validate and inspect configuration; inspect service/dependency health           |
| Inventory | Discover, list, inspect, name and configure devices; list and pair capture sources          |
| Sessions  | Reserve by device or capabilities, list ownership, renew, release, explicit manual takeover |
| Control   | Send supported remote keys, text and input sequences                                        |
| Capture   | Open a live view, save a screenshot, start/status/stop a recording                          |
| Artifacts | List and retrieve screenshots, recordings and their metadata                                |

CLI output should be concise for people, with `--json` for scripts, documented exit codes and useful `--help`. Noninteractive commands must not wait for prompts. Long operations return an operation or recording ID.

Publish the HTTP contract and JSON schemas. Provide MCP tool descriptions, input/output schemas and setup examples. MCP should return screenshots as image content where supported, plus retrievable artifact references. Keep MCP protocol output separate from diagnostic logging.

Bind locally by default and reuse suitable local authentication and browser-origin protection from Tawi. Human-readable owner names are labels, not proof that a caller owns a lease.

**Complete when:** a documented CLI walkthrough and an MCP walkthrough both perform the complete session workflow, with consistent errors and artifact results.

## 4. Make ownership and capture reliable

Reservations are exclusive, atomic and time-limited. Return a lease credential bound to the particular session. Renewals and operations must validate it; an old credential cannot control a newly acquired session.

Require an active session for remote input and capture operations. The web UI should make acquiring a human session easy. Show who owns a device and why. Allow an explicit, visible takeover with a reason.

Serialize commands per device. Different devices with independent capture sources must work concurrently. If two configured devices share one capture card, they cannot capture through it simultaneously. Preview, screenshots and recording for the same session must share or coordinate source access.

On expiry, release or takeover, reject old input immediately and stop/finalize the old session's recording before making its source available again. Handle process failure and service restart explicitly; never report an interrupted recording as successful or silently resume stale commands.

Capture artifacts should include device/session identity, source, timestamps, format and completion/failure information. Saved screenshots and video should represent the source itself, without dashboard controls or upgrade overlays. Repeated stop/release requests should return a clear stable result.

**Complete when:** two competing callers cannot both own a device, stale owners cannot act, independent recordings coexist, and cleanup releases the real resources.

## 5. Deliver a dashboard people will use

The home screen is the device inventory. Show name, platform, connectivity, available operations and reservation status, with a clear route into a device session.

Within a session, put live view, remote controls, screenshot and start/stop recording together. Provide visible recording state and direct access to the resulting files. Keep source pairing and device editing straightforward; remember the choices across restarts.

Keyboard remote input must target the selected session and stop when the user is typing in a form. Distinguish an offline device, an unavailable capture card and a missing host permission.

Provide a central view for physical and virtual devices. If a platform initially supports periodic image previews rather than full-motion streaming, label that behavior and record the remaining gap.

**Complete when:** George can configure a device once, return later, reserve it and collect evidence without consulting shell scripts.

## 6. Validate and package the result

Use focused tests for the failure modes that matter:

1. Concurrent reservation attempts produce one owner; renewal, expiry and takeover reject stale credentials.
2. The CLI, web, HTTP API and MCP enforce the same ownership checks.
3. Independent capture sources record simultaneously; a shared source cannot be double-booked.
4. Closing the dashboard leaves a valid background recording running; stop produces a playable file.
5. Disconnecting/reordering capture cards preserves identity and never redirects capture silently.
6. Invalid configuration and conflicting edits preserve valid state; JSON edits round-trip through the dashboard.
7. Restart/crash cleanup reports interrupted work and releases resources predictably.

Demonstrate a real physical-device session and a simulator/emulator session on available hardware. State exactly which adapters and operations were exercised, and list unavailable hardware separately.

Supply a runnable package, example JSON, CLI/API/MCP documentation, service lifecycle instructions and a concise walkthrough. Prefer reusing the current Node runtime and helpers; a bundled installer can follow the first working package. Packaging is not source-code secrecy.

The implementation report must identify what was reused, what changed in source repositories, validation results, supported targets and remaining limitations. Completion means a working device-session workflow, not just a dashboard mockup or source inventory.

## Commercial context

George may offer this as shareware at roughly $5–$10 per month. A possible paid tier is reservations and agent coordination, with useful manual tools and a full-feature trial. This remains a pricing hypothesis. Keep payment integration outside the first functional milestone, and preserve the complete reservation/API workflow while establishing that the tool solves George's own bottleneck.

Carabiner already provides capture, controls and MCP; larger own-device lab products also overlap. The product's intended value is a convenient local inventory with dependable shared ownership and evidence capture for both people and agents.
