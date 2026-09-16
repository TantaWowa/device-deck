# Device Deck

Version 0.5.0-beta.1 adds simulator launch/close controls, a Mac application and team installer, real Device Deck Keygen activation, verified update downloads, and automated purchase-to-license issuance. Start with [team deployment](docs/team-rollout.md), [Mac packaging](docs/macos-distribution.md), and [licensing and billing](docs/licensing-and-billing.md).

A local Mac workspace for connected TV devices and simulators. The daemon owns reservations, remote input, capture processes and files. The web app, CLI, terminal UI and MCP use the same authenticated operations.

The public website includes a separate simulated demo. It never connects to the local daemon. The local app has no sample devices and needs no account login.

## Install the Mac application

Use the team `.pkg` from the release operator, then open `/Applications/Device Deck.app`. It includes Node and the native helper. Run `devdeck version`, `devdeck doctor`, `devdeck ui`, or `devdeck tui`; `devdeck service install` enables launch at login. Recording, USB live video, simulator video and USB screenshots currently need `brew install ffmpeg`. Team builds use TEST licenses and an unsigned installer; signed/notarized public builds use LIVE licenses. See [installation and update details](docs/macos-distribution.md).

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

## Open Device Deck from another machine

Connect the Mac running Device Deck and your other machine to Tailscale, then run this on the Device Deck Mac:

```sh
devdeck tailscale enable
```

Open the HTTPS address printed by the command on your other machine. Bookmark it for later; Tailscale signs you in automatically, with no SSH tunnel or one-use login link. Both machines must be connected to the same tailnet, and its network policy must permit the connection. Device Deck stays local until you enable this option.

First-time setup allows only the Mac's Tailscale user to connect. To allow additional users, give their exact Tailscale login names:

```sh
devdeck tailscale enable --allow-user george@example.com,teammate@example.com
devdeck tailscale status
devdeck ui --tailscale --json   # Print the remote URL without opening a browser
devdeck tailscale disable
```

An explicit allow list replaces the current list, so include your own login when adding someone else. Running `enable` again without options preserves your saved users and HTTPS port. Allowed users have full Device Deck control, including devices, captures and settings. **Settings → Remote access** shows the saved address and allowed users.

Setup uses Tailscale Serve to provide HTTPS within your tailnet. It may ask you to enable HTTPS for your tailnet. Use `--https-port PORT` during setup if another Serve app already occupies the default HTTPS port. Serve keeps its setup across restarts when Device Deck's backend port stays fixed. Before changing either port, disable Tailscale access while the old daemon is running, make the change, then enable access again. Existing conflicting or stale Serve routes require explicit cleanup. Use Serve, never Tailscale Funnel: public requests and requests from tagged source devices have no user identity and are rejected. See the [Tailscale command reference](docs/api.md#tailscale-access) for details.

## Reports and capture cards

Reports offer Day, Week, Month and inclusive custom date ranges. The same range applies to every metric and device row; CLI and MCP can request it too. Capture Cards shows detected and disconnected USB cards, stable hardware IDs, ownership and direct device assignment. See [range and binding semantics](docs/reports-and-capture-cards.md).

Capture Cards uses compact rows with a single **Assigned device** button. Its popup combines family (Roku, Android, Apple, Other), class (TV, Phone, Tablet, Computer, Other), physical/simulator and text filters. Choose a listed device to save immediately, or select **Family → Other**, type a name such as **Mac mini**, and choose **Create & assign**. For an existing capture-only device, **Save name** preserves its identity and history. Hardware details are expandable; remote control requires a supported connection configured separately.

## First device session

The Devices list keeps platform, Sim / Real, connection, availability and visibility filter buttons visible beside a compact name search. Click an active filter again to clear it. Click a data-column heading to sort ascending, then click again to reverse the order; selected devices stay selected when the order changes.

### Feed controls and compact remotes

Every feed and device row has Identify, Record, Screenshot, Reserve and Remote actions. Identify labels the local preview and shows the capture card's stable identity. Record and Screenshot open quick capture settings; an available device can be reserved and captured with one button.

Remote, Record, Screenshot, Reserve and Identify open above the clicked button, moving below or inward when needed to fit the screen. Drag the remote’s title bar anywhere, resize its lower-right corner, and keep watching the feeds underneath. Its size is remembered per device in that browser; each new action opens beside the button you just clicked. The menu contains reservations, capture settings, device configuration and remote style. The first key or text sent to an available device reserves it using the menu's owner and reason. An occupied device requires an explicit takeover; stopping or ending an active recording saves the file first.

