# Validation and coverage

Validated on 12 September 2026 on an Apple Silicon Mac. The local application is separate from the public simulated demo.

## Version 0.4.0 licensing foundation

The free release is covered by the repository test suite, including concurrent reservations, annotations without activation, legacy configuration compatibility, and public GitHub installer integrity checks. Run `npm test`, `npm run check`, and `npm run test:distribution` for the current results.

## Version 0.3.0 reports and Capture Cards

Version 0.3.0 had 32 passing tests with no skips. The eight added tests cover local calendar boundaries and daylight saving changes, actual reservation overlap, full-history aggregation, stable USB identities, persisted assignments and reservation guards.

Scoped browser checks cover day/week/month/custom reports, invalid and empty ranges, saved range preferences, hovered and focused selected-period contrast, capture-card assignment conflicts, refresh/reload persistence, device selector consistency and 390-pixel layouts. Local HTTP, CLI and MCP return the same custom-range totals. All 16 public demo QA checks also pass.

Capture-card assignment was exercised against an isolated service fixture and the simulated demo. No physical card was opened or reassigned for this update. The native helper compiles on the Mac. The real-device evidence below belongs to version 0.2.0 and was not repeated for this scoped update.

## Version 0.2.0 real device sessions

Two fresh Apple simulators and a dedicated Android TV AVD were created for this work. Existing Tawi/lab targets were not used or interrupted. Android used a separate data directory and emulator port 5580.

| Target                          | Exercised through the daemon                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone 15 Pro, iOS 26.3         | Reservation, real preview/PNG, idb Home input, clean and annotated video, recording-relative key log, stop/release and stale credential rejection     |
| Apple TV 4K at 1080p, tvOS 26.2 | Reservation, external-display preview/PNG/video, idb Right/OK/Down input, Mac clipboard screenshot, stop/release                                      |
| Both simultaneously             | Independent live previews and concurrent native recordings, successfully finalized at 8.70 and 8.73 seconds                                           |
| Google TV API 34 ARM64 emulator | ADB Home/Down/Up, preview/PNG, owned remote screenrecord PID, clean and annotated 4.83-second video, stop/pull/release and stale credential rejection |

The iOS annotated proof is 3.73 seconds long and has a separate clean original. ffprobe validated video streams and duration. The originating task also independently decoded that annotated file with ffmpeg. The tvOS screenshot shows the Settings screen reached through directional/select input.

Real client walkthroughs passed for HTTP, CLI, MCP and browser. MCP returned a PNG image block. CLI accepted lowercase platform filters, rejected invalid selectors with exit code 2, and wrote a screenshot to the native Mac clipboard. The distinct TUI was operated through a terminal: filter, select, enter owner/reason, reserve, send Down, save screenshot, release and return to inventory.

The browser test closed its entire browser context during recording. The daemon kept recording. A fresh browser used explicit takeover to finalize that recording before acquiring and releasing the target. Desktop table, focused viewer, capture library, reports, real iOS/tvOS multi-view and a 390-pixel mobile layout were captured and visually inspected. The page has no mobile body overflow; the wide device table scrolls internally.

A forced SIGKILL of the dedicated daemon during a real tvOS recording was followed by restart. Recovery stopped the owned recorder, marked its artifact interrupted, rejected the previous lease credential and allowed the cleaned device to be reserved again.

Android static-screen and changing-screen recordings both completed at 4.83 seconds. The static proof caught a single-frame MP4 without duration. Finalization now preserves that captured frame through elapsed stop time, then verifies a playable video. An annotated frame was visually inspected and the entire clip decoded with ffmpeg.

## Automated checks

Version 0.2.0 had 24 passing tests with no skips. Twelve cover the isolated public demo. Twelve cover real service/configuration logic and recorder fixtures, including:

- Exclusive device/source reservations, competing callers and credential validation.
- Closing-state invalidation before recorder cleanup, renewal, expiry and takeover.
- Host/Origin checks, API authentication, browser cookie restrictions and one-use ticket replay rejection.
- Concurrent same-revision saves, duplicate physical sources and ADB identities, and reserved config protection.
- Closing idle preview sources on configuration change.
- Logging disabled without new SQLite input text, metadata manifest updates preserving earlier inputs, reversible trash and concurrent edit/purge without recreating files.
- Retaining a PID written to stdout before recorder readiness.
- Two independent real ffmpeg encoders driven by deterministic JPEG fixture streams. Disconnecting one fixture source ends its encoder and yields an interrupted result; the other recorder remains alive and completes normally.
- CLI lowercase filters and invalid-selector validation.

The fixture test caught and corrected a missing explicit MJPEG input decoder in the USB pipeline. These encoder tests validate process/source coordination; they are not a physical capture-card proof.

The web configuration test kept an unsaved form open while another API client changed JSON. The stale browser draft was rejected after polling the newer state, and the newer configuration remained intact.

TypeScript and the local/public production builds pass. Generated configuration and operation schemas use the same Zod contracts as the running daemon.

## Untested hardware and limits

No idle physical target was confirmed for this work. Physical Roku, Android/Android TV/Fire TV, USB capture-card permissions/disconnect/reorder behavior, and Apple TV Companion pairing were not exercised on physical hardware. Those adapter paths are implemented, and their unsupported/missing dependency states are explicit, but their hardware coverage remains unverified. The existing `lab-android-tv` emulator was deliberately left alone because ownership could not be established.

Physical iPhones and iPads now have an optional [WebDriverAgent touch and native snapshot adapter](physical-ios.md). Protocol, USB-forwarding lifecycle, WebRTC and encoder fixtures cover this integration; physical-device touch and performance remain unverified. Other physical Apple devices have discovery only. USB and native captures are silent. Preview is periodic image refresh rather than a full-motion browser stream. Native Android recording is limited to 175 seconds; other recorders use the configured maximum. Input overlays use dispatch timestamps, not an assertion that the device rendered a frame at the instant a command was sent.

Installer/service lifecycle and package relocation checks are recorded in [local delivery](local-delivery.md). The external delivery receipt includes the revision and archive checksum. Version 0.4.0 adds a private, undeployed billing bridge. Cloud runtime, user accounts and multi-host scheduling remain outside the local application.
