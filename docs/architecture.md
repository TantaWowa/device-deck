# Local application architecture

The daemon is authoritative. Web, CLI, TUI and MCP send the operations defined in `packages/core/src/local/types.ts`. The browser demo imports none of these adapters and never discovers localhost.

## State and configuration

Operator configuration lives in versioned JSON. `packages/config` validates stable identity, unique friendly names and source binding rules, then serializes read/revision-check/write transactions. Atomic writes use a private temporary file, fsync and rename. External edits are validated when the next snapshot/config request arrives; invalid changes preserve the running configuration. Changing an idle preview's configuration closes its source stream before accepting the new mapping.

Runtime state lives in SQLite with WAL, a busy timeout and immediate reservation transactions. Partial unique indexes prohibit two non-closed reservations for one logical device or canonical source identity. Lease credentials are random 256-bit values; only hashes are stored with sessions. Inventory never returns those credentials. Owner labels cannot authorize anything.

Reservation groups persist one credential hash and their member/startup metadata. Selection solves one distinct-device assignment before an immediate transaction claims all member devices and canonical sources. Offline virtual members are started only after that commit. Group release first marks and maintenance-locks the whole set, closes sessions and capture work, restores only group-started simulators, then removes the locks. Expiry, preparation rollback, restart recovery and explicit release share this cleanup path. The client creates and persists the group credential before dispatch so a lost success response cannot create an ownerless lease.

The service marks a session `closing` synchronously before waiting for its device queue. Subsequent input fails immediately. Queued operations revalidate before execution. Recorder finalization and source cleanup complete before a successor can reserve. On restart, persisted worker identities are checked before signalling processes. Unverifiable remote cleanup keeps the reservation closing, visible and unavailable.

Maintenance locks are distinct from reservations. Maintenance on a reserved device returns a per-device failure. A restart temporarily establishes a maintenance lock before awaiting adapter I/O.

## Capture ownership

Each device has a command queue. Different devices can work concurrently. A logical device and its video source are separate records. USB sources use stable AVFoundation unique IDs; native screens belong to their own device. Ambiguous bindings are rejected.

USB preview, screenshots and recording consume one helper stream per physical source. Web previews receive H.264 over WebRTC. Android live video comes from scrcpy; iOS simulator live video comes from idb and is normalized for browser decoding. Simulator screenshots and recordings use simctl; ADB screenshots and recordings use screencap/screenrecord. The tvOS live source remains sampled screenshots with an explicit limited-refresh label. Android's exact child PID is captured from stdout immediately at process creation. Its UUID-specific command identity is rechecked before signalling it.

Native simulator recordVideo can omit elapsed time while a screen is static. Finalization repeats the last real frame to the requested stop time, preserving the source picture and input timeline. A partial playable file after an unexpected exit remains interrupted. USB disconnects end encoder input and trigger session cleanup.

Clean captures contain only source pixels. Annotated exports preserve the clean original and burn an ASS key overlay into a separate output. JSON manifests retain device/session/source identity, status, capture timing and recording-relative dispatch timestamps. Input text is stored only when logging is enabled.

Recordings belong to the daemon, so client disappearance does not stop them. Lease expiry, explicit stop/release/takeover, duration limit and service shutdown do. File removal is a two-step library trash and explicit disk purge operation.

## Range reports and card inventory

Report requests resolve calendar dates in the daemon Mac timezone. A shared aggregator clips reservation intervals and counts timestamped captures/contention for one range. SQLite supplies complete durable rows, independently of the truncated event history. Capture Cards merges configured and detected USB sources by hardware identity and uses the same revision-checked configuration save as Devices. See [report and assignment semantics](reports-and-capture-cards.md).

## Browser and API access

The server defaults to `127.0.0.1`. Optional `network.host` (or `DEVICE_DECK_HOST`) binds an ordinary IP or all interfaces, with optional TLS and explicit Host/Origin allow lists. A private endpoint file contains its port, PID and API token. CLI and MCP read that file. A local command obtains a one-use browser ticket; the browser exchanges it for an HttpOnly SameSite cookie. Host/Origin checks, a required custom mutation header and JSON-only request bodies protect browser access.