Keyboard input activates when the remote has focus; its indicator shows when it owns the keys. Clicking elsewhere or typing in a text field releases it. **Escape** pauses keyboard control until you focus or click the remote again. Hover a remote key for its name and shortcut. Arrows, Enter, Space, B (Back), H (Home), R (Rewind), F (Forward), P (Replay), S (Special) and Backspace highlight their matching buttons when pressed. Rapid inputs are sent in order without flashing or disabling the whole handset. Use the text field to send text.

Roku, Fire TV, Android TV, Apple TV, Samsung and LG visual styles are available. Keys follow the device's configured adapter; a style does not add a control connection. Samsung and LG network adapters are not implemented. Fire TV control requires authorized ADB. USB inputs without a target get a capture-only device on first use of a session action, so screenshot and recording work without network control. Edit that device to add its control connection later.

### Watch capture feeds

Open **Feeds** to watch connected inputs without reserving a device. **Choose feeds** opens a searchable list; select the screens you want, then use **Split screen** or **Single feed**. **Start simulator → Launch & show feed** starts a configured Apple simulator or Android emulator and opens its feed when ready. Use **Remote** for buttons, or **Start control session** on a touchscreen feed. The floating remote contains controls only; video stays in the feed. Left/Right switches feeds, 1–9 opens a feed, G toggles the grid and F toggles fullscreen. The URL retains the layout and selected feeds across reloads.

```sh
./devdeck feeds                         # Names, connection state and stable IDs
./devdeck view --mux                    # All connected registered USB feeds
./devdeck view --sources ugreen-1,ugreen-2,usb-video --mux
./devdeck view                         # One feed, Left/Right through the feeds
./devdeck view --source ugreen-1        # Just one named card or stable ID
./devdeck view --device 'Roku Ultra'    # That device's paired USB feed
./devdeck view --mux --json             # Return a one-use browser URL without opening it
```

`--browser` is accepted explicitly; browser viewing is the default. Source names must match uniquely, so use IDs when multiple cards have the same name. `--sources` accepts a comma-separated list and preserves its order. A selected disconnected card remains visible as disconnected. Viewing newly detected cards registers their stable hardware IDs without assigning a TV. With no selection, configured USB cards are preferred; if none are configured, connected external inputs are selected, which can include USB webcams.

The feed viewer receives silent H.264 video over WebRTC, up to the USB capture limit of 15 fps. It shares each card's native capture with previews and recordings. Select **Low bandwidth** for a slower remote connection. Actual frame rate depends on the Mac, USB bandwidth, HDMI signal and network. A connected card can still output a black picture or a “No Signal” slate when its HDMI source is sleeping or disconnected. Bound cards retain device maintenance and session-release checks. See [live video and touch](docs/live-video-and-touch.md) for quality profiles, touch support and the additional UDP connectivity needed over Tailscale.

### Screenshots and recordings

**Screenshot to clipboard** saves the screenshot and copies its image to the computer running your browser, including when connected over Tailscale. Use the Tailscale HTTPS address or localhost and allow browser clipboard access. **Copy image** in a screenshot preview copies an existing capture. The separate Settings option still controls automatic copying to the host Mac clipboard.

Finished screenshots and recordings show a toast with a link to their preview. This includes recordings stopped by session expiry or other automatic finalization. **Captures** provides a searchable table with device, platform and type filters; click a column heading to sort. Select rows to move them to trash, then restore or permanently delete them from Trash. Active recordings cannot be deleted. Storage totals include managed media, clean originals and metadata; moving to trash does not free disk space.

Use the download button on a row or in its preview. **Open folder on Mac** opens Finder on the machine hosting Device Deck. In the preview, use **← / →** or the previous/next buttons to browse the current filtered, sorted list. Name and tag fields retain normal text-editing arrow keys.

### Control a device

1. Open Devices and select **Discover / add devices**. Select several devices and choose **Add selected**, or use **Add all** to register every new device that is ready. Already configured devices are skipped.
2. Devices use their discovered names, with numbers added for duplicates, and native capture screens are connected automatically. Edit individual names or USB capture bindings afterward as needed. Roku and physical Apple TV input use the network; their video needs an explicitly paired USB capture card.
3. Open the viewer and reserve the device with an owner label and a reason.
4. Send supported keys or text, touch a supported Android/iOS device screen, take a screenshot or start recording.
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
| Android, Android TV, Fire TV, emulator | ADB keys/text; scrcpy gestures on touchscreen devices | Native H.264 live video; native or USB capture | Authorized ADB; Android 5+ for live video; pinned server bundled |
| iOS and tvOS simulator                 | idb keys/text; iOS tap, swipe and long press | Limited-refresh video from simctl screenshots; native recording | Booted simulator, Xcode; idb client and companion for input |
| USB capture only                       | No remote input                     | USB preview, screenshot, recording | Stable capture card identity                                 |
| Physical Apple TV                      | Companion keys and text             | Explicit USB input                 | pyatv and PIN pairing                                        |
| Other physical Apple devices           | Discovery only                      | No native adapter                  | No unsupported operation is advertised                       |

