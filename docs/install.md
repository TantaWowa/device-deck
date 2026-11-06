# Install Device Deck on your Mac

Device Deck is free and open source under MIT. Local use needs no account or license key. Requires macOS 14 or later.

## Download and install

1. Open [GitHub Releases](https://github.com/TantaWowa/device-deck/releases) and choose the newest release. Beta releases appear here too.
2. In Apple menu → About This Mac, check **Chip** or **Processor**. Choose the `arm64.pkg` asset for Apple silicon, or `x64.pkg` for Intel. Download the `.pkg`, not GitHub's source-code archive.
3. Open the installer and follow its prompts. It installs `/Applications/Device Deck.app` and a `devdeck` terminal command. Node, the native helper, dashboard, CLI, TUI and MCP server are bundled.
4. Open Device Deck from Applications. Its menu-bar icon opens the local dashboard. Choose Devices → Discover / add devices. Add the devices you want to use, then reserve one to open its controls.

These beta installers are unsigned and their apps use ad-hoc signatures. If macOS blocks one you trust, try opening it once, then use System Settings → Privacy & Security → Open Anyway for that installer or app. See [Apple's instructions](https://support.apple.com/en-gb/102445). A managed Mac may require your administrator's approval. Signed and notarized packages will be identified in release notes.

The release also includes a `.pkg.sha256` file and build metadata JSON for each architecture. To check a download, put its installer and checksum in one folder and run `shasum -a 256 -c <installer-name>.pkg.sha256` there.

## Optional tools for your devices

- Recording, annotations, USB screenshots and video encoding need FFmpeg. With [Homebrew](https://brew.sh) installed, run `brew install ffmpeg-full`. Set the FFmpeg and ffprobe paths in Device Deck Settings to the binaries under `brew --prefix ffmpeg-full` if diagnostics cannot find them. This build includes the subtitle filter used by keypress overlays.
- Android and Fire TV need Android platform tools, USB or network debugging, and device authorization. Run `brew install --cask android-platform-tools`. Android emulators also need the Android SDK and an AVD.
- Apple simulators need Xcode and the relevant simulator runtimes. Simulator touch needs the official idb client and companion. Physical iOS touch needs a configured WebDriverAgent helper; see [physical iOS setup](physical-ios.md).
- Physical Apple TV control needs pyatv and pairing. Roku control needs a reachable Roku with network control enabled.
- Allow Camera access when requested for capture cards. Allow Local Network access when requested for device discovery.

Run `devdeck doctor` to check installed tools. If another `devdeck` command already exists, the installer preserves it. Use `"/Applications/Device Deck.app/Contents/MacOS/devdeck" doctor` to inspect this installation.

## Updates

Run `devdeck update check`, then `devdeck update download`. Downloads are public and checked against their GitHub asset size and SHA-256 digest. Updates never install over an active service automatically.

Finish sessions and recordings, quit Device Deck from its menu-bar icon, then open the downloaded installer. Existing configuration and captures are preserved. Previous licensed versions cannot discover these GitHub releases through their old updater; download and install the free version manually once.

## Start at login or uninstall

Run `devdeck service install` to start at login. To remove it, run `devdeck service uninstall`, stop the app, and move Device Deck.app to the Trash. Your configuration and captures remain in place.

For source builds, see the [README](../README.md). For signing and packaging, see [Mac distribution](macos-distribution.md).
