# Publish Mac installers

The Mac distribution workflow builds Apple silicon and Intel packages on matching runners. Pull requests and runs without `publish` produce unsigned test artifacts. Publishing from `main` requires Developer ID signing, Apple notarization and bundled FFmpeg. Missing signing configuration fails the build; it does not publish an unsigned fallback.

The `0.9.0-beta.2` installers predate this workflow and remain unsigned. Version `0.9.0-beta.3` introduces the signed setup. Record the [clean-Mac acceptance checks](macos-distribution.md#clean-mac-acceptance) separately and state any outstanding beta acceptance work in the release notes. Publishing a release does not replace older assets or deploy the website.

To keep private signing keys on a local Mac, run the native CI builds with publication disabled, then follow [local signing of verified CI packages](macos-distribution.md#build-in-ci-and-keep-signing-keys-on-this-mac). That route uses the same signature, notarization and package verification requirements without configuring GitHub signing secrets. The steps below describe signing and publishing directly in CI.

## Configure release signing

Add these repository Actions secrets for the two Developer ID certificates. App Store distribution certificates do not replace Developer ID certificates.

| Secret | Value |
| --- | --- |
| `DEVICE_DECK_APPLICATION_P12` | Base64 PKCS#12 export of the Developer ID Application certificate and private key. |
| `DEVICE_DECK_INSTALLER_P12` | Base64 PKCS#12 export of the Developer ID Installer certificate and private key. |
| `DEVICE_DECK_P12_PASSWORD` | Password used for both certificate exports. |
| `DEVICE_DECK_APPLE_TEAM_ID` | Developer team identifier. |

Then configure notarization using a team App Store Connect API key:

| Secret | Value |
| --- | --- |
| `DEVICE_DECK_NOTARY_KEY_ID` | App Store Connect API key identifier. |
| `DEVICE_DECK_NOTARY_ISSUER` | The API key's issuer UUID. |
| `DEVICE_DECK_NOTARY_PRIVATE_KEY` | Complete private `.p8` key contents, including PEM header, footer and newlines. |

Alternatively, leave all three API-key secrets unset and use an Apple account:

| Secret | Value |
| --- | --- |
| `DEVICE_DECK_APPLE_ID` | Apple account used for notarization. |
| `DEVICE_DECK_APPLE_APP_PASSWORD` | App-specific password for notarization. |

A complete API-key configuration takes precedence when both methods are configured. A partial API-key configuration fails before any keychain changes; it does not fall back to the Apple account. These settings support team API keys, which require an issuer UUID.

The signing helper imports the certificates into a temporary runner keychain, derives identities from the configured team, and stores a temporary notarization profile. For API authentication it writes a private temporary `.p8` file and removes it immediately after saving the profile. Only certificate identities and the profile name pass to later steps. Cleanup restores the previous keychain configuration and removes the temporary credentials. Do not commit certificate exports, private keys or passwords.

## Build and publish

1. Increment `package.json` to a new version. Existing release assets are immutable and are not overwritten.
2. Complete the clean-Mac checks for the candidate on each supported architecture. Keep any unverified behavior explicit in the release notes.
3. Run **Mac distribution** on `main` with **publish** enabled.
4. Confirm both architecture jobs and the publication job finish successfully. Check the published `.pkg`, `.pkg.sha256` and metadata JSON for both architectures.

Each job builds FFmpeg and its static dependencies from `scripts/distribution/media-sources.json`, verifies the source checksums, and includes matching sources, notices and the build recipe. Tests use that encoder bundle. The package proof checks the actual installer payload as well as the staged application's lifecycle.

The packager signs executable code and the application, signs the installer, submits it to Apple's notarization service, staples the ticket and verifies it. The release gate checks both architectures, version, commit, bundled-media metadata, checksums and signing status before publication. An Apple signing or notarization failure must be resolved before publishing.

Downloads are public and require no Device Deck license. The graphical updater downloads and verifies the installer, waits for the shared service to become idle, requests administrator authorization, and restarts the service after installation. Old unsigned betas still require a manual installer run.

After the signed release is available, deploy the website separately if its content changed. Keep the download page linked to the release list so it does not point at a version that has not been published.
