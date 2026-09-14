# Building and installing Device Deck for Mac

The Mac package contains `Device Deck.app`, a pinned private Node 24 runtime, the daemon, web dashboard, CLI, TUI, MCP server and native camera helper. Separate Apple Silicon and Intel installers support macOS 14 or later. The Mac distribution workflow builds and validates each installer on its matching architecture.

The team build currently uses an **external FFmpeg installation** for recording, USB screenshots and annotations. Live USB previews and Roku control do not require FFmpeg. This is an explicit packaging mode, not a claim that every adapter dependency is bundled.

## Build a team package

On the build Mac, install the repository dependencies and Apple's command-line build tools, then run:

```sh
npm ci
npm run check
npm test
npm run package:mac
```

The default uses test Keygen trust, creates an ad-hoc-signed application and an **unsigned team installer**, and writes artifacts under ignored `work/distribution`. It never installs into `/Applications`, enables a login service, or copies your development profile, device bindings, recordings or license key into the package.

The runtime archive is downloaded from Node's official release host and checked against the architecture-specific SHA-256 pinned in `scripts/distribution/node-runtime.json`. The package does not include npm or require the user's Node, NVM, Python or Xcode to open. A missing cache requires internet access on the build Mac.

For example, version `0.5.0-beta.1` creates:

```text
work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.pkg
work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.pkg.sha256
work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.json
```

The JSON records the build commit, license product, runtime, architecture, media dependency mode, signing status, artifact size and checksum. Prerelease names remain in release metadata; macOS bundle and installer receipt versions use the numeric `major.minor.patch` portion. Keep one supported beta installed at a time; an equal-version installer can replace it.

Run the package proof against the staged app:

```sh
npm run proof:mac -- --app 'work/distribution/staging/arm64-test/payload/Applications/Device Deck.app' --package work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.pkg
```

This verifies the installer checksum and extracted payload against the staged app, then launches only an isolated temporary profile and validates the private runtime, real Free-mode daemon with configured Keygen trust, bundled dashboard, safe shutdown and installer refusal while that app is running. It does not open capture streams or change the developer's running deck. A clean team Mac must still verify Gatekeeper behavior, the first Camera permission prompt and its Device Deck attribution, live USB recording, and upgrade behavior across actual installs.

## Team installation

1. Share the `.pkg`, its checksum file and the release notes through your team's normal channel. Keep test licenses with test packages; they do not activate live packages.
2. Verify the checksum, then open the installer. The unsigned team installer has no Apple notarization; managed Macs may require an administrator-approved test deployment. Do not disable Gatekeeper globally. Use the signed release path below for normal outside-team distribution.
3. Open `/Applications/Device Deck.app`. Its menu-bar icon opens the dashboard and the **Capture setup** instructions. Allow Camera access when the selected capture input requests it.
4. Install the optional capture encoder if needed: `brew install ffmpeg`. Both standard Homebrew locations are searched. Reopen Device Deck, check Settings diagnostics, discover devices and add selected devices together.
5. Use `devdeck start`, `devdeck ui` or `devdeck tui` from a terminal. Choose `devdeck service install` only when you want the app to start at login.

The installer creates `/usr/local/bin/devdeck` when that path is free. It preserves an existing regular file or unrelated/development symlink. A prior `~/.local/bin/devdeck` may also win in your PATH. Use `type -a devdeck` to identify the current launcher. To keep both, leave the development command intact and invoke `'/Applications/Device Deck.app/Contents/MacOS/devdeck'` for the installed app. Explicitly move your old launcher before replacing it; the installer does not guess which checkout you want to retire.

If your development deck is already using the default port, stop it before opening the installed app. To test both simultaneously, start the installed CLI with a separate `DEVICE_DECK_HOME` and `DEVICE_DECK_PORT=0`; the selected profile's endpoint records its assigned port. Do not point a production installation at a development mock profile.

The app owns the daemon as the signed-in user. The package installer is the only component requiring administrator privileges. Closing the web tab leaves the daemon available. **Quit Device Deck** from its menu bar refuses active reservations or recordings; finish those first. The CLI `devdeck stop` is an explicit request to stop and finalize the service. **Check for updates** in the menu bar reports an available version; `devdeck update download` retrieves its verified installer without installing it over an active app.

