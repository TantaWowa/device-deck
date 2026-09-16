# Live video and touch

Feeds and device previews receive silent H.264 video over WebRTC and render it in a browser video element. Choose **Low bandwidth** when watching over a slower connection, or **Balanced** for the default. The viewer reports connection failures and offers **Reconnect video** and **Use snapshot preview**.

## Launch, watch and control

Open **Feeds**, then **Start simulator**. Search the configured Apple simulators and Android emulators, and choose **Launch & show feed**. Device Deck waits for startup, creates a native feed if needed, and opens that screen. For an emulator already running, choose **Show feed**. Devices that are starting report **Booting…** in the device list and feed; control remains unavailable until startup finishes. **Choose feeds** holds the full searchable selection list; stopped simulators are not selected by default.

TV devices use the feed's **Remote** button for directional keys, Home and text. The floating remote contains controls only. Phones and tablets show an **Enable touch** switch directly under their video. Their device class is preserved while offline or booting, so missing input tools never turn a phone into a TV remote. If a simulator is not listed, discover and add it in **Devices** first; installed offline Android AVDs can be discovered without booting them.

## What each source provides

| Source | Video | Touch |
| --- | --- | --- |
| USB capture card | Shared native capture, encoded on the Mac; up to 15 fps | Depends on the device's separate control adapter |
| Android phone, tablet or touchscreen emulator | Native scrcpy H.264; up to 30 fps in High detail | Tap, swipe, long press, continuous drag and multiple contacts |
| Android TV, Fire TV or emulator without a touchscreen feature | Native scrcpy H.264 or assigned USB capture | Remote keys/text; touchscreen gestures are not advertised |
| iOS simulator | Screenshots sampled up to twice per second, then encoded as video | Completed tap, swipe and long press through idb |
| tvOS simulator | Screenshots sampled up to twice per second, then encoded as video | Existing remote keys/text; no touchscreen gestures |
| Roku or physical Apple TV | Assigned USB capture | Existing remote keys/text; no touchscreen gestures |
| Other physical Apple device | No native video adapter | No touch adapter |

The USB path still uses JPEG frames inside the Mac's shared capture pipeline. The Mac encodes those frames once per active quality profile and distributes compressed video to browsers. Each displayed frame no longer needs a separate browser HTTP request. Recordings and still screenshots retain their existing capture paths.

Android uses the device's encoder and forwards its H.264 packets without a Mac video re-encode. A control viewer always displays that native Android screen, including when the device has a USB card assigned, so touch coordinates match the controlled display. A view-only viewer uses the assigned USB source when present.

The iOS/tvOS label is **Limited-refresh video · simulator snapshots**. Video transport does not turn the screenshot source into full-motion simulator capture. A slow simulator may provide fewer than two frames per second. The separate **Use snapshot preview** recovery option uses individual HTTP images and is view only.

## Quality and remote access

| Viewer setting | Maximum long edge | Target video bitrate | Maximum Android frame rate |
| --- | --- | --- | --- |
| Low bandwidth | 640 px | 0.5 Mbps | 10 fps |
| Balanced | 1280 px | 1.5 Mbps | 15 fps |
| High detail | 1280 px | 4 Mbps | 30 fps |

USB capture remains limited to 15 fps and simulator screenshots to 2 fps. These are ceilings, not measured guarantees; encoder support, source activity and network capacity affect the result. High detail raises the bitrate and Android frame rate; it does not enable 1080p. Streams use H.264 Baseline and are silent. Each additional viewer consumes its own outbound network bandwidth, even when it shares an encoder.

The authenticated HTTP connection carries signaling. Media and input use a separate encrypted WebRTC connection. Device Deck includes LAN, loopback and Tailscale IPv4 addresses in its connection candidates and binds UDP ports **49152–49251** on the host Mac. The viewing machine must be able to reach those ports over its permitted network path. For Tailscale, the relevant tailnet policy and host firewall must allow that traffic; reaching the HTTPS page through Serve alone does not prove that media can connect.

No public STUN or TURN server is configured. Device Deck does not relay media through the portal or Tailscale Serve. Tailscale itself may carry the underlying network connection directly or through its own relay, so latency still depends on that path. If the page opens but video does not, check the Mac's reachability and UDP policy, then use **Reconnect video**. The snapshot option remains available when WebRTC cannot connect.

## Control a touchscreen

1. Open the feed and turn on **Enable touch**. This reserves an available device; an existing reservation requires reviewing the warning before enabling or taking over control.
2. Wait for video and its control connection to become ready.
3. Touch or click inside the device image. Black borders are not part of the touch surface.
4. On Android, drag to scroll; a touch-capable browser can send multiple contacts for a pinch. On iOS, tap, swipe, or hold and release to submit a completed gesture.
5. Turn **Enable touch** off to stop input while keeping the reservation and any recording active. Use **End session** to release the reservation and finalize an active recording.

Android holds contacts while the pointer remains down. Input uses an ordered, bounded queue; pending moves are coalesced without crossing down/up events. Blur, hidden tabs, pointer cancellation, geometry changes, disconnection and session closure cancel active contacts. Rotation changes the encoded dimensions and invalidates old coordinates.

