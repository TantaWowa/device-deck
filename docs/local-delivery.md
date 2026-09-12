# Local application delivery

Delivered 12 September 2026 as Device Deck 0.2.0 for Apple Silicon Macs. The public demo is a separate simulated experience.

The local application includes the device table and viewers, a shared daemon, CLI, separate TUI, MCP, editable JSON, durable sessions and capture library. The daemon owns capture processes so closing a client leaves a valid recording running. It verifies lease credentials, serializes device commands and cleans up owned processes before releasing a source.

## Release validation

- TypeScript, 24 automated tests, configuration/operation schema generation and local/public production builds pass.
- The public website and isolated demo pass all 16 browser acceptance checks.
- Dedicated iOS 26.3 and tvOS 26.2 simulators passed native input, preview, screenshots and recordings. Both recorded simultaneously. A forced daemon crash exercised recovery and stale credential rejection.
- A dedicated Google TV API 34 ARM64 emulator passed ADB input, preview, screenshots, owned remote recording cleanup, clean and annotated video. Static and changing-screen recordings both finalized at 4.83 seconds.
- HTTP, CLI, TUI, MCP and browser walkthroughs passed. The browser test covered continued recording after browser close, explicit takeover, stale configuration edits, real multi-view and responsive layout.
- The archive was unpacked into a directory containing spaces and an apostrophe. With a minimal environment and a working directory outside the checkout, the packaged launcher started an empty inventory and captured a real Android screenshot and annotated video. Native Mac clipboard, metadata/keypress manifest preservation and byte-range downloads passed.
- The relocated package installed a per-user login service, reported authenticated readiness, then uninstalled it. Configuration and actual capture files remained; the service and LaunchAgent were removed.

The Android proof found a static-screen edge case where screenrecord writes one real frame with zero duration. Native capture finalization now repeats the final frame through the elapsed recording time and validates the resulting video. It does not generate replacement screen content. The USB encoder fixture found a missing explicit MJPEG input decoder, which was corrected before release. Concurrent library editing and permanent deletion share one queue, preventing a late rename from recreating a purged manifest.

## Coverage boundary

See [validation](validation.md) for the complete exercised matrix. Physical Roku, Android TV/Fire TV, Apple TV Companion pairing and USB capture-card permissions, disconnects and enumeration changes have not been verified on physical hardware. Two real ffmpeg encoder fixture streams cover USB process coordination, not the AVFoundation hardware path. No existing Tawi/lab device was operated.

Captures are silent. Browser preview refreshes about once per second. Native Android recording is capped at 175 seconds. Other physical Apple devices have discovery only. Input logs describe command dispatch timing. There is no cloud runtime, account login or multi-host coordinator.

## Reproduce and run

The release contains bundled Node entry points, the compiled Mac helper, local web assets, configuration examples, API schemas, documentation and dependency license notices. It requires Node 24 and any adapter tools listed in the [README](../README.md). Runtime code does not import from the development checkout.

```sh
./devdeck init
./devdeck start
./devdeck ui
```

Use `./devdeck install` after placing the unpacked application in its permanent folder. `./devdeck uninstall` removes the login service and keeps user data. Run `./devdeck mcp` or `./devdeck tui` for the other clients.

The private repository contains the implementation and repeatable proof scripts. The local delivery folder holds the archive, screenshots, videos and a receipt with the final revision and SHA-256 checksum. Those files and runtime credentials are excluded from Git and Firebase. Only the public website and demo under `dist/` are hosted.
