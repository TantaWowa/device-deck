# Build and operate Device Deck for Mac

For `0.9.0-beta.3`, the release process produces Developer ID signed, notarized packages with bundled recording tools and shared Mac setup. The older public installers through `0.9.0-beta.2` are unsigned, use external FFmpeg and start a per-user service at login. Check the release notes for the selected installer; the presence of this documentation does not mean a candidate has been published. See [the install guide](install.md) for setup. The clean-Mac acceptance checks below remain unverified until their results are recorded.

The new package includes the menu-bar app, a pinned private Node 24 runtime, daemon, dashboard, CLI, TUI, MCP server, camera helper, FFmpeg and ffprobe. It supports macOS 14 or later on Apple silicon and Intel. Build each architecture on a matching Mac; both packages can then be signed on a single Mac as described below.

## Build an unsigned test package

The build Mac needs Node 24 or later, Xcode command-line tools, CMake and pkg-config. Intel builds also need NASM. These are build-machine tools; end users do not need them to install the app or record with its bundled encoder.

```sh
npm ci
brew install cmake pkgconf nasm
node scripts/distribution/build-media.mjs --output "$HOME/hope-scratch/device-deck-media/bundle"
export DEVICE_DECK_MEDIA_BUNDLE="$HOME/hope-scratch/device-deck-media/bundle"
export PATH="$DEVICE_DECK_MEDIA_BUNDLE/bin:$PATH"
npm run check
npm test
npm run test:distribution
npm run package:mac -- --media-bundle "$DEVICE_DECK_MEDIA_BUNDLE"
```

The package command creates an ad-hoc-signed app and unsigned installer under ignored `work/distribution`. It does not install the app, register the shared service, or copy a development profile, device bindings, captures or private credentials. The native setup screen registers the service only after installation and administrator authorization.

The private Node archive comes from Node's official release host and is verified against the architecture-specific SHA-256 in `scripts/distribution/node-runtime.json`. No user-installed Node, NVM or npm is needed at runtime.

Output names follow the package version and architecture:

```text
work/distribution/device-deck-VERSION-macos-ARCH.pkg
work/distribution/device-deck-VERSION-macos-ARCH.pkg.sha256
work/distribution/device-deck-VERSION-macos-ARCH.json
```

The JSON records version, build commit, architecture, minimum macOS version, runtime, media mode, signing status, size and checksum. Prerelease names remain in release metadata; macOS bundle and receipt versions use the numeric `major.minor.patch` portion.

To prove a generated installer, substitute its version and architecture:

```sh
npm run proof:mac -- --app 'work/distribution/staging/ARCH/payload/Applications/Device Deck.app' --package work/distribution/device-deck-VERSION-macos-ARCH.pkg
```

The proof inspects the installer checksum and extracted payload, runs an isolated temporary profile, and checks the bundled runtime, dashboard, free access, shutdown and upgrade preflight. It does not install a system service, reboot the Mac, grant Camera permission, or prove cross-account behavior. Those require the acceptance checks below.

## Bundled recording tools

`scripts/distribution/build-media.mjs` builds FFmpeg, x264, libass, FreeType, FriBidi and HarfBuzz from the exact upstream archives and SHA-256 hashes in `media-sources.json`. It links those dependencies statically, retaining only macOS system frameworks and libraries as dynamic dependencies. It enables H.264, PNG and ASS annotation support, then creates a recording and extracts a screenshot using the built tools.

Build work and the verified source cache default to `~/hope-scratch/device-deck-media`. Use `--work DIR` to change that directory and `--jobs N` to limit parallel compilation. A cache entry is reused only after its source checksum passes. Completed dependency builds are keyed by the source lock, recipe, architecture, compiler and SDK.

The media bundle contains `bin/ffmpeg`, `bin/ffprobe`, complete matching source archives, notices for each component and the rebuild recipe. The encoder executables use GPL-2.0-or-later; the main Device Deck source remains MIT. See the bundled `licenses/`, `sources/` and `README.txt` for the component licenses and rebuild instructions.