## Optional platform dependencies

| Capability | Setup |
| --- | --- |
| Roku control; USB preview | Included; permit local network and Camera access when macOS requests it. |
| Recording, USB screenshots, annotation | `brew install ffmpeg`; configure `ffmpeg` and `ffprobe` paths in Settings for a custom install. |
| Android / Fire TV control | `brew install --cask android-platform-tools`, enable debugging on the device, and accept its authorization. |
| Apple simulator launch / close / capture | Install Xcode and the selected simulator runtimes. |
| Physical Apple TV control | Use a Python environment containing `pyatv`; set its absolute Python path in Settings and pair the device. |

Tools are checked at runtime. Installing one platform's dependency is not required to use another platform. Private Apple TV pairing credentials remain in the user's environment and are never copied into a release.

## Signed public package

Import the Developer ID Application and Developer ID Installer certificates **with their private keys** into the build Mac's keychain. Store Apple notarization credentials using `xcrun notarytool store-credentials`; do not put passwords, keys or account tokens into npm arguments or tracked configuration.

```sh
export DEVICE_DECK_APPLICATION_IDENTITY='Developer ID Application: YOUR ORGANIZATION (TEAMID)'
export DEVICE_DECK_INSTALLER_IDENTITY='Developer ID Installer: YOUR ORGANIZATION (TEAMID)'
export DEVICE_DECK_NOTARY_PROFILE='device-deck'
npm run package:mac -- --release
```

`--release` selects live Keygen trust. It refuses missing or invalid identities and missing notarization configuration. It signs nested executable code and the app using the hardened runtime, signs the installer, submits it to Apple's notary service, staples the ticket, and verifies the result before writing release metadata. A failed notarization never falls back to an unsigned public release. Test-mode packages cannot use this release path.

Do not publish a manually copied `.pkg` that lacks a matching completed JSON/checksum record. Publish immutable versions through the release workflow. Public signing and clean-Mac acceptance are required before moving from the team beta to market.

## Upgrade, rollback and removal

The installer refuses replacement while any process from the installed app is running, even if currently idle. Finish sessions and recordings, quit the menu-bar app and run `devdeck stop`, then install the update. This conservatively prevents an upgrade from interrupting another client's reservation or capture. It does not kill an app automatically or modify profile data.

Keep the prior installer available. Before installing a beta with a data migration, stop the app and back up `~/Library/Application Support/Device Deck` plus any external config selected with `DEVICE_DECK_CONFIG`. Restore a prior version only when its data format is compatible; restore the matching profile backup if the migration requires it. Captures remain in their configured folder, normally `~/Movies/Device Deck`.

To remove the application, first run `devdeck service uninstall`, stop Device Deck, and move `Device Deck.app` to the Trash. Remove `/usr/local/bin/devdeck` only if it points to that application's launcher. Keep the profile and captures unless you explicitly want to erase your work.

## Providing a bundled encoder later

`npm run package:mac -- --media-bundle /absolute/path/to/media` accepts an already relocatable encoder bundle. It must include `bin/ffmpeg`, `bin/ffprobe`, all non-system dynamic libraries, the matching source archives and license notices for every component, and `media-manifest.json`:

```json
{
  "schemaVersion": 1,
  "arch": "arm64",
  "components": [{
    "name": "ffmpeg",
    "version": "YOUR_BUILD_VERSION",
    "license": "YOUR_BUILD_LICENSE",
    "source": "sources/ffmpeg-source.tar.gz",
    "notices": "licenses/ffmpeg.txt",
    "files": [{ "path": "bin/ffmpeg", "sha256": "64 lowercase hex characters" }]
  }]
}
```

List every binary and dynamic library with its hash and declare every dependency as a component. Source and notice paths must resolve inside the bundle. The verifier rejects missing files, wrong architectures, symlinks, unlisted binaries, unresolved `@rpath` dependencies and Homebrew Cellar paths. Use relocatable `@loader_path` dependencies. The current capture engine requires `libx264`, PNG encoding and the ASS annotation filter; the verifier checks those capabilities. Validate the complete source and license obligations for the actual encoder build before publishing it. The external-FFmpeg mode avoids redistributing the developer machine's large Homebrew library collection.
