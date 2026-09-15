# Device Deck

Version 0.5.0-beta.1 adds simulator launch/close controls, a Mac application and team installer, real Device Deck Keygen activation, verified update downloads, and automated purchase-to-license issuance. Start with [team deployment](docs/team-rollout.md), [Mac packaging](docs/macos-distribution.md), and [licensing and billing](docs/licensing-and-billing.md).

A local Mac workspace for connected TV devices and simulators. The daemon owns reservations, remote input, capture processes and files. The web app, CLI, terminal UI and MCP use the same authenticated operations.

The public website includes a separate simulated demo. It never connects to the local daemon. The local app has no sample devices and needs no account login.

## Install the Mac application

Use the team `.pkg` from the release operator, then open `/Applications/Device Deck.app`. It includes Node and the native helper. Run `devdeck version`, `devdeck doctor`, `devdeck ui`, or `devdeck tui`; `devdeck service install` enables launch at login. Recording and USB screenshots currently need `brew install ffmpeg`. Team builds use TEST licenses and an unsigned installer; signed/notarized public builds use LIVE licenses. See [installation and update details](docs/macos-distribution.md).

## Build from source

Requires macOS 14 or later, Node 24 or later, and Xcode command line tools to build the capture helper. The downloadable package already contains that helper for its named architecture.

```sh
npm ci
npm run build:local
node build/devdeck.mjs init
node build/devdeck.mjs start
node build/devdeck.mjs ui
```

From an unpacked release, use `./devdeck` instead of `node build/devdeck.mjs`. Keep the unpacked folder at a stable location before installing the login service.

```sh
./devdeck install      # Start at login
./devdeck status
./devdeck logs
./devdeck stop
./devdeck uninstall    # Remove the login service, retain config and captures
```

`start` runs the daemon in the background. `npm run service` runs it in the foreground for development. Closing a browser, CLI or MCP connection leaves recordings running. Release, takeover, expiry, the recording duration limit or service shutdown finalize them.

## Reports and capture cards

Reports offer Day, Week, Month and inclusive custom date ranges. The same range applies to every metric and device row; CLI and MCP can request it too. Capture Cards shows detected and disconnected USB cards, stable hardware IDs, ownership and direct device assignment. See [range and binding semantics](docs/reports-and-capture-cards.md).

For a Mac mini, console or another HDMI device, open **Capture Cards → Assigned device → Custom device…**, type its name and choose **Create & assign**. The device appears in Devices and on its feed, with screenshot and recording support through the selected card. For an existing capture-only device, the same option renames it and preserves its history. Remote control requires a supported connection configured separately.

## First device session

The Devices list has Apple, Roku, Android and USB-only filter buttons, plus Sim / Real buttons. Click an active filter again to clear it; less common filters are under **More filters**.

### Feed controls and compact remotes

Every feed and device row has Identify, Record, Screenshot, Reserve and Remote actions. Identify labels the local preview and shows the capture card's stable identity. Record and Screenshot open quick capture settings; an available device can be reserved and captured with one button.

Remote opens a small floating panel over the workspace. Drag its title bar anywhere, resize its lower-right corner, and keep watching the feeds underneath. Its position and size are remembered per device in that browser. The menu contains reservations, capture settings, device configuration and remote style. The first key or text sent to an available device reserves it using the menu's owner and reason. An occupied device requires an explicit takeover; stopping or ending an active recording saves the file first.

Enable **Keyboard input** to send arrows, Enter, Space, B (Back), H (Home), R (Rewind), F (Forward), P (Replay) and S (Special). Escape exits keyboard mode. While keyboard input is off, the feed viewer keeps its navigation shortcuts. Use the text field for text entry.

Roku, Fire TV, Android TV, Apple TV, Samsung and LG visual styles are available. Keys follow the device's configured adapter; a style does not add a control connection. Samsung and LG network adapters are not implemented. Fire TV control requires authorized ADB. USB inputs without a target get a capture-only device on first use of a session action, so screenshot and recording work without network control. Edit that device to add its control connection later.

### Watch capture feeds

Open **Feeds** to watch registered USB inputs without reserving a device. Choose inputs using the checkboxes, then select **Split screen** or **Single feed**. Left/Right switches the selected feed, 1–9 opens a feed, G toggles the grid and F toggles fullscreen. These keys browse pictures; use the device viewer for remote input. The URL retains the layout and selected cards across reloads.

```sh
./devdeck feeds                         # Names, connection state and stable IDs
./devdeck view --mux                    # All connected registered USB feeds
./devdeck view --sources ugreen-1,ugreen-2,usb-video --mux
./devdeck view                         # One picture, Left/Right through the feeds
./devdeck view --source ugreen-1        # Just one named card or stable ID
./devdeck view --device 'Roku Ultra'    # That device's paired USB feed
./devdeck view --mux --json             # Return a one-use browser URL without opening it
```