Optional Tailscale access uses Serve as an HTTPS reverse proxy to that loopback listener. `devdeck tailscale enable` records one canonical HTTPS `ts.net` origin and an explicit allow list of Tailscale user login names in the optional `tailscale` configuration. The first setup defaults to the host's Tailscale user; subsequent setup preserves saved users and the HTTPS port unless overridden. Serve runs in the background and retains its proxy configuration across restarts. Its backend port must stay fixed; disable access before changing ports, then enable it again. The CLI refuses conflicting or stale Serve routes rather than overwriting them. Disabling revokes Device Deck access first and removes the Serve endpoint only when its hostname and backend still match.

Remote requests must arrive over the local proxy connection for that exact configured origin and contain an allowed Tailscale user identity. The daemon checks this identity on every request; remote access does not use local browser tickets or cookies. Tailscale Serve supplies authenticated identity headers and strips client-supplied versions. Requests without user identity, including tagged source devices and public Funnel traffic, are rejected. Tailnet network policy still controls whether a client can reach Serve. Allowed users receive full Device Deck control, including configuration and capture access.

When Tailscale access is enabled, local processes that can reach the loopback listener are trusted. They can impersonate Serve, including processes run by another OS user; this does not provide per-OS-user isolation. This release has no per-device user roles; the separate portal provides an account-owned machine registry. Shared visibility is a label. Enabling Tailscale grants full daemon access to the configured users.

## Connected Decks

`DeckConnections` owns named outgoing connections and hashed incoming access grants
in private `deck-connections.json`. The HTTP server authenticates local clients,
then proxies the selected `/v1/decks/NAME/v1/...` operation or media route. The host
executes the existing service operation against its own SQLite ledger and capture
engine. No local shadow reservations, capture workers or distributed lock protocol
are created. Media downloads stream through the local daemon with byte ranges;
WebRTC signaling is forwarded while video travels directly from host to browser.

Explicit token authentication takes precedence over browser/Tailscale identity,
so revoking a Deck grant cannot fall back to browser authorization. Grants cannot
manage trust, change host tool paths or forward through another Deck. A lost
response is reported without mutation retries or local fallback. CLI and MCP
select a host explicitly; the browser reloads on host switches and stores leases
under separate keys. See [Deck sharing](deck-sharing.md) for setup and lifecycle.

## Cloud portal

The `/app/` PWA uses Firebase Auth and the Cloud Run registry in `apps/cloud`. Firestore stores account-owned machine addresses and public identities. Pairing requires a one-use code issued locally and a receipt signed by the machine. The host pins the configured portal key and validates separate 60-second, machine-scoped grants. Firebase ID tokens never go to machines. The cloud does not probe, proxy or tunnel machine traffic; feeds, artifacts and commands travel directly between browser and daemon. Stable machine IDs and in-memory grants isolate clients on machine switches. See [remote access](remote-access.md) for deployment, browser HTTPS requirements and revocation bounds.

## Licensing

`packages/licensing` verifies online Keygen responses and signed, time-bound proof against compiled account/product/policy trust. The daemon enforces Free admission inside the reservation transaction and checks paid recording/renewal operations. Entitlement loss preserves already-running work through its original bounded lease. Clients never select a tier. The separate Lemon Squeezy bridge updates registered Keygen licenses and is excluded from customer bundles. See [licensing and billing](licensing-and-billing.md) for trust, expiry and deployment limits.

## Distribution

The local build bundles the Node entry points and browser assets, plus the Mac helper for the build architecture. The package runs without source checkouts or npm at runtime, using Node 24 and the configured external platform tools. A per-user launchd job runs the daemon at login. The independent website build produces marketing, demo and portal assets for Firebase Hosting. The cloud registry is built and deployed separately; local daemon bundles contain no cloud credentials.
