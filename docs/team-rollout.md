# Deploying the team beta

Use `0.5.0-beta.1` with the TEST Keygen product. The Mac package includes Node; teammates do not build TypeScript or install npm. This is an internal beta with an unsigned installer and ad-hoc app signature. Public releases use the separate signed/notarized path.

## Prepare the handoff

1. Commit the source and run `npm run check`, `npm test`, and `npm run test:distribution`.
2. Build with `npm run package:mac -- --mode test` on the matching architecture. The GitHub **Mac distribution** workflow builds and proves both architectures before one publication; a pull request runs build/proof only.
3. Run `npm run proof:mac -- --app 'work/distribution/staging/arm64-test/payload/Applications/Device Deck.app' --package work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.pkg` for the local Apple Silicon build.
4. Publish the verified architecture packages together using [the release publisher](release-publishing.md). A published version cannot have more architectures appended; increment the beta number for later additions.
5. Put teammate names/emails in an ignored private JSON file. Run `npm run release:team-license -- --members work/release-secrets/team.json --mode test`, review the preview, then add `--apply`. This issues normal 60-day Pro licenses and private key files, without sending messages.
6. Share the matching installer, its own build's checksum and each person's own key through the team's normal channel. The TEST product requires license authentication, so a bare Keygen URL is not a first-install download link. Include the limitations below. Never share the release-signing PEM, provider tokens, billing secrets or another teammate's key.

## Teammate setup

Verify the supplied `.sha256` file with `shasum -a 256 -c FILE.pkg.sha256`, open the installer, then open **Device Deck.app** in Applications. Follow your organization's process if its Mac policy blocks unsigned internal packages. Public distribution must use the signed release path; do not disable Gatekeeper globally.

Install `ffmpeg` only if recording or USB screenshots are needed:

```sh
brew install ffmpeg
devdeck version
devdeck service start
devdeck license activate /private/path/my-device-deck.key
devdeck doctor
devdeck ui
devdeck tui
```

Allow Camera access when prompted for the capture feed. Open Devices → Discover / add devices, select multiple devices or Add all, then bind each USB capture card to its target. Use Feeds → Split screen to watch all selected cards. The CLI equivalent is `devdeck view --mux`, or `devdeck view` with Left/Right browsing. Device rows expose simulator Launch/Close and remote/capture actions; the TUI uses **O** for simulator lifecycle.

If `devdeck` resolves to an old development launcher, inspect `type -a devdeck`. The installed command is also available at `'/Applications/Device Deck.app/Contents/MacOS/devdeck'`. The installer preserves an unrelated existing launcher.

## Acceptance before the wider team

On at least one clean Mac, verify app/CLI/TUI launch, permission attribution to Device Deck, all intended USB feeds, a real saved recording, input/pairing for the selected platforms, Pro activation, and a safe upgrade. The staged proof validates process ownership, Free startup, web assets and shutdown but cannot grant or verify another Mac's camera permission.

Current limits: video is silent; USB preview is refresh-based; external FFmpeg is required for recording; Xcode/runtimes are required for Apple simulators; Android requires its SDK/authorization; physical Apple TV requires pyatv/pairing. Remote visual styles do not implement Samsung/LG network adapters.

## Release operation

`devdeck update check` verifies the configured channel. `devdeck update download` stages a verified matching installer. Finish reservations/recordings and quit the app before applying it. `devdeck service install` enables login startup; `devdeck service uninstall` removes that startup configuration while preserving profiles and captures.

The GitHub release environments are `device-deck-team` and `device-deck-public`. They contain product-scoped publish tokens and the encrypted release-signing key, not the Keygen account admin credential. Public publication additionally needs Developer ID certificates/notarization, stable package version, and a run from main. Each publish token's receipt and expiry are stored privately in `work/release-secrets`. Rotation requires an operator to revoke or replace the provider token, replace its private receipt, and update the GitHub environment secret; rerunning setup alone reuses an existing unexpired token.

For market launch, finish [billing deployment and real test checkout](../apps/billing/README.md), supply the Apple identities, validate a signed public package, and generate/review/publish the Homebrew cask. Those external acceptance steps are not implied by a passing local build.
