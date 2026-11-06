# Install Device Deck

Device Deck is free under the MIT license. Download the installer for your Mac architecture from [GitHub Releases](https://github.com/TantaWowa/device-deck/releases), or build from source using the README. No license key, trial, or subscription is required.

Open the installer, then `/Applications/Device Deck.app`. Run `devdeck doctor` to check platform dependencies. Install FFmpeg for recording with `brew install ffmpeg`. Enable Camera access for capture cards. Run `devdeck service install` for startup at login.

All users have unlimited concurrent sessions and recording annotations. Device reservations still enforce exclusive ownership and expiry. Finish sessions and recordings before replacing a running installation. See [Mac packaging](macos-distribution.md).
