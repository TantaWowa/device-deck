# Control a physical iPhone or iPad

Connect an iPhone or iPad by USB and run a signed WebDriverAgent helper on it. Device Deck can then send completed taps, swipes and long presses from the feed, CLI or MCP using the existing device reservation. Continuous dragging and multitouch are unavailable on this adapter.

The phone's own screenshots provide a silent preview sampled at up to two frames per second. Enabling touch uses this screen even when the device has a USB HDMI capture card assigned. A view-only feed can still use that card. Native WebDriverAgent recording is unavailable; use an assigned capture card for recording.

## Prepare the device

1. Connect the device by USB, unlock it and accept **Trust This Computer**. Confirm it appears in Xcode's **Window > Devices and Simulators**.
2. On iOS/iPadOS 16 or later, enable **Settings > Privacy & Security > Developer Mode** and complete the device restart. Enable **Settings > Developer > Enable UI Automation**. Turn off **Settings > Accessibility > Zoom** so screen coordinates match the automation coordinates.
3. Install the USB forwarding tool on the Mac:

   ```sh
   brew install libusbmuxd
   ```

4. Obtain WebDriverAgent **16.15.3**, the version whose protocol this adapter was implemented against. For example, extract the published package into a directory of your choice:

   ```sh
   npm pack appium-webdriveragent@16.15.3
   tar -xzf appium-webdriveragent-16.15.3.tgz
   open package/WebDriverAgent.xcodeproj
   ```

5. In Xcode, select the **WebDriverAgentRunner** scheme and the connected phone or tablet. Configure your development team and valid signing/provisioning for the runner. Use **Product > Test** to install and start it. Complete any developer trust prompts on the device. Keep the test runner running.

Signing and device trust are per-device setup steps. Device Deck connects to the running helper; it does not obtain certificates, sign, install or start WebDriverAgent. A full Appium server is not required. See Appium's [device preparation](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/) and [real-device provisioning](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/) documentation for signing details.

## Configure Device Deck

1. Discover and add the physical Apple device in **Devices**, then open **Configure device**.
2. Check **Enable iPhone / iPad touch with WebDriverAgent**. Leave **WebDriverAgent port on device** at **8100** unless you explicitly changed the runner's listening port. This is the port on the phone; Device Deck allocates its own local forwarding port.
3. Choose **Native screen** as the capture input and save. Enabling WebDriverAgent selects it when no capture input was assigned. You can retain an existing capture card assignment instead.
4. If `iproxy` is not on the daemon's PATH, set its full executable path in **Settings**, for example `/opt/homebrew/bin/iproxy` on an Apple Silicon Homebrew installation.
5. Open the phone's feed and enable touch. Device Deck acquires the normal reservation and opens a dedicated WebDriverAgent automation session. Tap, swipe, or hold and release inside the screen image. Gestures are dispatched after release in the browser.

Configuration files and the existing configuration API accept an optional `webDriverAgent` object on an `apple-device` connection:

```json
{
  "type": "apple-device",
  "udid": "THE_IDENTIFIER_REPORTED_BY_DEVICE_DECK_DISCOVERY",
  "webDriverAgent": { "port": 8100 }
}
```

The identifier can be the Xcode CoreDevice identifier or the hardware UDID. Before opening a connection, Device Deck resolves it through Xcode to exactly one physical iPhone/iPad hardware UDID, then launches `iproxy` with that UDID and USB-only selection. It never selects the first attached phone or connects to an arbitrary WebDriverAgent URL. Each owned forward binds to loopback and stops when its viewer or touch controller closes. Viewing screenshots does not create an automation session.

## Troubleshoot control

- **Cannot connect to WebDriverAgent**: keep the phone unlocked, connected by USB and running its signed test runner. Check the device port and `iproxy` executable. Wi-Fi forwarding is not supported.
- **Active automation session**: stop Appium or another tool's session before enabling touch. Use a WebDriverAgent runner dedicated to Device Deck. WebDriverAgent has one active session; Device Deck refuses an existing session rather than deliberately replacing it. External tools do not participate in Device Deck's reservations.
- **Missing full screenSize and scale**: update the signed helper to the documented version. The adapter requires full-screen dimensions to avoid mapping touches using an app's smaller compatibility window.
- **Orientation changed**: reconnect the viewer after rotating the device. Old preview coordinates are rejected when their aspect ratio differs from the current full screen.

Disabling touch or ending the reservation drops queued gestures. A completed gesture already dispatched to WebDriverAgent is allowed to finish its final touch-up before the owned automation session is deleted. Device Deck does not terminate the user's test runner or another tool's session.

Protocol, USB-forwarding lifecycle, coordinate, WebRTC and encoder fixtures verify the integration without real device input. Physical iPhone/iPad operation, signing, touch latency and on-device rotation still require hardware verification.
