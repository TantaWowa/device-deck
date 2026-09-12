# Report ranges and Capture Cards

Device Deck 0.3.0 adds calendar report ranges and a dedicated Capture Cards page to the real local app and isolated public demo.

## Report intervals

Reports default to Day, meaning today on the daemon's Mac. D, W and M have Day, Week and Month accessible labels and tooltips. Week runs Monday through Sunday. Month uses the current calendar month. The selected dates and timezone are visible. A custom range accepts two YYYY-MM-DD calendar dates, including both endpoint dates. The browser remembers its selection locally. The public demo uses its own browser preference and timezone.

The daemon resolves a selection to local midnight at the start date and local midnight after the end date. The resulting timestamp interval includes its start and excludes its end. Calendar arithmetic uses local dates, so a daylight-saving day can contain 23 or 25 hours. A custom range rejects missing bounds, nonexistent calendar dates and an end before its start. Future periods return an empty report. Reports refresh every ten seconds; the response includes the refresh timestamp.

All summary numbers, device rows and duration meters use this one interval. SQL reads the durable session, artifact and contention records; report totals never come from the history page's 2,000-event window.

| Measure              | Definition                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions used        | Number of reservations with positive time overlapping the interval, including reservations that began before it. A reservation spanning several queried periods appears in each applicable report.                                                                                            |
| Reserved time        | Sum of overlap between each reservation and the selected interval, ending at its actual `endedAt` or the report's `asOf` for an ongoing reservation. Future time is excluded. Closing/cleanup time remains reserved until the session closes; planned lease expiry is not projected as usage. |
| Capture attempts     | Capture records whose `createdAt` falls in the interval. For a recording this is its start time. Recording and finalizing jobs count as attempts.                                                                                                                                             |
| Failed / interrupted | The subset of those attempts whose latest stored status is failed or interrupted. A later failure remains attributed to the capture's start date. This is not a count by failure-completion date.                                                                                             |
| Contention events    | Recorded `contention` events whose event timestamp falls in the interval. These are transactional reservation rejections, including an occupied device/source or maintenance lock. Input, discovery and unrelated errors are excluded.                                                        |

Trashed and permanently purged capture rows remain in reporting. Renames use the current configured device name; removed devices retain their ID in historical rows. Reservation intervals are exclusive per device. Demo reports use dated fixture rows plus simulated actions; they never measure real hardware.

## API, CLI and MCP

`reports.get` accepts an optional preset of `day`, `week`, `month` or `custom`. Omit the preset with a start/end pair to infer custom. Presets other than custom reject explicit date bounds. A response includes `range.preset`, `range.start`, `range.end`, `range.startMs`, exclusive `range.endMs`, `range.asOf`, and `range.timeZone`, plus totals and per-device counts/durations. `inventory.reports` uses the default Day range.

```sh
./devdeck reports --json
./devdeck reports --range week --json
./devdeck reports --range month --json
./devdeck reports --start 2026-09-01 --end 2026-09-12 --json
./devdeck call reports.get '{"preset":"custom","start":"2026-09-01","end":"2026-09-12"}'
```

HTTP uses `POST /v1/operations/reports.get`. The MCP tool is `reports_get` with the same input. Invalid ranges return a validation error or `invalid-range`, HTTP 400. The generated operation schemas describe the input fields.

## Capture Cards

The page lists external USB video inputs detected through AVFoundation, plus configured USB sources that are disconnected. Built-in cameras and native emulator/simulator screens are excluded. macOS can also expose USB webcams as external video inputs; it does not reliably identify which USB video devices have an HDMI socket. The page explains this and leaves selection to the operator.

Discovery matches stable hardware `uniqueId`, preserving a configured source's ID, name and device binding when names or enumeration order change. Newly detected cards appear unassigned. Missing configured cards remain visible. A discovery error leaves configured records visible with a diagnostic. Discover / refresh repeats enumeration; while open, the page refreshes every ten seconds.

Each card shows connection, hardware ID, assigned device, reservation owner/reason, recording state and relevant unavailable state. Its device link opens the viewer. Select an available configured device and Apply assignment, or use Unassign. Reassigning a card clears the previous device binding in the same configuration save. A target that already has another input shows a conflict and must first have that input unassigned. Reserved or recording devices cannot change bindings, including a session owned by the current operator.

Assignments use the existing revision-checked `config.save` operation. The service validates both affected devices and source exclusivity before saving JSON. The Devices table and Capture Cards page read the same binding. Unassigning keeps the configured hardware record, so it remains visible if disconnected. Native screens continue to be configured through Devices.

`capture-cards.list` returns `{sources, diagnostics}` without registering devices or changing bindings. CLI can call it directly; MCP exposes `capture-cards_list`.

```sh
./devdeck call capture-cards.list '{}'
./devdeck config export ./device-deck.json
# Edit device.captureSourceId and source records, then validate and import.
./devdeck config validate ./device-deck.json
./devdeck config import ./device-deck.json
```

## Validation boundary

Service/model tests cover local calendar/DST boundaries, custom inclusion and validation, ongoing/crossing reservations, untruncated event totals, removed capture counts, hardware-ID merges and assignment persistence/conflicts. Browser fixtures cover all presets, saved custom ranges, invalid/empty states, matching API counts, reserved controls, assignment/unassignment/reassignment, Devices selector consistency, rediscovery/reload persistence, viewer links and responsive layouts.

The card screenshots using fixture devices are labelled as fixtures. No physical capture stream or device input was used for this update. Physical capture-card permissions, video and disconnect/reorder behavior remain unverified on hardware.
