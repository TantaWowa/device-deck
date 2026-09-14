# Installation and distribution regime

Device Deck ships as a Mac application inside a `.pkg`. The app includes its Node runtime, web dashboard, daemon, CLI, TUI, MCP entry point and native capture helper. Team releases use the separate TEST Keygen product; signed public releases use LIVE. The operator commands are in [Mac packaging](macos-distribution.md), [release publishing](release-publishing.md), and [team rollout](team-rollout.md).

| Component | Responsibility and current state |
| --- | --- |
| Mac application and installer | Implemented and proved with an isolated staged profile. Public signing/notarization requires Apple identities. |
| Keygen | Separate products, Pro/trial policies, public trust and ordinary owner license provisioned. Real activation/refresh/deactivation verified. |
| GitHub Actions | Matching Apple Silicon/Intel build jobs, package proof, and one publication step for all architecture artifacts. Scoped team/public credentials configured; public environment restricted to main. |
| Update client | Verifies signed release identity and hash, then downloads a package for explicit installation. The installer rejects replacement while the app is running. |
| Homebrew | Cask generator consumes signed public manifests; publish the reviewed output to a public TantaWowa tap after stable acceptance. |
| Lemon Squeezy | Automatic issuance/reconciliation and browser retrieval implemented, with a persistent Docker/Caddy deployment. Real store credentials, hosting and test checkout remain to be supplied. |
| npm | Private legacy launcher retained. The Mac installer is the supported initial route. |

The existing Keygen Std 1 account permits five products; four are now used, including the two existing Hosanna products. No additional subscription was purchased. Its distribution API supports public (`OPEN`) and license-gated (`LICENSED`) products; Device Deck uses both for live/test separation. [Keygen distribution strategies](https://keygen.sh/docs/api/products/).

Lemon Squeezy can host purchased files and generate its own license keys, but Device Deck already verifies Keygen's signed offline certificates. Keep Lemon responsible for checkout/subscription administration and Keygen responsible for licenses and immutable releases. Leave Lemon's native license-key generation off to avoid issuing an incompatible second key. [Lemon file API](https://docs.lemonsqueezy.com/api/files/the-file-object), [native licensing](https://docs.lemonsqueezy.com/help/licensing/generating-license-keys).

The current team package requires external FFmpeg for recording and USB screenshots; Roku control and USB preview are included. The app offers targeted Capture setup instructions. A future bundled encoder must include a verified relocatable dependency set and the matching source/license materials, as enforced by the packaging script.

Upgrades preserve user profiles, licenses, pairings and capture files. Finish reservations and recordings, quit the app, then install the verified package. Keep the previous compatible installer and a stopped-profile backup before accepting a data migration. Homebrew users should upgrade through Homebrew. No automatic application replacement or rollback is claimed in this beta.

Before public distribution, complete clean-Mac Camera/Gatekeeper/capture checks and genuine Lemon test-mode lifecycle tests, then sign, notarize and staple the public installer. [Apple notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
