# CLI, HTTP and MCP

Every device operation passes through the daemon. The full input schemas are generated from the running TypeScript contract in [operations.schema.json](operations.schema.json). Configuration uses [device-deck.schema.json](device-deck.schema.json).

Reports default to today in the Mac timezone. See [report ranges and Capture Cards](reports-and-capture-cards.md) for timestamp/count semantics, date-range CLI examples and the `capture-cards.list` operation.

Apple iOS/tvOS simulators and Android AVDs can be launched and closed directly in web Devices or with **O** in TUI Devices. The shared `devices.simulator` operation uses the configured UDID or exact AVD identity, requires confirmation to close, and protects reservations and recordings. See [simulator controls](simulator-controls.md).

The **Wake** button in Devices and the remote attempts to wake a device without reserving it. It sends Android's wake key, Roku TV power-on or a Roku player's Home button, Apple TV power-on, or Home to an already running Apple simulator. Wake can be attempted while a device is reported offline; an unreachable device can still fail, and successful dispatch does not prove the screen is awake. Shut-down simulators must be launched first. Physical iOS devices and capture-only connections do not expose Wake.

The `license.status`, `license.activate`, `license.refresh` and `license.deactivate` operations share the same daemon-owned entitlement state. Free allows one new active session and clean recording; concurrent sessions and recording annotations require a verified license. Existing work keeps its bounded lease when paid access ends. See [licensing commands and policy](licensing-and-billing.md).

## CLI walkthrough

Use `./devdeck` in an unpacked release. From source, use `node build/devdeck.mjs` after `npm run build:local`.

```sh
./devdeck start
./devdeck status
./devdeck discover --json
./devdeck ui
./devdeck devices --platform Android --state free --json
./devdeck remote --device 'Desk TV' --owner George --reason 'Inspect player controls'
```

`remote` with no selector offers an interactive device list. Enter a number or filter text/platform. Arrow keys control the chosen device, Enter selects, `b` goes back, `h` goes home, `t` sends text, `s` saves a screenshot, and `v` toggles recording. `u` renews; `q` asks to release the session and exit. A noninteractive invocation never waits for a picker. Use a unique name or ID in scripts.

The separate `tui` command opens fixed-screen Devices, Feeds, Captures, Sessions, History, Reports, Settings and License menus. Keys 1–8 switch views, arrows select items, Enter opens item actions, and C opens a credential-owned remote. O launches or closes a selected Apple simulator or Android AVD.

```sh
./devdeck reserve --device 'Desk TV' --owner 'Agent A' --reason 'Playback regression' --ttl 15 --json
# Keep session.id and leaseToken from the response in private variables/files.
./devdeck input --session "$SESSION_ID" --lease "$LEASE_TOKEN" --key Right
./devdeck input --session "$SESSION_ID" --lease "$LEASE_TOKEN" --text 'Search terms'
./devdeck screenshot --session "$SESSION_ID" --lease "$LEASE_TOKEN" --clipboard --json
./devdeck record start --session "$SESSION_ID" --lease "$LEASE_TOKEN" --mode annotated --json
./devdeck record stop --session "$SESSION_ID" --lease "$LEASE_TOKEN" --json
./devdeck renew --session "$SESSION_ID" --lease "$LEASE_TOKEN" --ttl 20
./devdeck release --session "$SESSION_ID" --lease "$LEASE_TOKEN"
```

Prefer private scripts or API clients when command arguments would expose a token in terminal history. CLI output contains a token only when acquiring a reservation. Inventory/status do not expose it.

Other operations:

```sh
./devdeck config get
./devdeck config export ./device-deck.json
./devdeck config validate ./device-deck.json
./devdeck config import ./device-deck.json
./devdeck sources --json
./devdeck sessions --json
./devdeck captures --json
./devdeck history --json
./devdeck reports --json
./devdeck lock --device 'Desk TV' --reason 'Cable maintenance'
./devdeck unlock --device 'Desk TV' --reason 'Cabling repaired'
./devdeck restart --device 'Android emulator' --reason 'Reset test state'
./devdeck call devices.simulator '{"deviceId":"SIMULATOR_ID","action":"launch"}'
./devdeck call devices.simulator '{"deviceId":"SIMULATOR_ID","action":"close","confirmed":true}'
./devdeck call devices.wake '{"deviceId":"DEVICE_ID"}'
./devdeck takeover --device 'Desk TV' --owner George --reason 'Previous client abandoned' --yes
./devdeck call captures.edit '{"id":"CAPTURE_ID","name":"Player focus","tags":["regression"]}'
./devdeck call captures.remove '{"ids":["CAPTURE_ID"],"confirmed":true}'
./devdeck call captures.restore '{"ids":["CAPTURE_ID"]}'
./devdeck call captures.purge '{"ids":["CAPTURE_ID"],"confirmed":true}'
./devdeck call captures.openFolder '{}'
```

