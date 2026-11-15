# Device compatibility

Device Deck runs on macOS 14 or later. Apple silicon and Intel have separate Mac packages. Device support depends on the target, installed platform tools and permissions. Follow the [install guide](install.md) for the setup that matches your downloaded release.

The table below describes implemented adapters. It is not a claim that every model, OS version or operation has been tested on the current release. Check a device's reported capabilities before using it in automation.

## Implemented adapters

| Target                                 | Input                               | Preview / screenshot / recording   | Setup                                                        |
| -------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Roku                                   | ECP keys and Unicode text           | Explicit USB input                 | Network ECP must permit control; stable Roku serial required |
| Android, Android TV, Fire TV, emulator | ADB keys/text; scrcpy gestures on touchscreen devices | Native H.264 live video; native or USB capture | Authorized ADB; Android 5+ for live video; pinned server bundled |
| iOS simulator                         | idb keys/text, tap, swipe and long press | Native idb H.264 live video; native recording | Booted simulator, Xcode, idb client and companion, ffmpeg |
| tvOS simulator                        | idb keys/text | Limited-refresh video from simctl screenshots; native recording | Booted simulator, Xcode; idb client and companion for input |
| USB capture only                       | No remote input                     | USB preview, screenshot, recording | Stable capture card identity                                 |
| Physical Apple TV                      | Companion keys and text             | Explicit USB input                 | pyatv and PIN pairing                                        |
| Physical iPhone / iPad with WebDriverAgent | Tap, swipe and long press over USB | Native snapshots at up to 2 fps; assigned USB capture | Requires a signed helper and iproxy; [setup](physical-ios.md) |
| Other physical Apple devices           | Discovery only                      | No native adapter                  | No unsupported operation is advertised                       |

Native Android recordings stop at 175 seconds, below screenrecord's 180-second limit. Other sources use the configured limit. Live previews use browser video elements. Android touch includes continuous drag and multitouch when advertised; iOS simulators support completed gestures over native H.264 video. An explicit view-only snapshot fallback is available when video cannot connect. USB preview and recording share one capture-helper stream selected by stable AVFoundation unique ID, never enumeration index. Capture video is silent in this release.

The verified hardware matrix, real proof files and limits are recorded in [validation](validation.md). Implemented adapter paths do not imply that every device model has been tested.

## What has been exercised

The repository records simulator sessions, later live-video checks and a USB capture check. These are scoped historical observations, not a certification of the current release candidate.

| Target | Documented checks | Evidence scope |
| --- | --- | --- |
| iOS and tvOS simulators | Reservations, remote input, screenshots and recording; later cold launch and browser video, with an iPhone swipe | See [validation history](validation.md) and [live-video checks](live-video-and-touch.md#setup-and-supported-versions). |
| Android TV and phone emulators | Reservations, input, capture, native video and browser launch workflows | The recorded samples do not establish physical-device or remote-network performance. |
| UGREEN USB card carrying a Roku feed | Read-only capture, encoding and browser video decoding | A short loopback sample in [live-video checks](live-video-and-touch.md#setup-and-supported-versions); it does not prove Roku input or every USB card. |
| Physical Roku, Android/Fire TV, Apple TV control and physical iPhone/iPad touch | Adapter and fixture coverage is documented | Physical input, pairing and model-specific behavior still need reproducible release-specific reports. |

## Limits to check before choosing a workflow

- Captures are silent. USB live video is capped at 15 fps; actual delivery depends on the host, signal and network.
- Native Android recording stops at 175 seconds. Other sources use the configured limit.
- Physical Roku and Apple TV video needs a paired USB capture input. Network control alone does not provide their video.
- Physical iPhone/iPad setup requires a signed WebDriverAgent helper. Its native snapshots are sampled at up to two frames per second and it does not provide native recording. See [physical iOS setup](physical-ios.md).
- iOS touch supports completed gestures. Continuous drag and multitouch are currently Android touchscreen capabilities.
- Samsung and LG network control adapters are not implemented. A USB capture-only input can still be viewed and recorded.

To help expand coverage, [report a tested device](https://github.com/TantaWowa/device-deck/issues/new?template=device_compatibility.yml). Include the Device Deck version, Mac architecture, target model/OS, connection, tools and exact operations you tried. A screenshot or recording helps when it shows the reported result.
