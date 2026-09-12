# Local application architecture

The daemon is authoritative. Web, CLI, TUI and MCP send the operations defined in `packages/core/src/local/types.ts`. The browser demo imports none of these adapters and never discovers localhost.

## State and configuration

Operator configuration lives in versioned JSON. `packages/config` validates stable identity, unique friendly names and source binding rules, then serializes read/revision-check/write transactions. Atomic writes use a private temporary file, fsync and rename. External edits are validated when the next snapshot/config request arrives; invalid changes preserve the running configuration. Changing an idle preview's configuration closes its source stream before accepting the new mapping.

Runtime state lives in SQLite with WAL, a busy timeout and immediate reservation transactions. Partial unique indexes prohibit two non-closed reservations for one logical device or canonical source identity. Lease credentials are random 256-bit values; only hashes are stored with sessions. Inventory never returns those credentials. Owner labels cannot authorize anything.

The service marks a session `closing` synchronously before waiting for its device queue. Subsequent input fails immediately. Queued operations revalidate before execution. Recorder finalization and source cleanup complete before a successor can reserve. On restart, persisted worker identities are checked before signalling processes. Unverifiable remote cleanup keeps the reservation closing, visible and unavailable.

Maintenance locks are distinct from reservations. Maintenance on a reserved device returns a per-device failure. A restart temporarily establishes a maintenance lock before awaiting adapter I/O.

## Capture ownership

Each device has a command queue. Different devices can work concurrently. A logical device and its video source are separate records. USB sources use stable AVFoundation unique IDs; native screens belong to their own device. Ambiguous bindings are rejected.

USB preview, screenshots and recording consume one helper stream per physical source. The web preview uses periodic images. Native simulator screenshots and videos use simctl; ADB uses screencap/screenrecord. Android's exact child PID is captured from stdout immediately at process creation. Its UUID-specific command identity is rechecked before signalling it.

Native simulator recordVideo can omit elapsed time while a screen is static. Finalization repeats the last real frame to the requested stop time, preserving the source picture and input timeline. A partial playable file after an unexpected exit remains interrupted. USB disconnects end encoder input and trigger session cleanup.

Clean captures contain only source pixels. Annotated exports preserve the clean original and burn an ASS key overlay into a separate output. JSON manifests retain device/session/source identity, status, capture timing and recording-relative dispatch timestamps. Input text is stored only when logging is enabled.

Recordings belong to the daemon, so client disappearance does not stop them. Lease expiry, explicit stop/release/takeover, duration limit and service shutdown do. File removal is a two-step library trash and explicit disk purge operation.

## Range reports and card inventory

Report requests resolve calendar dates in the daemon Mac timezone. A shared aggregator clips reservation intervals and counts timestamped captures/contention for one range. SQLite supplies complete durable rows, independently of the truncated event history. Capture Cards merges configured and detected USB sources by hardware identity and uses the same revision-checked configuration save as Devices. See [report and assignment semantics](reports-and-capture-cards.md).

## Local access

The server binds `127.0.0.1`. A private endpoint file contains its port, PID and API token. CLI and MCP read that file. A local command obtains a one-use browser ticket; the browser exchanges it for an HttpOnly SameSite cookie. Host/Origin checks, a required custom mutation header and JSON-only request bodies protect browser access.

The threat boundary is the Mac user. This release does not provide accounts, multi-host coordination or protection from a process already able to read that user's private files. Shared visibility is a label, not a network listener.

## Licensing

`packages/licensing` verifies online Keygen responses and signed, time-bound proof against compiled account/product/policy trust. The daemon enforces Free admission inside the reservation transaction and checks paid recording/renewal operations. Entitlement loss preserves already-running work through its original bounded lease. Clients never select a tier. The separate Lemon Squeezy bridge updates registered Keygen licenses and is excluded from customer bundles. See [licensing and billing](licensing-and-billing.md) for trust, expiry and deployment limits.

## Distribution

The local build bundles the Node entry points and browser assets, plus the Mac helper for the build architecture. The package runs without source checkouts or npm at runtime, using Node 24 and the configured external platform tools. A per-user launchd job runs the daemon at login. The independent website build produces only static marketing and demo assets for the existing Firebase preview.