Trash retains files. Purge accepts only trashed, stopped captures and permanently removes their files and sidecars. Neither metadata names nor tags rename the backing file.

`captures.openFolder` opens the configured capture folder in Finder on the Mac running Device Deck, including when called from a remote browser. It accepts no path and returns `{opened:true,folder:"/resolved/host/path"}`. The folder is created if it does not exist.

`captures.storage` accepts `{}` and reports `{bytes,libraryBytes,trashBytes,files,missingFiles}` for managed capture files. Totals use actual file lengths, count shared paths once, and include clean originals, metadata and annotation sidecars. Purged captures and unrelated files in the folder are excluded.

`GET /v1/artifacts/{id}/thumbnail` returns an authenticated JPEG image up to 480×270 pixels, preserving aspect ratio. Screenshots and recorded video frames use a bounded in-memory cache and encoder pool; no thumbnail sidecars are written. Recording/finalizing captures return 409, and trashed/purged captures return 410. The library requests these small images only near the viewport.

Exit code 0 means success, 1 means service or operation failure, and 2 means invalid command arguments. Validation and ownership errors include a machine-readable error code and message. Unknown/ambiguous device selectors fail explicitly.

## Tailscale access

Run these commands on the Mac hosting Device Deck, with Tailscale installed, signed in and connected:

```sh
./devdeck tailscale enable
./devdeck tailscale status
./devdeck ui --tailscale
./devdeck ui --tailscale --json
./devdeck tailscale disable
```

`enable` configures background Tailscale Serve HTTPS forwarding to the running daemon's loopback port and saves the remote origin and allowed users. First-time setup defaults to the host's Tailscale login. Running `enable` again preserves the saved allowed users and HTTPS port unless options override them. Tailscale may provide a setup link if HTTPS needs enabling for the tailnet. The resulting HTTPS URL can be bookmarked and opened from another connected machine with permission under the tailnet's network policy. It signs the allowed user in without an SSH tunnel or browser ticket.

`ui --tailscale` opens the saved remote URL. Adding `--json` returns the URL without opening a browser. `status` checks the saved configuration and Serve setup. `disable` revokes Device Deck remote access first, then removes the Serve endpoint when it still matches the saved hostname and current daemon backend. If cleanup fails or the route has changed, the command reports that access is disabled and leaves the unmatched route for explicit cleanup.

```sh
./devdeck tailscale enable --allow-user george@example.com,teammate@example.com --https-port 8443
```

`--allow-user` accepts comma-separated exact Tailscale login names and replaces the current allow list; include your own login to retain access. Every allowed user has full access to Device Deck devices, captures, settings and operations. `--https-port` selects the Serve HTTPS port when the default port is already in use.

Serve retains its background configuration across restarts. Keep the daemon's backend port fixed (the default is `47831`; avoid port `0` for remote access). Before changing the daemon port, HTTPS port or hostname, run `disable` while the old daemon is running, then make the change and run `enable` again. Setup refuses an occupied port or a stale backend mapping. Inspect `tailscale serve status` and remove that specific stale route yourself, or disable Device Deck remote access and configure an unused HTTPS port. Other Serve routes are left unchanged.

The optional configuration is:

```json
{
  "tailscale": {
    "origin": "https://device-mac.example-tailnet.ts.net",
    "allowedUsers": ["george@example.com"]
  }
}
```

Use the CLI to manage this configuration together with Serve. The origin must be one canonical HTTPS `ts.net` origin, including a non-default port when used. Each remote request must have the configured origin and an allowed user identity supplied by Serve. Local API tokens and browser cookies do not authorize remote requests. Tagged source devices have no user identity and cannot connect. Use Serve, never Funnel: public Funnel requests have no user identity and are rejected.