Native Android recordings stop at 175 seconds, below screenrecord's 180-second limit. Other sources use the configured limit. Live previews use browser video elements. Android touch includes continuous drag and multitouch when advertised; iOS touch supports completed gestures over a preview sampled up to twice a second. An explicit view-only snapshot fallback is available when video cannot connect. USB preview and recording share one capture-helper stream selected by stable AVFoundation unique ID, never enumeration index. Capture video is silent in this release.

The verified hardware matrix, real proof files and limits are recorded in [validation](docs/validation.md). Implemented adapter paths do not imply that every device model has been tested.

## Dependencies

ADB is needed for Android; ffmpeg provides USB/simulator live encoding, and ffmpeg plus ffprobe provide video validation and annotations. Source builds fetch and verify the pinned scrcpy 4.1 server; release builds bundle it with its Apache-2.0 license. The native USB and clipboard helper is included in the release. Simulator input uses the separately installed [official idb client and companion](https://github.com/facebook/idb). Physical Apple TV uses [pyatv](https://pyatv.dev/).

```sh
brew install android-platform-tools ffmpeg facebook/fb/idb-companion
python3 -m venv ~/.local/share/device-deck-tools
~/.local/share/device-deck-tools/bin/pip install fb-idb pyatv
```

Set absolute `tools.adb`, `tools.idb` and `tools.python` paths in Settings when those executables are outside the daemon's PATH. `devdeck apple-pair --device 'Desk Apple TV'` starts a credential-owned session and asks for the displayed PIN. Pairing is also available through `pairing.start` and `pairing.finish` in API and MCP.

## Configuration and local access

By default, runtime files live under `~/Library/Application Support/Device Deck/`. `DEVICE_DECK_HOME` changes that directory. `DEVICE_DECK_CONFIG` can select a different configuration file, and `DEVICE_DECK_PORT` overrides the configured port. `DEVICE_DECK_HOST` overrides the listening address (loopback by default). Port zero requests an available port. Port changes apply after the daemon restarts.

- `config.json`: editable, versioned operator settings. Relative capture folders resolve beside this file.
- `state.sqlite`: transactional reservations, locks, capture metadata and event history.
- `endpoint.json`: current loopback port and private API token. CLI and MCP discover the daemon here.
- `daemon.log`: service diagnostics.

Files containing credentials use owner-only permissions. `devdeck ui` opens a short-lived, single-use browser ticket. The local browser gets an HttpOnly, SameSite cookie. Optional Tailscale access checks the exact configured HTTPS origin and the allowed user's identity on every request. The API rejects unexpected Host/Origin headers and unauthenticated mutations. Owner names are labels, not credentials. Operations run as the daemon's Mac user; this is not isolation against another process with access to that user's files.

Configuration saves serialize the revision check and atomic rename. Invalid external edits preserve the last valid running configuration. Active devices and capture bindings cannot change. Missing/reordered USB inputs never fall back to a different card. When recording cleanup cannot be verified, its reservation stays `closing`; reconnect the device and retry release or takeover.

Captures use a shared local output folder. Renaming changes library metadata while retaining file identity. Trash is reversible and retains files. **Delete files permanently** removes the selected trashed captures, clean originals and sidecars. Disabling input logging prevents new keys and text from entering SQLite or manifests; existing logs remain.

## Remote machines and the web portal

Use `devdeck network enable --host 0.0.0.0 --port 47831` for ordinary IP/port access through your own network. The new `/app/` PWA provides Google and email/password login, a private machine list, direct feeds and phone-friendly remotes. [Remote access and deployment](docs/remote-access.md) explains launch links, pairing, HTTPS and deployment to the existing Firebase project.

## Workspace

| Location            | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `apps/website`      | Public marketing website                             |
| `apps/web`          | Isolated public demo and real local web entry        |
| `apps/portal`       | Signed-in machine registry PWA and mobile remotes     |
| `apps/cloud`        | Firebase-authenticated Cloud Run registry API         |
| `packages/machine-client` | Direct browser-to-machine transport and grants |
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
npm run build           # Website, isolated /demo/, and /app/ PWA
npm run build:cloud     # Cloud Run registry API
npm run dev             # Marketing site on 5173
npm run dev:app         # Public demo on 5174
```

The Firebase website and portal use the existing `tantawowa-device-deck` project. Only `dist/` is hosted; the authenticated registry API runs separately on Cloud Run. Never deploy the local `build/`, runtime directory, capture files or private endpoint credentials to Firebase. The separate [billing service](apps/billing/README.md) has its own deployment and secrets.

Copyright 2026 TantaWowa. All rights reserved. Dependency licenses are included in the release's `THIRD_PARTY_NOTICES.txt`.