The packager verifies the manifest, architecture and library dependencies before copying the bundle. It rejects Homebrew library paths, unresolved non-system libraries, symlinks, missing notices or sources, and missing encoding features. A custom bundle may be supplied through `--media-bundle`, but must meet the same checks. Public releases require bundled media. An explicit development package with external FFmpeg is not the normal installation path.

## Shared Mac service

Install the package, sign in as the account that owns the SDKs and devices, then open Device Deck. **Mac setup… → Start shared service** uses the macOS administrator prompt to register a LaunchDaemon. The service runs as that existing account, never as root. The privileged setup helper exits after completing the requested change.

The service starts when macOS boots, after any required FileVault disk unlock. It cannot run while the encrypted boot disk remains locked. It owns one inventory, reservation store, capture library and set of tool paths. Closing the menu-bar app does not stop it. The **Open at login** setting controls only the menu-bar app in the current account.

The host's desktop supplies the camera bridge and its macOS Camera permission. USB capture requires that desktop and bridge to be available. Apple simulator functionality also requires a usable host desktop. Boot startup makes the core API available before GUI login; it does not remove these platform requirements.

Service files are separate from user data:

| Path | Purpose |
| --- | --- |
| `/Library/LaunchDaemons/com.tantawowa.device-deck.plist` | Boot startup registration, owned by root. |
| `/Library/Application Support/Device Deck/host.json` | Protected hosting-account registration. |
| `/Library/Application Support/Device Deck/access/UID.json` | Restricted connection credentials for one allowed Mac account. |
| `/Library/Logs/Device Deck/daemon.log` | Shared service diagnostics. |
| Host's `~/Library/Application Support/Device Deck` | Configuration, reservation store and service state. |
| Host's `~/Movies/Device Deck` | Default capture output; configurable by the host. |

Changing the hosting account is not implemented in the setup screen. Choose an existing account with the required SDKs, runtimes and device authorization. Keep source-build profiles separate from this installed profile.

## CI and other Mac accounts

The host grants existing users access in **Mac setup… → Mac account access**. For example, allow `ci-runner`, then run the installed CLI or MCP server from that account. They discover the protected host registration and that account's restricted endpoint credentials automatically. Do not copy the host's API token or start a second daemon under the runner account.

All allowed accounts reserve from the same inventory and observe the same exclusive reservations. Device operations run under the host's identity and use its SDKs, simulator inventory, ADB setup and paired devices. Only the host manages configuration, executable paths and account grants. Disabling a grant invalidates that account's credentials.

This shares Device Deck's API and locks, not macOS simulator homes. If a CI job passes a host-owned simulator UDID to native tools such as `xcodebuild` or `simctl`, those tools must execute under the host account as well.

An explicit `DEVICE_DECK_HOME` or `DEVICE_DECK_CONFIG` selects a separate development profile. Omit those overrides when a runner should use the shared installation. `DEVICE_DECK_HEADLESS=1` remains available for isolated source/development profiles; it is not necessary for a runner that uses the shared service.

The installer creates `/usr/local/bin/devdeck` only if that path is free or already points at the installed app. It preserves unrelated files and development links. If an older launcher wins in `PATH`, inspect it with `type -a devdeck`; the installed launcher is `/Applications/Device Deck.app/Contents/MacOS/devdeck`.

## Device-specific tools

Recording and screenshots use the bundled encoder. Other tools belong to the host account and depend on the selected device family.

| Capability | Host setup |
| --- | --- |
| Roku control | Reachable Roku with network control enabled. |
| USB capture | Host desktop available, menu-bar bridge running and Camera access allowed. |
| Android and Fire TV | Android platform tools, debugging enabled, device authorization accepted. |
| Android emulators | Android SDK and an AVD configured for the host. |
| Apple simulators | Xcode, selected runtimes and a usable host desktop; idb client and companion for touch. |
| Physical iPhone or iPad | WebDriverAgent and the helpers in [physical iOS setup](physical-ios.md). |
| Physical Apple TV | A Python environment containing pyatv, configured in Settings, and a paired TV. |

