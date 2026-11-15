# Install Device Deck on your Mac

Device Deck is free and open source under MIT. It requires macOS 14 or later and needs no Device Deck account or license key. Apple silicon and Intel installers are built separately.

`0.9.0-beta.3` introduces signed, Apple-notarized installers with bundled recording tools, graphical setup and in-app updates. The older `0.9.0-beta.2` packages remain unsigned. Check the release notes for validation results and beta limitations.

## Install the Mac application

1. Open [GitHub Releases](https://github.com/TantaWowa/device-deck/releases) and choose a release whose notes say **signed and notarized**, with bundled FFmpeg. Choose `arm64.pkg` for an Apple M-series Mac or `x64.pkg` for an Intel Mac. Apple menu → About This Mac identifies your chip.
2. Open the `.pkg` and follow the macOS installer.
3. While signed in as the Mac user who owns the devices, Xcode runtimes, Android SDK and pairing settings, open **Device Deck** from Applications. In **Set up Device Deck on this Mac**, choose **Start shared service** and approve the macOS administrator prompt. This account becomes the host.
4. Keep **Open menu-bar app at login** selected. For USB capture cards, choose **Allow Camera access** when you are ready to use them. If access was denied, **Open Camera settings** takes you to the permission setting.
5. Choose **Open dashboard**, then **Devices → Discover / add devices**. Add your devices and reserve one to open its controls.

Node, the camera helper, FFmpeg, ffprobe, dashboard, CLI, TUI and MCP server are included. Installing the application and using its bundled recording tools needs no Terminal commands or Homebrew installation.

The shared service starts when macOS boots, after any required FileVault disk unlock, and runs as the hosting account. It keeps one device inventory and reservation store for this Mac. Closing the dashboard or choosing **Quit menu-bar app** leaves that service running. **Open at login** controls the menu-bar app, not service startup.

USB camera capture and Apple simulator features need a usable desktop session for the host. Keep that account signed in and its menu-bar app running for USB capture. Starting the core service before login does not make these desktop features available before login.

## Allow another Mac account

While signed in as the host, choose **Mac setup…** from the menu-bar icon. Under **Mac account access**, enable the existing accounts that should use the devices, such as `ci-runner`.

Those accounts can open Device Deck or use the installed CLI and MCP server. They connect to the same service automatically and share the same reservations. They do not need a copied API token, another daemon, or another SDK installation. The host manages device configuration, tool paths and account access. Disabling an account's access revokes its connection credentials.

Shared API access does not merge simulator homes between accounts. CI jobs that invoke native tools directly against a host-owned simulator must run those tools under the host account too.

Choose the hosting account carefully. Changing it is not part of the setup screen. Using an existing account with the required SDKs and device permissions avoids moving simulator data or pairing credentials.

## Add the tools your devices need

Device Deck includes its recording tools. Device-specific SDKs and authorization still depend on the equipment you use.

| Device or capability | Additional setup |
| --- | --- |
| Roku control | Enable network control on a reachable Roku. |
| USB capture card | Grant Camera access to Device Deck in the host's desktop session. |
| Android or Fire TV | Install Android platform tools, enable debugging, and accept the device authorization prompt. Android emulators also need an SDK and configured AVD. |
| Apple simulator | Install Xcode and the required simulator runtimes in the host account. Touch control needs the official idb client and companion. |
| Physical iPhone or iPad | Configure the WebDriverAgent helper described in [physical iOS setup](physical-ios.md). |
| Physical Apple TV | Configure pyatv in the host account and pair the TV. |

Allow Local Network access when macOS requests it. Check **Settings → Host diagnostics** for missing tools, and use the host's Settings to set any custom executable paths. You can use one device family without installing tools for the others.

## Update the Mac installation

Choose **Check for updates…** from the menu-bar icon, then **Download update**. Device Deck verifies the download before offering **Install and reopen**. If any account has active reservations or recordings, choose **Install when idle** or return later.

Approve the macOS administrator prompt when installing. The update waits for shared work to finish, stops the service, installs the signed package and restarts the service for all allowed accounts. Existing configuration and captures remain in place. An unsigned beta cannot use the signed in-app installation path.

## Older unsigned betas

For `0.9.0-beta.2` and earlier public packages:

1. Download the matching `.pkg` from [GitHub Releases](https://github.com/TantaWowa/device-deck/releases), install it, then open Device Deck from Applications.
2. If macOS blocks a download you trust, try opening it once, then use **System Settings → Privacy & Security → Open Anyway** for that item. See [Apple's instructions](https://support.apple.com/en-gb/102445). These packages have unsigned installers and ad-hoc app signatures.
3. Install FFmpeg separately for recording, annotations and USB screenshots. With Homebrew, use `brew install ffmpeg-full`. If necessary, set the FFmpeg and ffprobe executable paths in Settings to the binaries below `brew --prefix ffmpeg-full`.

These older packages use `devdeck service install` for login startup. Updates use `devdeck update check` and `devdeck update download`; finish sessions and recordings, quit the app, then open the downloaded installer. They do not provide the new shared boot service or graphical setup. Upgrading from a licensed beta requires one manual download because its updater uses the old download service.

The release's `.pkg.sha256` and build metadata files are available for manual verification. Source-build and packaging instructions, service file locations, removal, and clean-Mac checks are in [Mac distribution](macos-distribution.md).
