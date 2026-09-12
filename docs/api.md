# CLI, HTTP and MCP

Every device operation passes through the daemon. The full input schemas are generated from the running TypeScript contract in [operations.schema.json](operations.schema.json). Configuration uses [device-deck.schema.json](device-deck.schema.json).

Reports default to today in the Mac timezone. See [report ranges and Capture Cards](reports-and-capture-cards.md) for timestamp/count semantics, date-range CLI examples and the `capture-cards.list` operation.

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

`remote` with no selector offers an interactive device list. Enter a number or filter text/platform. Arrow keys control the chosen device, Enter selects, `b` goes back, `h` goes home, `t` sends text, `s` saves a screenshot, `c` copies a screenshot, and `r` toggles recording. `u` renews; `q` explicitly releases and exits. A noninteractive invocation never waits for a picker. Use a unique name or ID in scripts.

The separate `tui` command opens the full terminal inventory with owner/reason, selection, filtering, maintenance, history and capture access. Enter opens a credential-owned remote session.

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
./devdeck takeover --device 'Desk TV' --owner George --reason 'Previous client abandoned' --yes
./devdeck call captures.edit '{"id":"CAPTURE_ID","name":"Player focus","tags":["regression"]}'
./devdeck call captures.remove '{"ids":["CAPTURE_ID"],"confirmed":true}'
./devdeck call captures.restore '{"ids":["CAPTURE_ID"]}'
./devdeck call captures.purge '{"ids":["CAPTURE_ID"],"confirmed":true}'
```

Trash retains files. Purge accepts only trashed, stopped captures and permanently removes their files and sidecars. Neither metadata names nor tags rename the backing file.

Exit code 0 means success, 1 means service or operation failure, and 2 means invalid command arguments. Validation and ownership errors include a machine-readable error code and message. Unknown/ambiguous device selectors fail explicitly.

## HTTP

Read the private `endpoint.json` under `DEVICE_DECK_HOME`, or its default Application Support folder. It supplies the OS-assigned port and API token. The server always binds loopback.

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

Timestamps above illustrate the shape. Actual timestamps are Unix milliseconds. `leaseToken` is required for input, capture, renewal, release and pairing. It is unrelated to the display owner label. The API token permits local administration; the lease token proves which particular reservation is being used.

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
| `remote.input`                                                           | One key, text string or x/y tap and dispatch timestamp                                                     |
| `pairing.start`, `pairing.finish`                                        | Apple TV PIN pairing owned by the current session; request expires after 120 seconds                       |
| `captures.screenshot`                                                    | Actual file metadata, plus clipboard error if the file saved but clipboard failed                          |
| `recordings.start`                                                       | Recording artifact ID and managed maximum duration                                                         |
| `recordings.stop`                                                        | Completed/interrupted artifact after finalization and validation; repeated stop returns the last recording |
| `captures.edit`, `captures.remove`, `captures.restore`, `captures.purge` | Updated capture metadata and trash state                                                                   |

Read routes:

- `GET /v1/health`: implementation version, PID and dependency diagnostics.
- `GET /v1/preview/DEVICE_ID`: current PNG/JPEG from the configured source. This authenticated, read-only observation may share another session's stream; it does not grant control.
- `GET /v1/artifacts/ID/file`: original capture or annotated export, with byte-range support for video.
- `GET /v1/artifacts/ID/clean`: clean original when an annotated export exists.
- `GET /v1/artifacts/ID/log`: JSON manifest with identity, outcome and recording-relative input timestamps.

All routes require local authentication except static local UI files and the one-use ticket exchange. Browser mutation requests also require `X-Device-Deck: local`. Cross-origin and unexpected-host requests are rejected. No API token is embedded in the public website or local JS bundle.

Errors use an HTTP status and `{error,message,details?}`. Common codes are `no-match`, `ambiguous-match`, `device-reserved`, `source-reserved`, `device-locked`, `invalid-lease`, `stale-lease`, `config-conflict`, `unsupported-capability`, `capture-failed`, and `cleanup-required`. A failed bulk member appears in that member's result rather than pretending the whole selection succeeded.

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
