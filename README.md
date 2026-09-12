# Device Deck

A local Mac workspace for connected TV devices and simulators. The daemon owns reservations, remote input, capture processes and files. The web app, CLI, terminal UI and MCP use the same authenticated operations.

The public website includes a separate simulated demo. It never connects to the local daemon. The local app has no sample devices and needs no account login.

## Run the local app

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

## First device session

1. Open the local dashboard and select **Discover**.
2. Register one target, give it a unique friendly name and choose its capture source. Roku and physical Apple TV input use the network. Their video needs an explicitly paired USB capture card.
3. Open the viewer and reserve the device with an owner label and a reason.
4. Send supported keys or text, take a screenshot or start recording.
5. Stop recording, open the resulting file in Captures, and release the device.

The CLI picker offers the same workflow:

```sh
./devdeck devices --platform Apple
./devdeck remote --device 'Desk TV' --reason 'Check the playback menu'
./devdeck tui
```

For scripts, `reserve --json` returns a session ID and secret lease token. Every control/capture command requires both. See [CLI, API and MCP](docs/api.md) for complete examples.

## Platform adapters

| Target                                 | Input                               | Preview / screenshot / recording | Setup                                                        |
| -------------------------------------- | ----------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| Roku                                   | ECP keys and Unicode text           | Explicit USB input               | Network ECP must permit control; stable Roku serial required |
| Android, Android TV, Fire TV, emulator | ADB keys, tap, printable ASCII text | Native ADB or explicit USB input | ADB authorization; configurable server port                  |
| iOS and tvOS simulator                 | idb keys, tap and text              | Native simctl                    | Booted simulator, Xcode; idb for input                       |
| Physical Apple TV                      | Companion keys and text             | Explicit USB input               | pyatv and PIN pairing                                        |
| Other physical Apple devices           | Discovery only                      | No native adapter                | No unsupported operation is advertised                       |

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

The static Firebase preview remains in the existing `tantawowa-device-deck` project. Only `dist/` is hosted. Never deploy the local `build/`, runtime directory, capture files or private endpoint credentials to Firebase. Billing and cloud services are outside this release.

Copyright 2026 TantaWowa. All rights reserved. Dependency licenses are included in the release's `THIRD_PARTY_NOTICES.txt`.
