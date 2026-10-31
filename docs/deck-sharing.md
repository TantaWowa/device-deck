# Share devices and capture cards between Macs

A local Device Deck can connect to another Deck. The local dashboard, CLI and MCP
send operations through the local daemon to the selected host. USB capture stays
on the Mac the card is plugged into. That host owns reservations, expiry, remote
input, recordings and the capture library. A second client, including one running
on the host itself, cannot reserve an already-held device or capture source.

Both Macs need a version supporting Deck sharing. The host needs a reachable
Device Deck address, using the existing network or Tailscale access setup. Use
HTTPS, a trusted private network or an SSH tunnel. Do not send access tokens over
an untrusted HTTP connection. WebRTC video also requires direct UDP connectivity
between the viewing browser and the host, as described in [live video](live-video-and-touch.md).

## Connect ms2 to ms

On `ms`, grant access and write the credential to a private file:

```sh
devdeck decks grant ms2 --output /private/path/ms2-access.json
```

Transfer that file privately to `ms2`, for example with SCP. On `ms2`:

```sh
devdeck decks add ms --address https://HOST-ADDRESS --token-file /private/path/ms2-access.json
devdeck decks list
devdeck ui --deck ms
```

Replace the address with the host's actual reachable origin, including its port
if needed. Adding a connection checks authentication and machine identity.
Self-connections and duplicate machines or names are rejected. After connection,
the transfer file can be deleted. The daemon retains its private credential in
`deck-connections.json`, separate from exported configuration. List operations
never return credentials. The host stores a hash of each granted credential.

In the local dashboard, choose **Device host → ms**, then use **Capture Cards**,
**Feeds**, **Devices** and **Captures** normally. Switching hosts loads a fresh
workspace and isolates saved lease credentials. Existing reservations and
recordings continue on their host until released or expired. The local dashboard
address stays unchanged apart from the `deck` query parameter. Multiple tabs can
show different hosts. This release does not combine their inventories into one
table or make an atomic reservation across several hosts.

## CLI and MCP

```sh
devdeck feeds --deck ms --json
devdeck devices --deck ms --json
devdeck reserve --deck ms --device 'Roku Ultra' --owner George --reason 'Playback check' --json
devdeck screenshot --deck ms --session "$SESSION_ID" --lease "$LEASE_TOKEN" --json
devdeck download "$CAPTURE_ID" --deck ms --output ./screenshot.png
devdeck record start --deck ms --session "$SESSION_ID" --lease "$LEASE_TOKEN" --mode clean --json
devdeck record stop --deck ms --session "$SESSION_ID" --lease "$LEASE_TOKEN" --json
devdeck release --deck ms --session "$SESSION_ID" --lease "$LEASE_TOKEN"
```

Use the same `--deck` for every operation on a reservation. The screenshot and
recording metadata contain paths on the host; `download` writes the file to this
Mac and refuses to overwrite an existing file. Group credential files retain
their Deck selection and refuse use against a different Deck. The environment
variable `DEVICE_DECK_TARGET=ms` sets the default for CLI, TUI, MCP and the bundled
JavaScript client. `--deck local` explicitly selects the local Mac.

MCP exposes `decks_list`. Existing operation tools accept an optional `deck`
argument, for example `capture-cards_list` with `{"deck":"ms"}`. Pass it with
the session ID and lease token for capture, control, renewal and release.
`captures_screenshot` retrieves the remote PNG and returns the usual inline image.

## Access and failures

A grant permits access to the host's device inventory, captures and normal device
operations. It is not a per-device role or export filter. Configuration edits
cannot change network trust, executable tools or the capture directory. Licensing,
connection management and issuing new grants remain host-local. A connected Deck
cannot forward access onward to the host's other Deck connections.

Create, remove and grant connections through the local CLI. Browser and portal
clients cannot create trust relationships. To revoke access immediately on `ms`:

```sh
devdeck decks grants
devdeck decks revoke GRANT_ID
```

Revocation rejects subsequent operations and invalidates live stream authorization.
It does not steal or release reservations; the host's normal TTL and recording
cleanup still apply. On `ms2`, `devdeck decks remove ms` removes the saved
connection but does not revoke its host grant or end host sessions. Reconnect to
finish existing work, or let its bounded lease expire.

An unreachable host produces an explicit failure. The local daemon never claims
a local device as a substitute, and it never automatically replays a mutation.
If the connection breaks after dispatch, the host may have completed the request.
Inspect its inventory and use the original lease before retrying. Independent
macOS accounts keep separate configuration, tokens and reservations.

## Verification

`npm test` includes two-daemon tests for host-owned leases and contention, input,
capture bytes and ranged downloads, recording finalization, stale credentials,
revocation, private storage, blocked trust changes and offline behavior. It also
launches real CLI and MCP processes against the isolated daemons.

`PLAYWRIGHT_CHANNEL=chrome npm run qa:decks` exercises the production local UI
against two daemons with inert adapters. It checks host selection, reservation
ownership, lease isolation across switches, mobile layout and revoked-host recovery.
The images in `outputs/deck-sharing` are fixtures, not physical-device evidence.