## HTTP

Read the private `endpoint.json` under `DEVICE_DECK_HOME`, or its default Application Support folder. It supplies the active port and API token. The server defaults to loopback. `network.host` or `DEVICE_DECK_HOST` enables ordinary IP/port access; optional TLS serves trusted HTTPS. The endpoint file always identifies the native loopback control path. See [remote access](remote-access.md) for configuration and portal pairing.

```http
POST /v1/operations/sessions.reserve
Authorization: Bearer LOCAL_API_TOKEN
Content-Type: application/json

{"selector":{"device":"Desk TV"},"owner":"Agent A","reason":"Playback regression","ttlMinutes":15}
```

Successful response:

```json
{
  "session": {
    "id": "SESSION_ID",
    "deviceId": "DEVICE_ID",
    "sourceId": "SOURCE_ID",
    "owner": "Agent A",
    "reason": "Playback regression",
    "createdAt": 0,
    "expiresAt": 900000,
    "state": "active"
  },
  "leaseToken": "SECRET_LEASE_TOKEN"
}
```

Timestamps above illustrate the shape. Actual timestamps are Unix milliseconds. `leaseToken` is required for `remote.input`, capture, renewal, release and pairing. It is unrelated to the display owner label. The API token permits local administration; the lease token proves which particular reservation is being used.

To control an already reserved device without taking its reservation, authenticated clients can explicitly call `remote.override` with `deviceId`, the current `sessionId`, their display `owner`, `confirmed:true`, and one key, text string or x/y tap. This preserves the reservation's owner, reason, expiry and any active recording. The override is audited, and inputs remain associated with the existing session and recording according to input logging settings. A changed, closing or expired reservation invalidates the override; capture operations still require the reservation's lease token.

`devices.wake` accepts `{deviceId}` for an unreserved device and creates no session. Any reserved device requires a fresh, explicit user choice after warning that waking could interrupt their work, including when the caller holds its lease. Send `{deviceId, sessionId, confirmed:true}` with the expected active reservation. A changed, closing or expired session rejects that confirmation. Maintenance locks are respected, and the request is checked again when it reaches the device's control queue. New reservations and configuration changes wait until the wake attempt finishes. Wake leaves existing reservations and recordings in place, audits the attempt with its API/Web/CLI/Agent origin and current session, and returns `{deviceId, status:"attempted", method, sessionId?}`. `method` describes the command sent; it does not confirm device power state.

| Operation                                                                | Result                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `inventory`                                                              | Local devices, sources, sessions, artifacts, events, input log, diagnostics and reports                    |
| `reports.get`                                                            | Range metadata, reservation overlap and capture/contention totals for the same interval                    |
| `capture-cards.list`                                                     | Detected and configured disconnected USB cards by stable identity, plus diagnostics                        |
| `discover`                                                               | Discovered device/source configurations and per-provider diagnostics; no automatic registration            |
| `config.get`, `config.save`                                              | Configuration and revision; save requires the last read revision                                           |
| `sessions.reserve`                                                       | One exclusive session and secret credential                                                                |
| `sessions.renew`, `sessions.release`                                     | Current session state; repeated release is idempotent                                                      |
| `sessions.takeover`                                                      | Finalize existing session, then acquire with a reason and `confirmed:true`                                 |
| `devices.bulk`                                                           | Per-device lock/unlock/restart success or failure                                                          |
| `devices.wake`                                                           | Platform wake attempt without reserving; reserved devices require their current `sessionId` and `confirmed:true` |
| `streams.open`, `streams.ping`, `streams.close` | Authenticated WebRTC signaling, viewer heartbeat and cleanup |
| `control.start`, `control.pointer`, `control.stop` | Lease-owned scripted touch source, ordered Android pointer input and contact cleanup |
| `remote.gesture` | Completed tap, swipe or long press using encoded-frame coordinates |
| `remote.input`                                                           | One key, text string or x/y tap and dispatch timestamp                                                     |
| `remote.override`                                                        | Explicit remote input for the expected active session without changing its reservation or recording         |
| `pairing.start`, `pairing.finish`                                        | Apple TV PIN pairing owned by the current session; request expires after 120 seconds                       |
| `captures.screenshot`                                                    | Actual file metadata, plus clipboard error if the file saved but clipboard failed                          |
| `recordings.start`                                                       | Recording artifact ID and managed maximum duration                                                         |
| `recordings.stop`                                                        | Completed/interrupted artifact after finalization and validation; repeated stop returns the last recording |
| `captures.edit`, `captures.remove`, `captures.restore`, `captures.purge` | Updated capture metadata and trash state                                                                   |
| `captures.openFolder` | Opens the configured capture folder in Finder on the host Mac; accepts `{}` |
| `captures.storage` | Measures managed files, originals and sidecars, split between library and trash |

