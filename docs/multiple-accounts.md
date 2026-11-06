# Separate development and CI instances

Run one Device Deck daemon under each macOS account that owns simulators.
Each daemon has its own configuration, endpoint credentials, reservations and
device inventory. Consumers execute their own builds and tests under that same
account. Device Deck manages device reservations and lifecycle.

Set `DEVICE_DECK_HOME` in the account's startup environment. The daemon reads
`config.json` in that directory; `DEVICE_DECK_CONFIG` can select an external file.
The client reads its daemon's authenticated endpoint from `DEVICE_DECK_HOME`.
Do not share endpoint tokens or home directories between accounts.

For example, the development instance can use port 47831 and CI port 47832:

```json
{
  "schemaVersion": 1,
  "port": 47832,
  "settings": { "folder": "./captures", "owner": "ci-runner" }
}
```

The dashboard and API share the configured port and bind to localhost by default.
`DEVICE_DECK_PORT` overrides the configured port; `0` chooses an available port.
Use fixed ports for bookmarks. A port already in use fails startup instead of
connecting to a different instance. Use `devdeck ui` in the owning account for
authenticated browser access. Bare localhost URLs may require authentication.

For non-GUI runner startup, set `DEVICE_DECK_HEADLESS=1` and invoke the packaged
`Device Deck.app/Contents/MacOS/devdeck start`. This uses the bundled Node runtime
without LaunchServices. Android launches in this mode use software rendering
and no emulator window, so the runner needs no GUI login. This does not grant USB capture
permissions or camera attribution under a headless account.

For Android, give CI a separate `ANDROID_ADB_SERVER_PORT` and private
`ANDROID_USER_HOME`/`ANDROID_AVD_HOME`. Set `ADB_SERVER_SOCKET` to the same server.
The SDK files can be shared read-only. Disable automatic emulator scans and mDNS
auto-connect in the CI ADB server environment when isolating account transports.
Keep the server and emulator processes under their owning account.

Physical devices and USB cards remain shared hardware. Configure a dedicated
device/card only in its assigned instance; separate daemon reservations do not
coordinate access to the same physical hardware.

## Free access
All features are free. The legacy monetization configuration is accepted for compatibility but has no effect.
