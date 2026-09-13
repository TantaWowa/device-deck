# Licensing and billing, version 0.5.0-beta.1

Device Deck has separate live and test Keygen products, with Pro and trial policies and compiled public trust. Real TEST activation, signed machine checkout verification, refresh and deactivation have passed on the build Mac in an isolated profile. A normal complimentary owner license has been issued; customer builds use the same verification path.

The team Mac installer and scoped GitHub release credentials are configured. Paid checkout still needs the chosen Lemon Squeezy store/variant, server credentials and HTTPS deployment, followed by provider test-mode acceptance. See [team rollout](team-rollout.md), [Mac packaging](macos-distribution.md) and [billing deployment](../apps/billing/README.md).

## Product policy

For development with real hardware, the repository-only `scripts/service-local.ts` entry point injects an explicitly labelled active Pro mock. Start it with the repository-root `./devdeck start` wrapper or `npm run service:local`; its default profile is `work/local-deck/`. This mock never contacts Keygen or Lemon Squeezy and is excluded from customer bundles. The production daemon still uses the real license manager described below. USB feed observation, including the grid, does not reserve devices and is available on Free too.

| Capability                                                                       | Free                                                                      | Pro or issuer-provided trial |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Inventory, discovery, input, basic capture, capture library, exports and reports | Available through every interface                                         | Available                    |
| New active device sessions                                                       | At most one, including sessions still closing                             | Concurrent sessions          |
| New annotated recordings                                                         | Unavailable; use clean recording                                          | Available                    |
| Existing work after paid access ends                                             | Keeps its original bounded lease; input and stop/release remain available | Same cleanup behavior        |

The daemon owns admission and feature checks. Web, CLI, TUI, HTTP and MCP cannot select a paid tier. Device/source collision rules apply to every tier. Extra sessions cannot renew after entitlement loss. A running annotated recording also cannot extend its lease without Pro, but license refresh, deactivation and connectivity loss never stop that recording unexpectedly. Normal lease expiry, explicit stop/release/takeover, recording duration limits and daemon shutdown still finalize captures. Existing files and reports remain accessible. Screenshot annotation behavior is unchanged in this slice; the paid annotation feature applies to recordings.

The dashboard has License & Upgrade and a reminder dismissible for seven days. The reminder preference changes only presentation. A trial requires an explicitly issued Keygen license on the pinned trial policy. No local trial start, owner exemption, paid flag or environment/configuration override grants features.

## Keygen trust and verification

Keygen is the sole license authority. Lemon Squeezy subscription state never reaches the app as an entitlement flag. `config/releases/keygen.json` holds reviewed public product/policy IDs and the account Ed25519 public key. `packages/licensing/src/trust.ts` compiles the selected identity into each release. Build with `npm run build:local -- --mode test` or `--mode live`; runtime environment/configuration cannot change the trust anchors. `npm run package:mac` defaults to TEST team builds; `--release` selects LIVE and requires Developer ID signing and notarization.

`npm run release:keygen` previews the idempotent account setup; `-- --apply` provisions only Device Deck resources within the existing plan. Existing Hosanna products are not changed. Current usage is four of five products: Hosanna UI Source, hosanna-transpiler, Device Deck, and Device Deck Test.

Never use Hosanna's product or an issuer/admin token in the app. A complimentary owner license is a normal Keygen Pro license with the same required fields and features as a customer's license. Issue it explicitly; do not exempt an owner name or machine. The same protected application accepts both.

Configure node-locked Pro and optional trial policies with finite expiry, one allowed Mac, product/fingerprint scopes, no overage, and both entitlements:

- `DEVICE_DECK_CONCURRENT_SESSIONS`
- `DEVICE_DECK_RECORDING_ANNOTATIONS`

Set `authenticationStrategy: LICENSE` so the app can authenticate with `Authorization: License <key>`. The default `TOKEN` strategy is incompatible. Use `expirationBasis: FROM_CREATION`, a finite duration, and `expirationStrategy: REVOKE_ACCESS`. Use compatible cryptographic and fingerprint strategies for the two policies and `transferStrategy: KEEP_EXPIRY`. Do not enable a heartbeat/check-in requirement in this first integration. License keys need permissions for their own validation, machine activation/read/deactivation/checkout, license read and entitlement read. Ensure product/fingerprint scoping is required. The signed license metadata must contain `deviceDeckMode: "test"` or `"live"`, matching the compiled release. Keep test and live products, checkout variants, webhook secrets and server state separate.

The Mac fingerprint hashes its IOPlatformUUID with a Device Deck namespace. Online validation requires a literal valid result and `VALID` code, matching nonce, product, fingerprint and requested feature scopes. It independently checks returned account/product/key/policy/mode/expiry and suspension state. Only documented unactivated-machine results permit the activation step, followed by a second successful scoped validation.

Machine checkout requests `aes-256-gcm+ed25519`, includes the license and its entitlements, and sets a 24-hour TTL. Verification authenticates the domain-prefixed signature before decoding/decrypting, matches the machine and license identities, checks the pinned account/product/policy/mode, both features, and both certificate and license expiry. It rejects unsupported algorithms, missing dates, future issuance, duplicate resources and excessive TTLs. The verifier also supports signed license-file documents that include the matching machine; the app currently obtains machine files online and has no file-import UI.