Read routes:

- `GET /v1/health`: implementation version, PID and dependency diagnostics.
- `GET /v1/preview/DEVICE_ID`: current PNG/JPEG from the configured source. This authenticated, read-only observation may share another session's stream; it does not grant control.
- `GET /v1/source-preview/SOURCE_ID`: current JPEG from a registered USB capture card, including an unassigned card. Requires the same local authentication. A bound card retains its device's maintenance and closing-session checks. The explicit snapshot fallback uses this endpoint; normal Feeds viewing uses `streams.open` and H.264 over WebRTC. Observation has no reservation requirement.
- `GET /v1/artifacts/ID/file`: original capture or annotated export, with byte-range support for video.
- `GET /v1/artifacts/ID/clean`: clean original when an annotated export exists.
- `GET /v1/artifacts/ID/log`: JSON manifest with identity, outcome and recording-relative input timestamps.
- `GET /v1/artifacts/ID/thumbnail`: JPEG preview of a screenshot or the first decoded recording frame, bounded to 480×270 while preserving aspect ratio. Uses an in-memory cache and returns `409` while a capture is recording/finalizing, or `410` after Trash/Purge. Requires the same authentication as other artifact routes; clients do not need to download the recording to show a thumbnail.

File, clean-original and log routes display inline by default. Append `?download=1` to request an attachment. `Content-Disposition` uses the edited capture name, the file's extension, and `-clean` for clean originals or `-metadata` for logs; Unicode names use `filename*`. Local and portal downloads use the same filename. Downloading does not rename the file on the host. Downloads require the same authentication as previews, retain byte-range support, and reject captures in Trash until restored.

Machine routes require authentication except static UI files, public `/v1/machine` identity, the one-use ticket exchange and the code-plus-signed-token pairing exchange. Portal grants authenticate machine API requests; `/v1/hub/pairing-code`, `/v1/hub/unpair` and browser-ticket creation require a native token over loopback. Every route accessed through the Tailscale origin requires an allowed user identity from Serve. Browser mutation requests also require `X-Device-Deck: local`. Unexpected hosts and origins outside the exact configured allow lists are rejected. Allowed portal origins receive CORS responses for scoped bearer requests. No API token is embedded in the public website or local JS bundle.

Errors use an HTTP status and `{error,message,details?}`. Common codes are `no-match`, `ambiguous-match`, `device-reserved`, `source-reserved`, `device-locked`, `invalid-lease`, `stale-lease`, `config-conflict`, `unsupported-capability`, `capture-failed`, and `cleanup-required`. A failed bulk member appears in that member's result rather than pretending the whole selection succeeded.

## Live video and touch operations

`streams.open` accepts exactly one of `deviceId` or `sourceId`, a complete browser SDP `offer`, and an optional `profile` (`low`, `balanced`, or `high`; default `balanced`). Set `control:true` only with `deviceId`, `sessionId` and its `leaseToken`. View-only streams do not require a reservation. The response is `{id, token, answer, capabilities, width, height, mode}`; `mode` is `live` or `snapshots` for the simulator's limited-refresh source. Keep the stream token private.

Use `{id,token}` with `streams.ping` every five seconds and with `streams.close` when finished. Viewers expire after 15 seconds without a heartbeat. Heartbeats recheck access; the server also checks live access and session validity periodically. Closing a viewer cancels its input and releases unused media resources, but does not release the reservation or stop a recording.

A browser creates a receive-only video transceiver and a reliable, ordered data channel named `control` before producing the offer. It must finish ICE gathering before sending the offer. On that channel, send one of:

```json
{"type":"pointer","event":{"type":"down","contactId":1,"x":120,"y":300,"width":720,"height":1280}}
{"type":"gesture","gesture":{"type":"swipe","x":120,"y":900,"toX":120,"toY":300,"width":720,"height":1280,"durationMs":350}}
{"type":"cancel"}
```

