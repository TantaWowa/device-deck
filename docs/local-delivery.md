# Historical local application delivery

This is the Device Deck 0.2.0 delivery record. Use the [install guide](install.md) for current packages and the [documentation index](README.md) for current features. The 0.3.0 follow-up added [report ranges and Capture Cards](reports-and-capture-cards.md); neither receipt validates a later release.

Delivered 12 September 2026 as Device Deck 0.2.0 for Apple Silicon Macs. The public demo is a separate simulated experience.

That version included the device table and viewers, a shared daemon, CLI, separate TUI, MCP, editable JSON, durable sessions and capture library. The daemon owned capture processes so closing a client left a valid recording running. It verified lease credentials, serialized device commands and cleaned up owned processes before releasing a source.

## Release validation

- TypeScript, 24 automated tests, configuration/operation schema generation and local/public production builds passed.
- The public website and isolated demo passed all 16 browser acceptance checks.
- Dedicated iOS 26.3 and tvOS 26.2 simulators passed native input, preview, screenshots and recordings. Both recorded simultaneously. A forced daemon crash exercised recovery and stale credential rejection.
- A dedicated Google TV API 34 ARM64 emulator passed ADB input, preview, screenshots, owned remote recording cleanup, clean and annotated video. Static and changing-screen recordings both finalized at 4.83 seconds.
- HTTP, CLI, TUI, MCP and browser walkthroughs passed. The browser test covered continued recording after browser close, explicit takeover, stale configuration edits, real multi-view and responsive layout.
- The archive was unpacked into a directory containing spaces and an apostrophe. With a minimal environment and a working directory outside the checkout, the packaged launcher started an empty inventory and captured a real Android screenshot and annotated video. Native Mac clipboard, metadata/keypress manifest preservation and byte-range downloads passed.
- The relocated package installed a per-user login service, reported authenticated readiness, then uninstalled it. Configuration and actual capture files remained; the service and LaunchAgent were removed.

The Android proof found a static-screen edge case where screenrecord wrote one real frame with zero duration. The fix repeated the final frame through the elapsed recording time and validated the resulting video without generating replacement screen content. The USB encoder fixture found a missing explicit MJPEG input decoder, which was corrected before release. Concurrent library editing and permanent deletion shared one queue, preventing a late rename from recreating a purged manifest.

## Coverage boundary

See [validation](validation.md) for the historical exercised matrix. Physical Roku, Android TV/Fire TV, Apple TV Companion pairing and USB capture-card permissions, disconnects and enumeration changes were not verified on physical hardware in that run. Two real ffmpeg encoder fixture streams covered USB process coordination, not the AVFoundation hardware path. No existing Tawi/lab device was operated.

Version 0.2.0 had silent captures, browser previews refreshing about once per second and a 175-second limit on native Android recordings. Input logs described command dispatch timing. That milestone had no cloud runtime, account login or multi-host coordinator.

Later work added [live video and touch](live-video-and-touch.md), the [physical iOS adapter](physical-ios.md), [Deck sharing](deck-sharing.md) and the [optional portal](remote-access.md). Their documentation records current behavior and later evidence separately.

## Original archive workflow

The 0.2.0 archive contained bundled Node entry points, the compiled Mac helper, local web assets, configuration examples, API schemas, documentation and dependency license notices. It required a separate Node 24 runtime and adapter tools. Runtime code did not import from the development checkout. These commands describe that archive; use the [install guide](install.md) for current Mac installers.

```sh
./devdeck init
./devdeck start
./devdeck ui
```

For that archive, `./devdeck install` registered the login service after the folder was placed in its permanent location. `./devdeck uninstall` removed the login service and kept user data. `./devdeck mcp` and `./devdeck tui` started the other clients.

The implementation and repeatable proof scripts are in the repository. The original local delivery folder held the archive, screenshots, videos and a receipt with the final revision and SHA-256 checksum. Those evidence files and runtime credentials were excluded from Git and Firebase. Only the public website and demo under `dist/` were hosted at that milestone. This record does not establish that the local evidence files remain available.