`--browser` is accepted explicitly; browser viewing is the default. Source names must match uniquely, so use IDs when multiple cards have the same name. `--sources` accepts a comma-separated list and preserves its order. A selected disconnected card remains visible as disconnected. Viewing newly detected cards registers their stable hardware IDs without assigning a TV. With no selection, configured USB cards are preferred; if none are configured, connected external inputs are selected, which can include USB webcams.

The feed viewer refreshes at up to 10 fps with silent video. It shares each card's native stream with previews and recordings. Actual refresh rate depends on the Mac, USB bandwidth and HDMI signal. A connected card can still output a black picture or a “No Signal” slate when its HDMI source is sleeping or disconnected. Bound cards retain device maintenance and session-release checks.

### Control a device

1. Open Devices and select **Discover / add devices**. Select several devices and choose **Add selected**, or use **Add all** to register every new device that is ready. Already configured devices are skipped.
2. Devices use their discovered names, with numbers added for duplicates, and native capture screens are connected automatically. Edit individual names or USB capture bindings afterward as needed. Roku and physical Apple TV input use the network; their video needs an explicitly paired USB capture card.
3. Open the viewer and reserve the device with an owner label and a reason.
4. Send supported keys or text, take a screenshot or start recording.
5. Stop recording, open the resulting file in Captures, and release the device.

The CLI picker offers the same workflow:

```sh
./devdeck devices --platform Apple
./devdeck remote --device 'Desk TV' --reason 'Check the playback menu'
./devdeck tui
```

The TUI uses a fixed terminal screen with **Devices, Feeds, Captures, Sessions, History, Reports, Settings, and License** menus. Use **1–8** to switch views, **Tab** to move between the menu and items, and **↑/↓** or **J/K** to select. **Enter** opens the selected item's actions; each view shows its action keys along the bottom. **PgUp/PgDn** and **Home/End** move through long lists. It fits an 80×24 terminal and adds a side detail pane in wider windows.

In Devices, **O** launches or closes the selected supported simulator; the web device row has the same controls. Active reservations and recordings must be finished before closing it. See [simulator lifecycle details](docs/simulator-controls.md).