These are separate messages. Pointer types are `down`, `move`, `up` and `cancel`. A contact must go down before moving or going up. Coordinates are in the current encoded video's pixels, not CSS pixels, screen points or the original device's unscaled resolution. Use the current video dimensions; the server rejects stale Android geometry. A swipe adds `toX`, `toY` and `durationMs`; a long press uses `type:"longPress"` and `durationMs`; a tap needs only its position and dimensions. Supported gesture names come from `capabilities`, never from a guessed platform default.

The server sends `ready` with capabilities/dimensions, `geometry` when the source size changes, and `error` for failed control. Cancel local pointer state on geometry changes. Live media needs host UDP ports 49152–49251 over a permitted LAN/Tailscale path; no public STUN/TURN relay is configured. See [live video and touch](live-video-and-touch.md) for setup, profile limits and platform differences.

For scripted gestures, reserve a device first, then use the generic CLI `call` command. Replace the placeholders below with that reservation's values. `control.start` returns the source's current `width`, `height` and supported gestures; adapt every coordinate example to that result.

```sh
./devdeck call control.start '{"sessionId":"SESSION_ID","leaseToken":"LEASE_TOKEN"}'
./devdeck call remote.gesture '{"sessionId":"SESSION_ID","leaseToken":"LEASE_TOKEN","gesture":{"type":"tap","x":120,"y":300,"width":720,"height":1280}}'
./devdeck call remote.gesture '{"sessionId":"SESSION_ID","leaseToken":"LEASE_TOKEN","gesture":{"type":"swipe","x":120,"y":900,"toX":120,"toY":300,"width":720,"height":1280,"durationMs":350}}'
./devdeck call remote.gesture '{"sessionId":"SESSION_ID","leaseToken":"LEASE_TOKEN","gesture":{"type":"longPress","x":120,"y":300,"width":720,"height":1280,"durationMs":800}}'
./devdeck call control.stop '{"sessionId":"SESSION_ID","leaseToken":"LEASE_TOKEN"}'
```

`control.pointer` accepts `{sessionId,leaseToken,event}` with the same pointer event shape as the data channel. It is available only when continuous drag is advertised, currently touchscreen Android. `control.stop` releases its contacts and source without ending the reservation. Scripted input is refused while a browser owns touch control for that session. Opening browser control ends the scripted controller. Idle scripted controllers expire after 15 seconds.

MCP exposes the same operations as `streams_open`, `streams_ping`, `streams_close`, `control_start`, `control_pointer`, `control_stop` and `remote_gesture`. iOS only advertises completed tap/swipe/long-press gestures through idb, and its video source samples screenshots at up to 2 fps. It does not accept continuous drag or multitouch.

## MCP walkthrough

Launch the packaged stdio server using Node 24. Diagnostics go to stderr and protocol messages to stdout.

```json
{
  "mcpServers": {
    "device-deck": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/device-deck/build/mcp.mjs"],
      "env": { "DEVICE_DECK_HOME": "/ABSOLUTE/PATH/TO/LOCAL/STATE" }
    }
  }
}
```

Omit the environment override to use the default Application Support directory. Start the daemon separately. MCP tool names replace operation dots with underscores, for example `sessions_reserve`, `remote_input` and `recordings_stop`.

1. Call `inventory`, then `sessions_reserve` with one selector, owner and reason.
2. Retain its session ID and lease token. Send them to `remote_input` or `captures_screenshot`.
3. `captures_screenshot` returns JSON metadata plus PNG image content for captures up to 8 MB.
4. `recordings_start` returns immediately after recorder readiness. Later call `recordings_stop` and retrieve the artifact path or authenticated file route.
5. Call `sessions_release`. A subsequent command with that credential must return a stale-lease error.

MCP uses the same validation and ownership boundary as HTTP, CLI, TUI and web. Disconnecting it does not end a valid session or recording.

Capture-only devices use `platform: "Other"`, `connection: {"type":"capture"}`, and a required USB `captureSourceId`. They use the normal session and capture operations but expose no remote input capabilities. Browser authentication cookies are scoped by name to the listening port, allowing multiple local profiles to remain open together.
