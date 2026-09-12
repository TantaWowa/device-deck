# Readable workspace revision

This records the earlier public demo milestone. See [local application delivery](local-delivery.md) for the subsequent real daemon, clients and capture implementation.

This revision keeps the browser mockup separate from the local service. All device operations, source discovery, sessions, reports and recording files are simulated. It does not import hardware adapters, connect to a visitor's Mac, or change the source inspiration repositories.

## Interaction coverage

- Devices are a table with friendly name, model, platform, physical/virtual type, connection health, maintenance lock, reservation, owner, reason, capture source and local/shared visibility.
- Search combines with platform, health, reserved/free, locked/unlocked, physical/virtual and visibility filters. Counts, reset, built-in views and named saved views work. Selection can span filtered-out rows, with an explicit hidden-selection label.
- Hover or keyboard focus shows a source preview; clicking or tapping opens a modal with a focused-viewer link. Offline and missing-input previews explain why the image is unavailable.
- Capture-source dropdowns use a realistic, explicitly simulated USB discovery list. Native screens apply only to virtual devices. Duplicate USB bindings are rejected without replacing the old binding. Another owner's reservation and an active recording prevent configuration changes.
- Add/edit forms validate names and source choices. Physical Apple devices default to discovery-only input capability. Bulk lock, unlock and restart show eligibility, simulated progress and per-device results. Unlocking maintenance never releases a session.
- Focused and multi-device viewers have one explicit remote target. Other owners, offline devices, maintenance and unsupported input block controls. Keyboard remote input is opt-in and pauses in editable controls. Device input changes the fictional screen, optional overlay and input log.
- Screenshot and recording actions create capture metadata. Recordings snapshot their source, session, folder and clean/annotated mode. Input events retain device, session, recording ID and elapsed milliseconds. Release or expiry finalizes a simulated recording; page reload records an interruption instead of pretending to resume it.
- The capture library filters names/tags, device, type and origin. It supports rename/tag, selection, removal, undo and JSON metadata/log export. History links sessions to their captures.
- Browser clipboard copying creates an actual labelled sample PNG. A rejected or unavailable image clipboard opens a sample PNG download fallback. Clean PNGs omit the input annotation; annotated PNGs include it. Sample labels remain visible. No webpage invokes the proposed macOS clipboard CLI.
- Settings persist the common Mac output-folder preference, naming pattern, owner label, reservation duration, clipboard behavior, input logging and overlay defaults. Device edits, captures, history and saved views also persist in browser localStorage. Reset demo restores the initial samples. No login, accounts, cloud storage or cross-host coordination are added.
- Reports are an explicitly seeded example week with sessions, reserved time, contention and capture failures. They do not claim to measure hardware or current demo actions.

## CLI contract shown in the design

The intended `devdeck remote` command targets a configured device with input capability by friendly name. In an interactive terminal, no target opens a picker with platform, name and state filters. Noninteractive callers use selectors and JSON; zero matches returns `no-match`, multiple matches returns `ambiguous-match` with candidates. Neither case silently chooses a device or waits for a prompt.

All remote, reservation, capture, API and MCP operation examples are labelled illustrative. The existing implemented CLI remains `status` and `devices --json`, backed by the read-only service. MCP continues to expose the same health and empty inventory. Owner labels are not credentials.

## Source alignment

The prior reuse map remains applicable. This revision reread Tawi's resource-policy matching and Hosanna Tools' video-capture documentation read-only. Capability selection informs the device filters; native simulator capture versus AVFoundation USB capture informs the separate device/source controls. No runtime dependency on those repositories or personal filesystem paths was introduced.

## Validation

Run `npm run check`, `npm test`, `npm run build`, and `PLAYWRIGHT_CHANNEL=chrome npm run qa` against the combined build on port 5175. Set `QA_URL` for the deployed preview and `QA_OUTPUT` for evidence output.

The model suite covers combined filters, eligibility, source conflicts, add/edit validation, owner restrictions, expiry, input targeting and elapsed time, source failures, capture editing/removal/undo, settings persistence, recording interruptions and fixed recording metadata. Browser QA covers the corresponding UI flows, actual clipboard PNG writing, the download fallback, navigation, native dialog dismissal, marketing links/assets and overflow at 390, 768 and 1440 pixels.

Public marketing screenshots are actual renders of the revised prototype. They are flat, contain no private device addresses and retain the simulation labels.
