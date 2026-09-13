# Publish Mac packages through Keygen

`node scripts/release/publish-mac.mjs` validates packages and previews a release by default. It does not contact Keygen until `--apply` is supplied. Build with [the Mac packaging workflow](macos-distribution.md), commit the complete source, and rebuild so the package's embedded commit matches a clean checkout.

```sh
# Validate the actual package, embedded build metadata, size, and SHA-256.
node scripts/release/publish-mac.mjs \
  --metadata work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.json

# Upload and publish that TEST product's beta release.
node scripts/release/publish-mac.mjs \
  --metadata work/distribution/device-deck-0.5.0-beta.1-macos-arm64-test-team.json \
  --apply
```

Supply another `--metadata` for Intel in the same invocation if that architecture has been built and verified. All supplied packages must share a version. Team builds require TEST licensing, the team packaging channel, and a version such as `0.5.0-beta.1`. Their Keygen product must retain the `LICENSED` distribution strategy.

The operator environment needs `KEYGEN_ACCOUNT_ID` and `KEYGEN_TOKEN`. A token scoped to the relevant product needs only `product.read`, `release.read`, `release.create`, `release.publish`, `artifact.read`, `artifact.create`, and `artifact.update`. `KEYGEN_ADMIN_TOKEN` remains a compatibility alias; use a restricted product token for CI. Never bundle either token in the app.

The private release-signing key defaults to the ignored `work/release-secrets/release-signing.pem`. Override it with `DEVICE_DECK_RELEASE_SIGNING_KEY_FILE` or `--signing-key FILE`; its public key must match committed `config/releases/distribution.json`.

The publisher creates a draft release, creates its package artifacts, signs each exact artifact identity, and sends package bytes to Keygen's temporary storage upload address. The storage request has no Keygen credential. Publication happens after every requested upload reports `UPLOADED`. This follows the [Keygen artifact upload API](https://keygen.sh/docs/api/artifacts/) and [release publication API](https://keygen.sh/docs/api/releases/).

Each artifact's `metadata.deviceDeckManifest` contains `{payload, signature}`. `payload` is base64 JSON; the Ed25519 signature covers `device-deck-release/v1/` followed by that base64 payload. The signed data includes the account, product, release and artifact IDs, version, platform, architecture, filename, SHA-256, byte length, issue/expiry dates, package format, licensing mode, channel, signing status and minimum macOS version. Envelopes last 89 days and are also saved beside the package as `.manifest.json`. Client downloads verify these fields against compiled trust before accepting the package.

A successful identical rerun is read-only. Published versions are immutable in this workflow: build all desired architectures before publishing. If Keygen is still processing an upload, rerun once its status is uploaded. If an upload failed before reaching storage, use a new beta version; this script does not delete or replace remote artifacts automatically. A failure leaves a draft unpublished.

For a public release, supply `--release` in both packaging and publishing. The publisher requires a stable version, LIVE licensing, the `OPEN` product, and Developer ID notarized metadata. It independently rechecks the installer signature, stapled notarization, Gatekeeper assessment, embedded package identity and app signature before any upload. Team packages cannot be promoted by editing the sidecar metadata.
