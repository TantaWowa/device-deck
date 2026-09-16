# Source provenance

Reviewed and adapted on 12 September 2026. The source checkouts were read without modification. Device Deck has no runtime dependency on George's shell configuration or personal checkout paths.

| Source owner and revision                                             | Reviewed implementation                                                                           | Device Deck adaptation                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TantaWowa / Tawi, `3398128c000402d5bc47ed8bba0027f71f13bd29`          | `src/resources.ts`, `resource-policy.ts`, `daemon.ts`, `rpc.ts`, Apple/Android/Roku proof modules | Stable device locators, exact/capability selection and exclusive SQLite reservations. Replaced durable-run ownership with generic device sessions and per-session random credentials. Added closing state and unique indexes for device/source exclusion. |
| TantaWowa / Hosanna Tools, `b1e5dd51d8c1b689bd5e556f78f218bb10689d12` | `src/capture/video-capture.ts`, `src/discovery/roku-ssdp.ts`, capture docs                        | Native simctl record command, recorder readiness, SIGINT finalization, output validation and Roku SSDP probe structure. The new capture engine permits independent jobs; one shared stream serves each stable USB identity.                               |
| George Cook / shell tools                                             | `tv-remote.py`, Roku ECP helpers and associated tests                                             | Narrowly adapted Android key mappings, ADB server-port selection and text escaping; Roku key mappings; pyatv Companion discovery, identity checks, PIN pairing and text/key operations.                                                                   |

The old Tawi daemon requires a durable run for reservation. That coupling is absent here. No ticket workflow, Hosanna UI framework, proof approval state or global singleton recording manager was imported.

On 13 September 2026, Tawi's `src/tui.tsx` at `0878018401c03d5cc1495ad12ef12657947590da` informed the terminal interaction pattern: persistent menus, a bounded selection window, contextual details, inline forms and visible action keys. Device Deck implements those patterns with its own terminal renderer and existing daemon operations; it does not import Tawi's Ink application or add a runtime dependency on that checkout.

`native/camera.swift` is new Device Deck code. It discovers AVFoundation inputs by unique ID, emits frames for a selected source, exits after parent loss or capture failure, and writes images to the native Mac clipboard. USB enumeration indexes are never stored as identity.

`native/apple-tv.py` is a small Companion bridge adapted from George's consolidated remote script. It uses pyatv's private per-user credential storage and verifies the selected Companion identifier before input. The daemon owns pairing processes; clients provide a PIN through the session API.

No separate iOS simulator remote script was found in the inspected shell sources. Simulator capture reuses the verified simctl route. Simulator input uses [Meta's idb](https://github.com/facebook/idb), whose [UI command documentation](https://fbidb.io/docs/idb/ui/) describes HID keys, taps and text. Both the official companion and Python client were installed for the dedicated proof simulators.

Device Deck's code remains under the repository's existing proprietary license. Third-party runtime code keeps its original licenses. The package includes dependency license texts. ffmpeg, idb, pyatv and Xcode remain separately installed tools. Mac application distributions include Node with its own license; bundled scrcpy is described below.


## Live Android video and touch

On 16 September 2026, Device Deck added a client for the [scrcpy 4.1 internal protocol](https://github.com/Genymobile/scrcpy/blob/v4.1/doc/develop.md). The client was written against `Streamer.java`, `DesktopConnection.java`, `Options.java`, `Controller.java`, and `app/src/control_msg.c` in that tag. It implements H.264 session/frame parsing and touch messages with exact transport identity and per-source cleanup. No installed desktop scrcpy client is required.

The build bundles the unmodified official [`scrcpy-server-v4.1`](https://github.com/Genymobile/scrcpy/releases/tag/v4.1), licensed under Apache-2.0, with SHA-256 `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`. The pin is recorded in `scripts/distribution/scrcpy.json`; the build verifies it and copies [the upstream license text](../native/scrcpy-LICENSE) into `build/native/scrcpy-LICENSE`. The runtime checks the same digest before starting a source. This third-party server retains its upstream license and is not relicensed as proprietary Device Deck code.

The idb gesture adapter uses the separately installed official client and companion. Its `describe` JSON, tap-duration and swipe commands were checked against [Meta's idb source](https://github.com/facebook/idb/tree/main/idb/cli/commands). The adapter translates video pixels to the reported simulator point dimensions and exposes completed gestures only; it does not bundle idb or claim continuous pointer support. These source checks and protocol tests do not establish new physical-device proof.
