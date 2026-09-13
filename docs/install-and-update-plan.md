# Proposed installation and update regime

Recommendation, 13 September 2026. This is an implementation plan; the commands and packages described as proposed below are not published. The existing account was checked read-only and has capacity for separate Device Deck production and test products without buying another Keygen subscription.

Use Lemon Squeezy for checkout and subscription administration, Keygen for Device Deck licenses and release hosting, and a signed Mac application distributed through one installer plus a Homebrew cask. Keep the current Free/Pro feature split. A new customer should be able to install and use Free before purchasing or entering a license.

## Distribution choices

| Component                   | Recommended responsibility                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device Deck Mac application | Own the daemon, capture helper, runtime, local web assets, CLI, TUI and MCP entry points.                                                                       |
| Signed and notarized `.pkg` | Install the application and stable `devdeck` command. Offer the same versioned package from the website and Homebrew.                                           |
| TantaWowa Homebrew tap      | Provide a cask for the Mac package and upgrades. An independent public tap avoids depending on acceptance into Homebrew's central repository.                   |
| Keygen                      | Issue and validate product-specific licenses; host immutable application releases and update metadata.                                                          |
| Lemon Squeezy               | Checkout, subscriptions, receipts and merchant-of-record responsibilities; feed authoritative billing changes into the issuer service.                          |
| npm                         | Optional developer convenience after the Mac package works. A small launcher should use the same release stream rather than create another independent install. |

Keygen's current Standard tiers include binary and npm distribution. Its product API supports public (`OPEN`) and license-gated (`LICENSED`) releases. For the current Free/Pro model, use public application downloads and require a license only to activate paid features. This is a proposed change from the protected-download installer scaffold; proprietary source can remain private. [Keygen pricing](https://keygen.sh/pricing/), [distribution strategies](https://keygen.sh/docs/api/products/).

Homebrew supports `.pkg` installers and CLI links through cask definitions. Use immutable version URLs and SHA-256 checksums, with a matching uninstall definition that removes software but preserves user data. Proposed install command: `brew install --cask tantawowa/tap/device-deck`. Verify the final tap name when publishing. [Homebrew cask documentation](https://docs.brew.sh/Cask-Cookbook).

## First installation

1. Build separate Apple Silicon and Intel artifacts. Ship only architectures that pass the hardware and lifecycle checks below.
2. Package a private Node runtime alongside the existing bundled JavaScript, web assets and compiled capture helper. Users should not need npm, NVM, Xcode or a TypeScript build to launch the product.
3. Sign the application and nested executable code, then sign, notarize and staple the installer using the appropriate Apple Developer ID identities. Retain stable application/helper identifiers across versions. [Apple notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
4. Install a stable CLI launcher into a standard command directory, handling an existing development launcher or another installation explicitly. CLI, TUI, MCP and the web UI must reach the same selected application/profile.
5. On first launch, initialize the user profile and offer launch-at-login. The capture service must run as the user; installer privileges must not become daemon privileges.
6. Request camera access from the Device Deck application. Prove on a clean Mac that permission attribution and reuse work when later launched through the CLI and after an upgrade. The development helper currently inherits its launching application's permission identity.
7. Discover devices and capture cards, offer bulk add, and show all usable feeds immediately. Make USB bindings explicit.
8. Show adapter readiness per platform. Bundle permitted capture dependencies or provide targeted setup for them. Keep Xcode/simulator tooling, ADB authorization and TV pairing conditional on the selected device; do not require every SDK for USB/Roku users.

The first supported distribution should bundle the runtime, rather than depend on the customer's global Node installation. A single executable can be evaluated later, but it still needs web assets and platform helpers, and packaging does not make local JavaScript impossible to inspect. Node offers single executable applications; Device Deck's complete daemon/helper lifecycle has not been proved in that format. [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html).

## Licensing and purchase

Create distinct `device-deck` and `device-deck-test` Keygen products. Pin product-specific public trust, Pro/trial policies and the existing feature entitlements in the release. Retain the normal signed-certificate and offline-expiry verification. An owner license should be an ordinary complimentary license.

Complete the existing Lemon Squeezy bridge so a successful purchase creates or reuses the correct Keygen customer/license, delivers activation instructions, and reconciles renewals, cancellation, expiry, refunds and chargebacks idempotently. Keep Lemon's own key generation disabled while Keygen is the authority. Test the lifecycle against provider test mode before enabling paid checkout.

Lemon Squeezy can alternatively provide native license keys, purchased file downloads and file versions. A desktop updater still needs application-side integration. Its file API returns expiring, rate-limited download URLs, so those URLs should not be pasted into a static Homebrew cask. Retaining Keygen fits our existing signed offline-license implementation and already-paid distribution capacity. [Lemon file versions](https://docs.lemonsqueezy.com/help/products/managing-file-versions), [file API](https://docs.lemonsqueezy.com/api/files/the-file-object), [native licensing](https://docs.lemonsqueezy.com/help/licensing/generating-license-keys).

## Updates and rollback

Publish immutable, signed releases with architecture, minimum OS, version, checksum and size. Keep stable and beta channels separate. Do not make a moving `latest` artifact the integrity anchor.

Homebrew installations use `brew upgrade --cask device-deck`. Direct installations offer Check for Updates and launch the verified installer; an automatic updater can follow once this flow works. Record installation ownership so the in-app updater does not overwrite a Homebrew-managed installation.

Stage and verify an update before changing the active application. Defer replacement while any client has a reservation or recording; never kill an active capture to upgrade. Stop an idle daemon cleanly, back up configuration/database state before migrations, install, restart and check health. On failure, restore the previous compatible application and data snapshot. Preserve captures, device identities, pairings and licenses. Keep rollback constrained by data-schema compatibility.

The CLI currently uses `devdeck install` for login-service installation, while the npm scaffold also uses `install` for runtime downloads. Resolve that command collision before publishing: use explicit `service install/uninstall` commands and reserve package installation/update commands for the application runtime, with compatibility aliases where appropriate.

## Work remaining in this repository

| Existing foundation                                                             | Required release work                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bundled CLI, daemon, TUI, MCP, web assets and Swift helper                      | Self-contained application package, signed/notarized artifacts, Intel validation and consistent launch identity.         |
| Signed release metadata, archive verification and versioned protected installer | Public Free onboarding/downloads, release publishing, stable launch path, channel selection and safe upgrade/rollback.   |
| Real Keygen validation and offline certificates                                 | Provision Device Deck products/policies and replace the null release trust configuration.                                |
| Subscription reconciliation bridge                                              | Automatic purchase-to-license issuance/delivery, refund/chargeback coverage and provider sandbox verification.           |
| npm installer package                                                           | Choose wrapper behavior, eliminate command collisions and intentionally configure publication. It remains private today. |

Release checks: clean Mac with no Node; launch through app, CLI, TUI and MCP; camera permission attributed correctly; three simultaneous USB feeds; concurrent capture; bulk discovery; Free-to-Pro activation; offline expiry; cancellation/refund; upgrade deferral during recording; rollback; uninstall preserving captures and settings. None of the proposed publishing, account provisioning or billing changes has been performed by writing this plan.