For developer-managed hosts, Android platform tools can be installed with `brew install --cask android-platform-tools`. Use the host's Settings for absolute executable paths when tools are outside the service's PATH. Installing one family's tools is not required to use another family.

## Signed public package

Import Developer ID Application and Developer ID Installer certificates from the same Apple team, with their private keys, into the build Mac's keychain. App Store distribution certificates cannot be used for these packages. Save notarization credentials with `xcrun notarytool store-credentials`.

```sh
export DEVICE_DECK_APPLICATION_IDENTITY='Developer ID Application: YOUR ORGANIZATION (TEAMID)'
export DEVICE_DECK_INSTALLER_IDENTITY='Developer ID Installer: YOUR ORGANIZATION (TEAMID)'
export DEVICE_DECK_NOTARY_PROFILE='device-deck'
npm run package:mac -- --release --media-bundle "$DEVICE_DECK_MEDIA_BUNDLE"
```

Alternatively, use a team App Store Connect API key directly. Keep the `.p8` file outside the repository and map existing private environment settings to these variables:

```sh
export DEVICE_DECK_NOTARY_KEY_ID="$APPLE_API_KEY_ID"
export DEVICE_DECK_NOTARY_ISSUER="$APPLE_API_ISSUER_ID"
export DEVICE_DECK_NOTARY_KEY_PATH="$APPLE_API_PRIVATE_KEY_FILE"
npm run package:mac -- --release --media-bundle "$DEVICE_DECK_MEDIA_BUNDLE"
```

The key path must be absolute and readable. Set all three API-key variables together. A complete API-key configuration takes precedence over `DEVICE_DECK_NOTARY_PROFILE`; partial API configuration fails even if a profile is set. The private key is passed to `notarytool` by path and is never included in the package. API authentication replaces only the notarization profile; both Developer ID signing identities are still required.

`--release` requires valid identities, notarization configuration and bundled media. The packager signs nested code and the app with the hardened runtime, signs and notarizes the installer, staples the ticket and verifies the result. It never falls back to unsigned output after a signing failure. Follow [release publishing](release-publishing.md) for CI secrets, both-architecture verification and immutable GitHub releases.

### Build in CI and keep signing keys on this Mac

Run the Mac workflow with publication disabled at the final merged commit. Both native runners build and prove unsigned packages with bundled media. Keep the Developer ID private keys in the local signing Mac's keychain; this route does not require uploading them to GitHub.

Before import, verify the successful workflow run's repository, exact commit and both native proof results. Record the immutable run and artifact IDs, verify each downloaded artifact archive against the SHA-256 supplied by GitHub's artifact API, then extract its installer, JSON metadata and checksum together into a private input directory. A matching sidecar alone does not establish the artifact's origin; the local command relies on that verified GitHub receipt.

Use a clean checkout at that exact merged commit, with the local signing and notarization environment configured above. Keep input and output directories separate. For example, substitute the verified full commit and downloaded filename:

```sh
npm run package:mac -- --release \
  --from-package "$HOME/hope-scratch/device-deck-ci-input/x64/device-deck-VERSION-macos-x64.pkg" \
  --expected-commit FULL_MERGED_COMMIT_SHA \
  --output "$HOME/hope-scratch/device-deck-signed/x64"
```

Repeat for `arm64`. Intel imports on Apple silicon require working Rosetta to run the bundled Node and encoder checks. The command checks the clean source commit, version, architecture, size, SHA-256, embedded metadata, package identity, installer scripts, source pins, app layout, library dependencies and ad-hoc code signatures before executing imported code. It rejects linked or writable payloads and unexpected native executables. It preserves the compiled native binaries, signs them locally, refreshes media checksums, seals the app and rebuilds the installer with this checkout's verified scripts. The signed metadata records the original package filename, size, SHA-256 and commit under `sourcePackage`.

