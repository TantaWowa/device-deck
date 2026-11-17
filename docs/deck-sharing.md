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

## Connect a CI runner

The `actions/connect-deck` GitHub Action installs a host grant in the local Deck
of the account running the job. A repeat run checks authenticated access through
the saved connection. The runner needs a working Device Deck daemon and CLI.

### Supply a host grant

Choose a trusted private CI repository and a protected environment. Pin the
action revision and the host address in workflow configuration controlled by
maintainers. A host grant permits device and capture operations across the host's
inventory. Only trusted jobs should receive it.

An agent with SSH access to the host's Deck owner and permission to set the CI
secret can transfer a dedicated grant directly. Replace the example values
below. If the host uses a custom Deck profile, set `DEVICE_DECK_HOME` in the
remote command to the profile that owns the devices.

```bash
set -euo pipefail
set +x
ci_repository='example-org/private-device-tests'
ci_environment='device-lab'
grant_secret='DEVICE_DECK_CI_GRANT'
host_ssh='deck-owner@device-host.example.com'
umask 077
transfer=$(mktemp -d)
trap 'rm -rf "$transfer"' EXIT

ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes "$host_ssh" \
  'bash -se' >"$transfer/grant.json" <<'HOST'
set -euo pipefail
set +x
umask 077
grant_directory=$(mktemp -d "${TMPDIR:-/tmp}/device-deck-ci-grant.XXXXXX")
trap 'rm -rf "$grant_directory"' EXIT
'/Applications/Device Deck.app/Contents/MacOS/devdeck' decks grant ci-device-tests \
  --output "$grant_directory/grant.json" >/dev/null
cat "$grant_directory/grant.json"
HOST
gh secret set "$grant_secret" --repo "$ci_repository" --env "$ci_environment" <"$transfer/grant.json"
```

Both shells remove their private transfer directories on exit. Run the snippet as a script. If the upload fails, use
`devdeck decks grants` and revoke the new grant before retrying.

### Run the action

Put this job in the private CI repository. Set `DEVICE_DECK_ADDRESS` in the
chosen environment to the host's HTTPS origin. Replace `REVIEWED_COMMIT_SHA`
with the full SHA of the reviewed Device Deck revision.

```yaml
name: Connect device lab
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  connect:
    runs-on: [self-hosted, macOS, device-lab]
    environment: device-lab
    steps:
      - uses: TantaWowa/device-deck/actions/connect-deck@REVIEWED_COMMIT_SHA
        with:
          name: lab
          address: ${{ vars.DEVICE_DECK_ADDRESS }}
          grant: ${{ secrets.DEVICE_DECK_CI_GRANT }}
          cli: /Applications/Device Deck.app/Contents/MacOS/devdeck
```

The optional `cli` input selects an executable, including an account-specific
wrapper. It defaults to `DEVICE_DECK_CLI` when set, then to `devdeck` on PATH.
The `grant` input contains the JSON produced by the host. A working, matching
connection can be verified without it. Device jobs can then use the usual
[group reservation flow](group-reservations.md).

A different origin or a revoked credential fails verification. To rotate the
credential, finish outstanding leases, remove the connection in the runner
account, provide a fresh dedicated grant, and rerun the action. Revoke the old
grant on its host after rotation. Removing a CI secret alone leaves the saved
connection usable until its host grant is revoked.

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