The app refreshes every six hours, retries transient failure after five minutes, and never extends offline access beyond signed expiry. An authoritative rejection removes Pro immediately for new operations. License keys and signed proof are stored in the private profile's `license.json`, mode 0600, and never returned in inventory/status. Clock high-water checks and a monotonic running clock prevent an in-process clock rollback extending access. A user who controls their Mac can still patch code or restore system/state snapshots; this is not a trusted execution environment.

These choices follow Keygen's [offline certificate contract](https://keygen.sh/docs/api/cryptography/), [machine checkout API](https://keygen.sh/docs/api/machines/#machines-actions-check-out), and [scoped license validation](https://keygen.sh/docs/api/licenses/#licenses-actions-validate-key). Account trust anchors are compiled into the app, following the provider's guidance. The real TEST provider activation and encrypted checkout shape have been verified; billing lifecycle tests against Lemon Squeezy remain a separate acceptance step.

```sh
./devdeck license status --json
./devdeck license activate /private/path/device-deck-license.key
./devdeck license refresh --json
./devdeck license deactivate --json
```

HTTP operations are `license.status`, `license.activate`, `license.refresh` and `license.deactivate`. MCP exposes their underscore names. The TUI shows the tier and has a License status view. The dashboard can activate, refresh and deactivate. Use a private key file with the CLI so the license does not enter shell history or process arguments.

## Complimentary team licenses

Create an ignored private members file and preview issuance:

```sh
npm run release:team-license -- --members work/release-secrets/team.json --mode test
npm run release:team-license -- --members work/release-secrets/team.json --mode test --apply
```

The file contains an array of `{ "email": "person@example.com", "firstName": "Person", "lastName": "Name" }`. The default grant is 60 days of Pro on one Mac. The script reuses a campaign license and never silently extends expiry, replaces a held license, or sends email. Keys and delivery records are saved with owner-only permissions under ignored `work/release-secrets/team/`. Share each person's own key privately. Test keys cannot activate live builds.

## Lemon Squeezy billing service

`apps/billing` is an operator service excluded from desktop bundles. It now creates or reuses the scoped Keygen customer and license, recovers ambiguous issuance failures, reconciles subscriptions, and provides expiring browser license retrieval. It verifies raw webhook signatures and checks the configured store, product, variant and test/live mode before processing events. Fresh provider API data controls expiry; a webhook does not independently grant access.

Renewals, cancellations, trial conversion, payment failures and expiry are reconciled against the durable ledger. Refund checks are limited to the matching order/subscription invoices; partial refunds require review. Access holds are sticky until an authenticated operator explicitly releases them. Lemon Squeezy has no documented chargeback webhook in the implemented event set, so chargeback handling is an explicit operator hold/release workflow, not a claimed automatic feed.

Leave Lemon Squeezy native license-key generation disabled while Keygen issues Device Deck keys. No customer email is sent by this implementation; checkout return pages and expiring operator-generated retrieval links deliver the matching license securely.

See [the billing runbook](../apps/billing/README.md) for exact environment variables, test/live configuration, Docker/Caddy deployment, webhook events, preflight, retry/hold/retrieval commands and backup/recovery. A SQLite transaction lock prevents multiple workers and releases automatically after process death, including container restarts. Keep each mode's database, credentials and signing/retrieval secrets separate.

Local automated tests cover HTTP authorization, browser Origin/cookie handling, idempotent issuance and retries, trial/payment transitions, scoped refunds, persistent holds and crash recovery. Real Lemon checkout and production HTTPS deployment await the operator's store and hosting choices.

## Application distribution

The Mac installer contains a stable app identity, private pinned Node runtime, minified JavaScript, native capture helper, web assets and third-party notices. It excludes development mocks, source maps, account admin tokens, private release keys, user profiles and capture data. JavaScript bundling does not make the program impossible to inspect.

The TEST Keygen product uses license-gated distribution. The LIVE product uses public distribution so people can install Free before activating Pro. [Release publishing](release-publishing.md) signs immutable package identity, hash, size and expiry with the separate release key. The CLI and menu-bar updater check those signatures against compiled trust. Downloads are staged; replacement is explicit and the installer refuses to replace a running app.

`packages/installer` retains the older protected archive/npm launcher for compatibility. It remains private and unpublished; the supported delivery route is the Mac `.pkg`. Homebrew casks can be generated from verified signed public manifests with `npm run release:cask`; no public cask or npm package is advertised as published yet.

## Remaining market acceptance

1. Install Developer ID Application/Installer identities and configure notarization; build and independently verify the public package.
2. Confirm Camera permission attribution on a clean Mac, three simultaneous feeds, real recording, pairing, upgrade deferral and uninstall preserving data. The isolated staged-app proof does not replace these checks.
3. Complete a real Lemon test checkout, license retrieval/activation, renewal, failure, cancellation, refund and operator hold/release against the deployed service.
4. Verify the signed public download and generated Homebrew cask, then publish the reviewed stable release and tap.
