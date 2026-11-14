# Launch and close simulators

Registered Apple iOS/tvOS simulators and Android AVDs have **Launch sim** and **Close sim** actions directly in the web Devices list. Launch boots the configured virtual device and waits for readiness. Close shuts down only that virtual device.

CI and agent orchestration should use a [reservation group](group-reservations.md) rather than launching first and reserving later. The daemon atomically claims the whole device/source set, then uses an internal credential-owned lifecycle path to start its stopped virtual members. Public `devices.simulator` continues to reject reserved devices, preventing an unrelated caller from changing a session's simulator state.

In `devdeck tui`, select **Devices**, select a simulator, and press **O**. The same action appears in the item's **Enter** menu. The list shows stopped, launching, running, and closing states. Closing requires confirmation.

If you hold a reservation, the confirmation offers to end your session and save its recording before closing. A session owned by another client must be explicitly managed and ended first. The daemon rejects launch or close while any reservation for that simulator remains active or closing, and blocks new reservations while its state is changing.

For Apple, Xcode and the selected iOS/tvOS runtime must already be installed. Use **Discover** to register available simulators. Missing runtimes are reported as unavailable; selecting a similar device name never substitutes a different simulator. Device Deck uses its configured UDID for each command and attempts to open the Simulator window from the selected Xcode installation. Window presentation is best-effort: a headless macOS session or a concurrent launch can prevent `Simulator.app` from opening even though CoreSimulator booted the device successfully. In that case the launch succeeds and returns a warning, so CI reservations can still use the ready simulator. iOS live video uses `idb video-stream` and ffmpeg. Screenshots, recordings and the limited-refresh tvOS feed use `simctl`. Apple controls and iOS live video need `idb` and `idb_companion`.

If a runner stores its CoreSimulator device set on a mounted volume, host bootstrap owns that storage lifecycle: mount it before CoreSimulator and Device Deck start, restart any CoreSimulator service that started before the mount, and validate the configured simulator data directories. Device Deck does not mount storage or restart CoreSimulator. It treats a `simctl` entry whose `dataPath` is omitted, non-absolute, nonexistent, or not a directory as unavailable and will not claim lifecycle ownership or attempt to boot it.