The idb CLI supports completed gestures here, not an ongoing pointer stream. An iOS gesture begins after release in the browser. A gesture already dispatched to idb is allowed to send its final touch-up before its adapter closes; it cannot be interrupted partway through with the same guarantees as Android. Continuous drag and multitouch are therefore not advertised for iOS. idb's reported screen dimensions convert preview pixels into simulator points, including scaled previews and landscape frames.

The daemon checks the reservation and lease before dispatch, and rechecks machine access for live connections. Opening a view-only feed never grants touch control. Touch starts off and must be enabled again after hiding the page, losing the control connection, or losing the reservation. Expired, taken-over or released reservations cannot continue to send input. Hiding or closing a preview stops that viewer; it does not release the reservation or stop an independent recording.

## Setup and supported versions

Android needs authorized ADB access and Android 5.0/API 21 or later, following the [scrcpy 4.1 prerequisites](https://github.com/Genymobile/scrcpy/blob/v4.1/README.md#prerequisites). Some devices require an additional vendor debugging permission for injected input. Device Deck checks the touchscreen feature before advertising gestures.

The build downloads the exact **scrcpy-server 4.1** asset recorded in `scripts/distribution/scrcpy.json` and verifies its SHA-256. The runtime verifies the checksum again. It creates a unique device-side server file and ADB forward for each source, addresses the selected ADB server and frozen transport ID, and requires verified hardware/AVD identity. A physical USB serial must match `ro.serialno` unless a hardware ID is already stored; network ADB connections need a discovered hardware ID. Cleanup removes only that source's resources and never runs `adb kill-server`. A missing or altered bundled server produces a rebuild/reinstall error; runtime viewing does not install an unpinned replacement.

USB and simulator video need the configured ffmpeg executable. The Mac encoder tries VideoToolbox and falls back to libx264 if available. Apple simulator controls require the [idb client and companion](https://github.com/facebook/idb), installed together with `brew install facebook/fb/idb`, plus a booted simulator. The adapter refuses iOS touch when idb cannot report its exact UDID and pixel/point dimensions.

See [API and CLI examples](api.md#live-video-and-touch-operations) and [source provenance](source-provenance.md). Protocol, identity, cleanup and coordinate tests cover the implemented contracts. A read-only capture on the existing `Hosanna_Phone_API_36` emulator verified 720×1280 Constrained Baseline level 3.1 output and restoration of ADB forwards, source processes and server files. Its 6.5-second static-screen sample contained 11 media frames; that is not a motion-frame-rate or end-to-end latency benchmark. The evidence and remuxed sample are saved locally under `outputs/live-video-qa/android-readonly-native-*`. No device input was sent during that proof. This does not establish physical Android, iOS touch, rotation or remote-network performance proof.

A read-only check of the running local daemon's UGREEN/Roku USB source delivered 1280×720 video to Chrome at about 13 fps over a four-second loopback sample. No remote input was sent. The result is recorded in `outputs/live-video-qa/usb-readonly-browser-proof.json`; it verifies real USB capture, encoding and browser decoding, but does not measure cross-machine Tailscale latency.

Real Google TV browser validation also covers joining after the initial keyframe on a static screen. Apple TV, iPhone and Android phone emulator browser validation covers cold launch, automatic feed display, decoded video and Home from the controls-only remote. Apple controls used idb 1.5.9, and the iPhone also accepted a swipe through the lease-protected gesture API. Its first cold boot took almost three minutes, so Apple startup allows four minutes and both browser clients keep the launch request alive for five. Launch failures explain that startup has not completed rather than returning an empty command error. Evidence is saved under `outputs/live-video-qa/real-emulator-workflow.json` and the adjacent screenshots.

## Repeatable browser validation

Run the isolated synthetic fixture in one terminal, then run the browser checks from the repository root in another:

```sh
node --import tsx scripts/qa-live-server.ts
# Wait for LIVE_QA_READY, then in the second terminal:
node scripts/qa-live-video.mjs
```

The fixture requires ffmpeg on `PATH`; its startup builds the current local dashboard into a temporary directory. It binds only loopback (port 47941 by default; set `QA_LIVE_PORT` to change it) and uses generated test-pattern video and an in-memory gesture recorder. It does not discover or contact real devices. Stop the fixture with Ctrl-C when finished.

The browser runner uses installed Google Chrome by default. Set `PLAYWRIGHT_CHANNEL=chromium` when using a Playwright-managed Chromium installation. Before sending input, it verifies the synthetic fixture's device IDs, names and ADB serial. It exercises desktop and 390-pixel mobile layouts for both the local dashboard and the shared portal workspace, checking advancing H.264 frames, ordered gestures, cancellation on blur, explicit session release, a quality change, and an intentionally failed stream followed by the view-only snapshot option.

The test-only portal shell in `scripts/fixtures/live-portal.tsx` supplies a synthetic identity and grant through a loopback proxy. Media signaling, video transport and control dispatch still use the fixture daemon. This covers the portal viewer and machine transport integration; it does not test Firebase sign-in, real account grants, physical hardware, Safari, or a cross-machine Tailscale connection.

Inspect `outputs/live-video-qa/results.json` for per-case results and measured frame progression. Screenshots are saved beside it. These files are generated evidence, not committed fixtures. The runner closes its browsers, proxy and acquired synthetic reservations; the separately started fixture remains running until stopped.
