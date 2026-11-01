# Interactive agent work

Device Deck owns reservations, device control, screenshots, recordings and observations. Native XCTest and Android test suites keep their native drivers and assertions; they use Device Deck to reserve their devices. PR proof workflows consume the resulting evidence separately.

Run `devdeck api` to discover the installed operation schemas. CLI `devdeck call OPERATION JSON`, MCP tools and HTTP all use those same daemon operations. Reserve a device first and retain the session ID and lease token privately. Release the reservation when finished.

| Operation | Purpose |
| --- | --- |
| `devices.capabilities` | Read the selected backend, supported observations and current device health |
| `ui.read` | Read bounded accessibility nodes, labels, values, selection, focus and bounds |
| `logs.read` | Read a bounded historical interval or live developer-console sample |
| `apps.state` | Read installed or foreground app state, where supported |
| `apps.launch` | Launch an installed app through the selected native transport |

All five operations require `sessionId` and `leaseToken`. `ui.read` accepts `maxNodes`, `maxDepth` and an optional exact `selector` for `id`, `label` or `type`. `logs.read` takes its limits inside `options`. `apps.state` accepts an optional `appId`; `apps.launch` requires one and accepts optional `arguments` where supported. Use the generated schemas for field limits.

Responses contain `result` and `observation`. The observation identifies the device, session, backend, start and finish times, and a SHA-256 digest of `JSON.stringify(result)`. It contains no lease token. This metadata associates evidence with a device operation; it is not a signed proof or a test verdict. Save the response alongside captures when a PR needs structured evidence.

UI reads default to 500 visited nodes and depth 20, with maxima of 2,000 nodes and depth 40. Individual strings are limited to 4,096 characters. Missing state is `null`; an absent accessibility node does not prove an element is absent from the rendered screen. Secure text values are masked. Bounds use simulator/iOS points or Android pixels as indicated by `coordinateSpace`. Gesture operations retain their own reported frame dimensions.

| Device transport | Automatic backend | UI | Logs | App state / launch |
| --- | --- | --- | --- | --- |
| iOS / tvOS simulator | idb | Yes | Historical | Yes |
| Physical iPhone / iPad with configured helper | WebDriverAgent | Yes | Unsupported | Yes |
| Android phone / emulator / TV | ADB and scrcpy | Yes | Historical | Yes |
| Roku | ECP and developer console | Unsupported | Live | Yes |
| Physical Apple TV Companion / capture-only | Existing input / capture adapter | Unsupported | Unsupported | Unsupported |

The daemon chooses the backend. There is no per-call override. Simulator input keeps idb, which completed commands faster than WebDriverAgent in the local comparison. Physical iOS requires the [signed WebDriverAgent setup](physical-ios.md). Close physical iOS touch control before launching another app, because touch control owns its WDA automation session. Android and Roku launch arguments are unsupported.

Historical logs default to the preceding minute, with a maximum interval of ten minutes. Reads default to 64 KiB and 500 lines, with maxima of 256 KiB and 2,000 lines. Roku captures new developer-console output for `durationMs`, up to five seconds, and rejects historical timestamps and process filters. Apple `process` filters match an exact process name; Android filters match a log tag. Android timestamps are translated using a sampled device clock, whose offset and uncertainty accompany the result. Common credential fields are redacted, but app log text may still contain sensitive data. Reads never clear shared log buffers. Truncation is explicit.

An unsupported operation returns `unsupported-capability`. A locked Mac desktop is separate from device transport readiness. Check device health and the operation's result through Device Deck before treating the desktop lock as a blocker. Do not use desktop clicking to drive a native device.