In Devices, **F** chooses platform and Sim/Real filters, **/** searches, and **D** discovers devices. Discovery supports **Space** to select, **A** for all available devices, and **Enter** to add them together. In Feeds, select sources with **Space** and press **G** for a browser split screen, or **W** for one feed.

**C** opens a device remote, **R** reserves it, **S** takes a screenshot, and **V** starts or stops recording. Inside the remote, arrows and **Enter** control the device; **B** is Back, **H** is Home, **Space** is Play/Pause, **[ / ]** seek, **P** replays, **\*** sends Special, and **T** opens text entry. **Esc** returns to the workspace while keeping your reservation. **Q** asks to release this TUI's reservations and save their recordings before quitting. Taking over another client's session requires confirmation. Forced termination leaves reservations to expire at their configured TTL.

For scripts, `reserve --json` returns a session ID and secret lease token. Every control/capture command requires both. See [CLI, API and MCP](docs/api.md) for complete examples.

## Platform adapters

| Target                                 | Input                               | Preview / screenshot / recording   | Setup                                                        |
| -------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Roku                                   | ECP keys and Unicode text           | Explicit USB input                 | Network ECP must permit control; stable Roku serial required |
| Android, Android TV, Fire TV, emulator | ADB keys, tap, printable ASCII text | Native ADB or explicit USB input   | ADB authorization; configurable server port                  |
| iOS and tvOS simulator                 | idb keys, tap and text              | Native simctl                      | Booted simulator, Xcode; idb for input                       |
| USB capture only                       | No remote input                     | USB preview, screenshot, recording | Stable capture card identity                                 |
| Physical Apple TV                      | Companion keys and text             | Explicit USB input                 | pyatv and PIN pairing                                        |
| Other physical Apple devices           | Discovery only                      | No native adapter                  | No unsupported operation is advertised                       |

Native Android recordings stop at 175 seconds, below screenrecord's 180-second limit. Other sources use the configured limit. Preview refreshes about once a second and is labelled accordingly. USB preview and recording share one capture-helper stream selected by stable AVFoundation unique ID, never enumeration index. Capture video is silent in this release.

The verified hardware matrix, real proof files and limits are recorded in [validation](docs/validation.md). Implemented adapter paths do not imply that every device model has been tested.

## Dependencies

ADB is needed for Android, ffmpeg and ffprobe for video validation and annotations. The native USB and clipboard helper is included in the release. Simulator input uses the separately installed [official idb client and companion](https://github.com/facebook/idb). Physical Apple TV uses [pyatv](https://pyatv.dev/).

```sh
brew install android-platform-tools ffmpeg facebook/fb/idb-companion
python3 -m venv ~/.local/share/device-deck-tools
~/.local/share/device-deck-tools/bin/pip install fb-idb pyatv
```

Set absolute `tools.adb`, `tools.idb` and `tools.python` paths in Settings when those executables are outside the daemon's PATH. `devdeck apple-pair --device 'Desk Apple TV'` starts a credential-owned session and asks for the displayed PIN. Pairing is also available through `pairing.start` and `pairing.finish` in API and MCP.

## Configuration and local access

By default, runtime files live under `~/Library/Application Support/Device Deck/`. `DEVICE_DECK_HOME` changes that directory. `DEVICE_DECK_CONFIG` can select a different configuration file, and `DEVICE_DECK_PORT` overrides the configured port. Port zero requests an available port. Port changes apply after the daemon restarts.

- `config.json`: editable, versioned operator settings. Relative capture folders resolve beside this file.
- `state.sqlite`: transactional reservations, locks, capture metadata and event history.
- `endpoint.json`: current loopback port and private API token. CLI and MCP discover the daemon here.
- `daemon.log`: service diagnostics.

Files containing credentials use owner-only permissions. `devdeck ui` opens a short-lived, single-use browser ticket. The browser gets an HttpOnly, SameSite cookie. The API rejects unexpected Host/Origin headers and unauthenticated mutations. Owner names are labels, not credentials. All clients run as the same Mac user; this is not isolation against another process with access to that user's files.

Configuration saves serialize the revision check and atomic rename. Invalid external edits preserve the last valid running configuration. Active devices and capture bindings cannot change. Missing/reordered USB inputs never fall back to a different card. When recording cleanup cannot be verified, its reservation stays `closing`; reconnect the device and retry release or takeover.

Captures use a shared local output folder. Renaming changes library metadata while retaining file identity. Trash is reversible and retains files. **Delete files permanently** removes the selected trashed captures, clean originals and sidecars. Disabling input logging prevents new keys and text from entering SQLite or manifests; existing logs remain.

## Workspace

| Location            | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `apps/website`      | Public marketing website                             |
| `apps/web`          | Isolated public demo and real local web entry        |
| `apps/daemon`       | HTTP server and application service                  |
| `apps/cli`          | Scriptable commands and interactive picker           |
| `apps/tui`          | Separate terminal UI                                 |
| `packages/core`     | Shared contracts, selectors and clients              |
| `packages/config`   | JSON validation and atomic editing                   |
| `packages/adapters` | Discovery, identity checks and input                 |
| `packages/capture`  | Preview streams, screenshots and recorder lifecycle  |
| `packages/mcp`      | MCP tools over daemon operations                     |
| `packages/ui`       | Shared branding and visual tokens                    |
| `native`            | Mac capture/clipboard and Apple TV Companion helpers |

The source adaptation map is in [source provenance](docs/source-provenance.md). Tawi and Hosanna Tools are source material, not runtime dependencies. Their checkouts were not modified.

## Develop and validate

For hardware development with an explicitly labelled local Pro mock:

```sh
npm ci
npm run build:local
npm run install:dev-cli   # Install devdeck in ~/.local/bin
./devdeck start
./devdeck license status --json
./devdeck view --mux
./devdeck stop
```

The repository-root `./devdeck` wrapper uses the ignored `work/local-deck/` profile and starts `scripts/service-local.ts` with real adapters and an explicitly labelled, active Pro mock. `npm run service:local` runs that same daemon in the foreground. Each development start resets the mock to active; it makes no Keygen or Lemon Squeezy calls. After `npm run install:dev-cli`, use `devdeck` from any directory with `~/.local/bin` on your PATH. `./devdeck` also works from the checkout. `DEVICE_DECK_HOME` can select another development profile.

The normal `node build/devdeck.mjs` launcher and packaged releases continue using the real license manager and the standard user profile. The development mock is not part of their bundles. The repository wrapper is for local start/stop, not login-service installation. macOS Camera permission must be enabled for the application that launches the capture helper; when launched from Codex, macOS may list that application as “ChatGPT.” Hardware IDs for cards without serial numbers can change when moved to another USB port; rediscover and confirm the picture before rebinding.

```sh
npm run check
npm test
npm run schema
npm run build:local
npm run package:local
npm run build           # Public website plus isolated /demo/
npm run dev             # Marketing site on 5173
npm run dev:app         # Public demo on 5174
```

The static Firebase preview remains in the existing `tantawowa-device-deck` project. Only `dist/` is hosted. Never deploy the local `build/`, runtime directory, capture files or private endpoint credentials to Firebase. The separate [billing service](apps/billing/README.md) has its own deployment and secrets.

Copyright 2026 TantaWowa. All rights reserved. Dependency licenses are included in the release's `THIRD_PARTY_NOTICES.txt`.