For Android, create the AVD in Android Studio first. **Discover** lists both running emulators and installed AVDs that are stopped. Select multiple or **Add all** to register them. Device Deck uses the existing SDK emulator executable from **Settings → Adapter executables → emulator**, Android SDK environment variables, standard SDK paths, or `PATH`. It does not install an SDK or system images. The AVD name comes from `emulator -list-avds` or a running emulator's exact `adb -s SERIAL emu avd name` response. When that console response is empty or unavailable, Device Deck reads `ro.boot.qemu.avd_name` from the same exact ADB serial. Empty or invalid identities remain blocked. These commands use the Android SDK's [launch](https://developer.android.com/studio/run/emulator-commandline) and [console](https://developer.android.com/studio/run/emulator-console) interfaces.

An Android device's optional `connection.avdName` is its persistent virtual-device identity. Launch uses `emulator -avd NAME`; after boot, Device Deck finds the actual ADB serial belonging to that AVD. New remote, screenshot and recording operations resolve that serial again, so another emulator reusing an old serial is not selected. A recording retains its resolved transport for its lifetime. Duplicate running instances with the same AVD name are reported as ambiguous.

Existing serial-only emulator entries can close their exact running emulator once its AVD identity is readable. Lifecycle and reservation preflight learn and save that verified AVD name, rejecting duplicate registered identities. A stopped serial-only entry needs its AVD name set in **Edit device** before Launch is available. If an emulator is still booting or its identity is unreadable, wait and refresh; a launch timeout leaves its process running. Physical devices do not have simulator lifecycle controls.

For custom Android storage, run `devdeck start` or `devdeck service install` from a shell with the intended `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME` and `ANDROID_AVD_HOME` values. The packaged launcher forwards these paths through LaunchServices, and service installation saves them for later logins. Reinstall the login service after changing those paths. Set absolute `tools.adb` and `tools.emulator` paths in Settings because the packaged app uses its own executable search path.

Scripts and MCP use the same operation:

```sh
devdeck call devices.simulator '{"deviceId":"YOUR_CONFIGURED_SIMULATOR_ID","action":"launch"}'
devdeck call devices.simulator '{"deviceId":"YOUR_CONFIGURED_SIMULATOR_ID","action":"close","confirmed":true}'
```

The MCP tool is `devices_simulator`. Successful responses include `deviceId`, `action`, `state` (`booted` or `shutdown`) and `changed`; Android launch also returns its resolved `serial`. Repeating launch does not reboot an already running virtual device, and repeating close on a stopped device succeeds without another shutdown. Apple launch also attempts to bring its Simulator window forward. If only that presentation step fails, the successful response includes a `warning`; simulator lifecycle and readiness remain successful.

## Warm pool

Booting a simulator or emulator from cold takes time, so Device Deck keeps the
virtual devices it starts running after their reservation ends. When a
[reservation group](group-reservations.md) that cold-started a device is
released or expires, the device stays booted and joins the warm pool. It is
unlocked straight away, and the next reservation that matches it uses it without
another boot (its `startedByGroup` is `false`, as for any device that was
already running).

Only devices that Device Deck itself started are ever in the pool. A simulator
you booted from Xcode, or an emulator you started yourself, is never shut down
by the pool. Closing a pool device with **Close sim** removes it from the pool.
Stopping or restarting the daemon leaves pool devices running, and the pool is
remembered across restarts.

The pool shuts a device down only when it is not reserved, not locked, has no
open viewer and is not already starting or closing, and one of these applies:

1. **Idle**: it has not been used for `idleMinutes` (default 240).
2. **Pool limit**: more virtual devices are booted than `maxBooted`. Every
   booted simulator and emulator counts, including ones the pool does not own,
   but only pool devices are shut down, least recently used first.
3. **Memory pressure**: macOS reports memory pressure
   (`sysctl -n kern.memorystatus_vm_pressure_level`). At the critical level
   one pool device is shut down per minute. At the warning level one is shut
   down only after two checks in a row report a warning. If the level cannot be
   read it counts as normal.

The pool checks these rules every minute and after each group release. Each
shutdown is logged as a `simulator-close` event that names the reason.

A request whose selector has `"state": "offline"` still gets a cold start. Device Deck uses a device that is already shut
down when one matches. Otherwise it shuts down a matching idle pool device and
boots it again for the reservation, which then reports `startedByGroup: true`.
A running device that is not in the pool is never restarted this way.

Configure the pool under `settings.warmPool` in the config file:

```json
"warmPool": { "enabled": true, "idleMinutes": 240, "maxBooted": 4, "memoryPressure": true }
```

All fields are optional. `maxBooted` defaults to one booted device per 6 GB of
the Mac's memory, with a minimum of two. Set `"enabled": false` to shut
cold-started devices down on release, as earlier versions did; devices
already in the pool are then shut down at the next check.

## Capture while the Mac is locked

A macOS desktop-control failure does not establish that simulator capture or input
is unavailable. Keep the existing reservation and try the device transport first:
Device Deck screenshots and recordings, `idb` accessibility/input, and `simctl io`
operate on the simulator rather than its macOS window. Do not ask for an unlock
solely because desktop automation cannot inspect Simulator or QuickTime.

Simulator recordings are written to a private temporary directory, then copied to
the configured capture library after the recorder exits. This accommodates
CoreSimulator destinations that reject direct writes, including external-volume
capture directories. Startup failure removes the temporary directory; daemon
restart recovery stops the owned recorder and preserves its finalized recording
without replacing an existing capture. Interrupted captures remain labelled as such.

For an older installation that fails with `NSCocoaErrorDomain 513`, test a unique
file under the account's temporary directory before diagnosing a locked desktop.
Use the reserved UDID: `xcrun simctl io UDID screenshot /tmp/UNIQUE.png` or
`xcrun simctl io UDID recordVideo --codec=h264 /tmp/UNIQUE.mp4`. Add
`--display=external` for tvOS. Stop video with SIGINT, wait for finalization, then
copy the file to the evidence directory. Never overwrite an existing capture.

Validate the saved media with `ffprobe`; extract a frame with
`ffmpeg -i recording.mp4 -frames:v 1 frame.png` and inspect it directly. A successful
command or a nonempty file alone does not establish usable visual evidence.
Static native recordings can emit few frames; inspect their decoded content.
Opening QuickTime is unnecessary for this verification.

Lock state, login state, simulator readiness, input capability and capture-folder
permissions are separate observations. The owning macOS account still needs its
supported logged-in simulator environment. If a direct operation fails, retain
its exact command/error, try a supported alternative, and report only the blocked
journey. Do not bypass authentication, switch accounts or unlock the Mac automatically.

## Simulator input stops working after a relaunch

**Symptom.** Taps, swipes, text and keys on an Apple simulator fail every time
with an error like `The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer)
has been invalidated; events sent on it would be discarded`, or `The dtuhidd connection
was interrupted during the gesture`. Screenshots, accessibility reads and
`idb describe` still work.

**Cause.** `idb` keeps one long-running `idb_companion` per simulator. Newer
companion builds keep a dead input connection after their simulator is shut down
and booted again, and never recover until that companion process exits. Nothing
is delivered while it is in this state.

**What Device Deck does.** Every simulator input (remote keys and text, taps,
iOS gestures and wake) goes through one helper. When input fails with that error,
Device Deck stops only the `idb_companion` started for that simulator's UDID,
runs `idb disconnect UDID` so idb forgets it, and retries the input once. idb
then starts a fresh companion. Other errors are not retried. If the retry fails
the same way, the input returns `input-unavailable` (HTTP 503), and the device
stops advertising key, text and touch input until an input succeeds or the
simulator is relaunched. Restarting the companion also ends any iOS live video
for that simulator; reopen the viewer to start a new stream.

**Manual fallback.** Shut down and relaunch the simulator through its reservation,
then send input again. If it still fails, update `idb_companion`. To stop a stale
companion yourself, end only the process whose command line has
`--udid YOUR_UDID`, then run `idb disconnect YOUR_UDID`. Do not use `idb kill`,
which stops the companions of every simulator.

To check a running simulator repeatedly, run
`npm run qa:simulator-input -- --udid UDID --os ios` (or `--os tvos`). It sends
real input to whatever is on screen, prints a pass/fail count per input and
whether a companion restart happened, and exits non-zero on any failure. It does
not boot, shut down or reserve the simulator.