Prove each signed result with a temporary copy of its bundled Node, so Intel checks use the Intel runtime even on an Apple silicon signing Mac. Run the verifier outside the app bundle: otherwise the installer's running-app check sees the verifier itself and correctly refuses replacement after the test daemon stops. A regular copy preserves the runtime and leaves the signed app unchanged; do not use a symlink.

```sh
(
set -eu
SIGNED_APP="$HOME/hope-scratch/device-deck-signed/x64/staging/x64/payload/Applications/Device Deck.app"
mkdir -p "$HOME/hope-scratch"
PROOF_RUNTIME=$(mktemp -d "$HOME/hope-scratch/device-deck-proof-runtime.XXXXXX")
trap 'rm -rf "$PROOF_RUNTIME"' EXIT
cp "$SIGNED_APP/Contents/Resources/runtime/bin/node" "$PROOF_RUNTIME/node"
cmp "$SIGNED_APP/Contents/Resources/runtime/bin/node" "$PROOF_RUNTIME/node"
"$PROOF_RUNTIME/node" scripts/proof-mac-package.mjs \
  --app "$SIGNED_APP" \
  --package "$HOME/hope-scratch/device-deck-signed/x64/device-deck-VERSION-macos-x64.pkg"
)
```

Retain both native CI proof results, local signed-package proof results and GitHub artifact receipts with the release evidence. Run the release artifact integrity gate against the final commit before uploading the two signed installers and their matching sidecars. A translated Intel proof does not replace the native Intel CI proof or clean-Mac acceptance.

## Updates and removal

Use **Check for updates… → Download update** in the menu-bar app. The download is verified before installation. **Install and reopen** requests administrator authorization, stops the idle shared service, installs the package and restarts it. **Install when idle** waits for reservations and recordings from every account to finish. The service enters maintenance before stopping so another client cannot acquire a device during replacement.

Configuration and captures survive the update. The installer rejects direct replacement while installed app processes are running. Use the graphical update flow for the shared service; merely quitting its menu-bar client does not stop it. Unsigned test packages and older public betas require a manual installer run and do not support the signed in-app update path.

Keep the previous installer and back up the host's profile before any release that migrates stored data. Roll back only when the previous version can read the current data, or restore the matching profile backup. Include any custom configuration file and external capture folder in that backup plan.

There is no graphical uninstaller yet. For a shared installation, an administrator must first finish all sessions, stop and remove the LaunchDaemon registration, then remove the app and its CLI link. Preserve the host's profile and captures unless their removal is explicitly wanted. Do not use the old `devdeck service uninstall` command as a shared-service uninstaller. For an older per-user installation, that command removes its login service before the app is moved to Trash.

## Clean-Mac acceptance

These checks require installed packages and real macOS account/session behavior. Unit tests and a staged-app proof do not establish them. They remain release acceptance work until results are recorded for the candidate.

- Download the signed package on a clean Apple silicon Mac and a clean Intel Mac. Confirm normal Gatekeeper opening and installation without Node, Homebrew or FFmpeg already installed.
- Open the app, complete the administrator prompt and verify the registered host account. Reopen setup and confirm it does not create a second service.
- Reboot, complete any FileVault disk unlock, and avoid logging in to the host desktop. Verify core API readiness through an allowed runner account and confirm reservations use the existing store.
- Log in to the host desktop, allow Camera access with Device Deck attribution, and record a real USB capture with annotation and screenshot output. Verify clear behavior when permission is denied or the host desktop becomes unavailable.
- Grant a second existing Mac account access in the GUI. From that account, run CLI and MCP operations without copied tokens. Confirm reservation contention across accounts, rejection of host-only configuration changes, and immediate revocation.
- Exercise the host's configured Apple simulator and Android emulator capabilities. Verify which remain available when its desktop is unavailable; do not describe simulator boot as proof of working video or touch.
- Update while another account owns a reservation or recording. Confirm installation waits, new work cannot race the stop, all clients reconnect, and existing data survives. Check failed download, rejected signature and failed installation recovery.
- Turn **Open at login** off and on. Confirm it changes only menu-bar startup and that **Quit menu-bar app** leaves the core service running.
