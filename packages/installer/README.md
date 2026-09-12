# Device Deck private installer scaffold

This package contains a launcher and protected-download installer. Its source repository stays private. It is marked private to prevent publication until release setup is approved.

The compiled trust settings are intentionally unconfigured. Supply reviewed Keygen account/product IDs and a release metadata signing public key in source, then build. No command-line flag, environment variable or local configuration can replace those trust anchors.

After setup, `devdeck install signed-release.json private-license-key-file` authenticates with Keygen, checks signed release identity and expiry, verifies the archive SHA-256 and size, rejects unsafe archive entries, and installs a versioned runtime without stopping a daemon. Other commands forward to that runtime. Node 24 and the platform tools are required.

A protected download requires an issuer-provided license even when the app will run Free. Free/trial onboarding and automatic purchase-to-license issuance/delivery are pending service work. This is not anonymously installable yet. Download authorization never grants Pro features; the daemon verifies the same signed feature certificate for customers and the owner.

Signed download metadata expires within 90 days for new installs. Installed runtimes retain signature, product and path checks and remain launchable after download metadata expires. The daemon's signed license proof controls paid feature expiry.

Minification and private distribution deter casual inspection. They do not make local code uncrackable. The current runtime includes minified JavaScript and a required Python bridge. Full application executable packaging, Developer ID signing and notarization are unproven.
