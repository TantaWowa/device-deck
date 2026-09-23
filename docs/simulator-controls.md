# Launch and close simulators

Registered Apple iOS/tvOS simulators and Android AVDs have **Launch sim** and **Close sim** actions directly in the web Devices list. Launch boots the configured virtual device and waits for readiness. Close shuts down only that virtual device.

CI and agent orchestration should use a [reservation group](group-reservations.md) rather than launching first and reserving later. The daemon atomically claims the whole device/source set, then uses an internal credential-owned lifecycle path to start its stopped virtual members. Public `devices.simulator` continues to reject reserved devices, preventing an unrelated caller from changing a session's simulator state.

In `devdeck tui`, select **Devices**, select a simulator, and press **O**. The same action appears in the item's **Enter** menu. The list shows stopped, launching, running, and closing states. Closing requires confirmation.

If you hold a reservation, the confirmation offers to end your session and save its recording before closing. A session owned by another client must be explicitly managed and ended first. The daemon rejects launch or close while any reservation for that simulator remains active or closing, and blocks new reservations while its state is changing.

For Apple, Xcode and the selected iOS/tvOS runtime must already be installed. Use **Discover** to register available simulators. Missing runtimes are reported as unavailable; selecting a similar device name never substitutes a different simulator. Device Deck uses its configured UDID for each command and attempts to open the Simulator window from the selected Xcode installation. Window presentation is best-effort: a headless macOS session or a concurrent launch can prevent `Simulator.app` from opening even though CoreSimulator booted the device successfully. In that case the launch succeeds and returns a warning, so CI reservations can still use the ready simulator. iOS live video uses `idb video-stream` and ffmpeg. Screenshots, recordings and the limited-refresh tvOS feed use `simctl`. Apple controls and iOS live video need `idb` and `idb_companion`.

For Android, create the AVD in Android Studio first. **Discover** lists both running emulators and installed AVDs that are stopped. Select multiple or **Add all** to register them. Device Deck uses the existing SDK emulator executable from **Settings → Adapter executables → emulator**, Android SDK environment variables, standard SDK paths, or `PATH`. It does not install an SDK or system images. The AVD name comes from `emulator -list-avds` or a running emulator's exact `adb -s SERIAL emu avd name` response. When that console response is empty or unavailable, Device Deck reads `ro.boot.qemu.avd_name` from the same exact ADB serial. Empty or invalid identities remain blocked. These commands use the Android SDK's [launch](https://developer.android.com/studio/run/emulator-commandline) and [console](https://developer.android.com/studio/run/emulator-console) interfaces.

An Android device's optional `connection.avdName` is its persistent virtual-device identity. Launch uses `emulator -avd NAME`; after boot, Device Deck finds the actual ADB serial belonging to that AVD. New remote, screenshot and recording operations resolve that serial again, so another emulator reusing an old serial is not selected. A recording retains its resolved transport for its lifetime. Duplicate running instances with the same AVD name are reported as ambiguous.

Existing serial-only emulator entries can close their exact running emulator once its AVD identity is readable. Lifecycle and reservation preflight learn and save that verified AVD name, rejecting duplicate registered identities. A stopped serial-only entry needs its AVD name set in **Edit device** before Launch is available. If an emulator is still booting or its identity is unreadable, wait and refresh; a launch timeout leaves its process running. Physical devices do not have simulator lifecycle controls.

Scripts and MCP use the same operation:

```sh
devdeck call devices.simulator '{"deviceId":"YOUR_CONFIGURED_SIMULATOR_ID","action":"launch"}'
devdeck call devices.simulator '{"deviceId":"YOUR_CONFIGURED_SIMULATOR_ID","action":"close","confirmed":true}'
```

The MCP tool is `devices_simulator`. Successful responses include `deviceId`, `action`, `state` (`booted` or `shutdown`) and `changed`; Android launch also returns its resolved `serial`. Repeating launch does not reboot an already running virtual device, and repeating close on a stopped device succeeds without another shutdown. Apple launch also attempts to bring its Simulator window forward. If only that presentation step fails, the successful response includes a `warning`; simulator lifecycle and readiness remain successful.
