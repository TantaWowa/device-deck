# Licensing and billing foundation, version 0.4.0

This candidate is unconfigured Free. No real Lemon Squeezy checkout, Keygen activation, owner license, protected download, npm publication or public billing endpoint has been provisioned or exercised. The installed 0.3.0 review application and its inventory/captures remain separate and unchanged.

## Provisional product policy

| Capability                                                                       | Free                                                                      | Pro or issuer-provided trial |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Inventory, discovery, input, basic capture, capture library, exports and reports | Available through every interface                                         | Available                    |
| New active device sessions                                                       | At most one, including sessions still closing                             | Concurrent sessions          |
| New annotated recordings                                                         | Unavailable; use clean recording                                          | Available                    |
| Existing work after paid access ends                                             | Keeps its original bounded lease; input and stop/release remain available | Same cleanup behavior        |

The daemon owns admission and feature checks. Web, CLI, TUI, HTTP and MCP cannot select a paid tier. Device/source collision rules apply to every tier. Extra sessions cannot renew after entitlement loss. A running annotated recording also cannot extend its lease without Pro, but license refresh, deactivation and connectivity loss never stop that recording unexpectedly. Normal lease expiry, explicit stop/release/takeover, recording duration limits and daemon shutdown still finalize captures. Existing files and reports remain accessible. Screenshot annotation behavior is unchanged in this slice; the paid annotation feature applies to recordings.

The dashboard has License & Upgrade and a reminder dismissible for seven days. The reminder preference changes only presentation. A trial requires an explicitly issued Keygen license on the pinned trial policy. No local trial start, owner exemption, paid flag or environment/configuration override grants features.

## Keygen trust and verification

Keygen is the sole license authority. Lemon Squeezy subscription state never reaches the app as an entitlement flag. `packages/licensing/src/trust.ts` contains the release-owned public trust configuration, currently `null`. Populate it through a reviewed source change and rebuild:

```ts
{
  mode: "test", // Use a separate reviewed live release and provider product for live billing.
  accountId: "KEYGEN_ACCOUNT_UUID",
  productId: "DEVICE_DECK_PRODUCT_UUID",
  publicKey: "64_HEX_CHAR_ACCOUNT_ED25519_PUBLIC_KEY",
  proPolicyId: "DEVICE_DECK_PRO_POLICY_UUID",
  trialPolicyId: "OPTIONAL_DEVICE_DECK_TRIAL_POLICY_UUID",
  checkoutUrl: "https://YOUR_STORE.lemonsqueezy.com/buy/YOUR_CHECKOUT_ID"
}
```

Never use Hosanna's product or an issuer/admin token in the app. A complimentary owner license is a normal Keygen Pro license with the same required fields and features as a customer's license. Issue it explicitly; do not exempt an owner name or machine. The same protected application accepts both.

Configure node-locked Pro and optional trial policies with finite expiry, one allowed Mac, product/fingerprint scopes, no overage, and both entitlements:

- `DEVICE_DECK_CONCURRENT_SESSIONS`
- `DEVICE_DECK_RECORDING_ANNOTATIONS`

Set `authenticationStrategy: LICENSE` so the app can authenticate with `Authorization: License <key>`. The default `TOKEN` strategy is incompatible. Use `expirationBasis: FROM_CREATION`, a finite duration, and `expirationStrategy: REVOKE_ACCESS`. Use compatible cryptographic and fingerprint strategies for the two policies and `transferStrategy: KEEP_EXPIRY`. Do not enable a heartbeat/check-in requirement in this first integration. License keys need permissions for their own validation, machine activation/read/deactivation/checkout, license read and entitlement read. Ensure product/fingerprint scoping is required. The signed license metadata must contain `deviceDeckMode: "test"` or `"live"`, matching the compiled release. Keep test and live products, checkout variants, webhook secrets and server state separate.

The Mac fingerprint hashes its IOPlatformUUID with a Device Deck namespace. Online validation requires a literal valid result and `VALID` code, matching nonce, product, fingerprint and requested feature scopes. It independently checks returned account/product/key/policy/mode/expiry and suspension state. Only documented unactivated-machine results permit the activation step, followed by a second successful scoped validation.

Machine checkout requests `aes-256-gcm+ed25519`, includes the license and its entitlements, and sets a 24-hour TTL. Verification authenticates the domain-prefixed signature before decoding/decrypting, matches the machine and license identities, checks the pinned account/product/policy/mode, both features, and both certificate and license expiry. It rejects unsupported algorithms, missing dates, future issuance, duplicate resources and excessive TTLs. The verifier also supports signed license-file documents that include the matching machine; the app currently obtains machine files online and has no file-import UI.

The app refreshes every six hours, retries transient failure after five minutes, and never extends offline access beyond signed expiry. An authoritative rejection removes Pro immediately for new operations. License keys and signed proof are stored in the private profile's `license.json`, mode 0600, and never returned in inventory/status. Clock high-water checks and a monotonic running clock prevent an in-process clock rollback extending access. A user who controls their Mac can still patch code or restore system/state snapshots; this is not a trusted execution environment.

These choices follow Keygen's [offline certificate contract](https://keygen.sh/docs/api/cryptography/), [machine checkout API](https://keygen.sh/docs/api/machines/#machines-actions-check-out), and [scoped license validation](https://keygen.sh/docs/api/licenses/#licenses-actions-validate-key). Account trust anchors are compiled into the app, following the provider's guidance. Provider activation and certificate shape still require real sandbox verification before release.

```sh
./devdeck license status --json
./devdeck license activate /private/path/device-deck-license.key
./devdeck license refresh --json
./devdeck license deactivate --json
```

HTTP operations are `license.status`, `license.activate`, `license.refresh` and `license.deactivate`. MCP exposes their underscore names. The TUI shows the tier and has a License status view. The dashboard can activate, refresh and deactivate. Use a private key file with the CLI so the license does not enter shell history or process arguments.

## Server-side Lemon Squeezy bridge

`apps/billing` is a separate operator service, excluded from customer bundles. Hosted checkout is a reviewed Lemon Squeezy URL. The current service reconciles explicitly registered licenses; it does not create or email license keys. Unmapped subscription events remain durably queued as `awaiting-issuer`. An operator must issue the genuine Keygen license, register its subscription binding and deliver the key securely. Automated issuance/delivery and Free-download onboarding remain service work.

Leave Lemon Squeezy native license-key generation disabled for this product. Keygen is the only license issuer; enabling both could email customers an incompatible Lemon Squeezy key while their Keygen license is still awaiting issuance.

The worker verifies HMAC-SHA256 over the exact raw webhook bytes, checks store/product/variant/test mode, persists a body digest and subscription ID, then reconciles in one worker against fresh subscription API data. It never trusts a webhook's expiry alone. Duplicate deliveries are idempotent, stale provider versions cannot overwrite newer ledger state, failed provider calls retry with backoff, and an hourly reconciliation also covers registered subscriptions. Only configured lifecycle events are accepted. Payment-invoice events and automatic refund/chargeback handling are outside this slice; issuer suspension remains the operator control for those cases.

| Authoritative subscription state | Keygen expiry decision                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Active                           | Current cycle end, `renews_at`; this slice supports monthly/annual terms up to 400 days                                    |
| Cancelled                        | `ends_at`, retaining access through the paid period                                                                        |
| Past due / unpaid                | Last confirmed paid-through time from the durable ledger; a retry date grants no new time                                  |
| Expired                          | The elapsed `ends_at`                                                                                                      |
| On trial                         | Explicitly registered trial license through `trial_ends_at`                                                                |
| Paused, void                     | Retain confirmed paid-through time without extension                                                                       |
| Paused, free                     | Explicit provider-side complimentary access, refreshed in grants of at most one day, retaining any later paid-through time |

The worker can convert a registered trial license to only the pinned Pro policy. It first verifies the target's `KEEP_EXPIRY`, writes the authoritative expiry, then changes policy. Retries repeat the same bounded operations. It never clears an operator suspension. The provider documents [cancellation, dunning and pause semantics](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object), [raw webhook signatures](https://docs.lemonsqueezy.com/help/webhooks/signing-requests), and Keygen's [policy transfer behavior](https://keygen.sh/docs/api/policies/).

Create a private server JSON file with this exact shape, using real IDs after provisioning:

```json
{
  "storeId": 1,
  "productId": 2,
  "variantId": 3,
  "testMode": true,
  "keygenAccountId": "KEYGEN_ACCOUNT_UUID",
  "keygenProductId": "DEVICE_DECK_PRODUCT_UUID",
  "keygenProPolicyId": "DEVICE_DECK_PRO_POLICY_UUID",
  "keygenTrialPolicyId": "DEVICE_DECK_TRIAL_POLICY_UUID",
  "bindings": [
    {
      "subscriptionId": "LEMON_SUBSCRIPTION_ID",
      "licenseId": "KEYGEN_LICENSE_UUID"
    }
  ]
}
```

Each registered license must have metadata `lemonSubscriptionId` as a string, `lemonTestMode` as a boolean, and `deviceDeckMode` as `test` or `live`. All must match the operator configuration. Each license and subscription may occur in only one binding. Use the same compatible product and policies as the app.

Required server-only environment variables are `DEVICE_DECK_BILLING_HOME`, `DEVICE_DECK_BILLING_CONFIG`, `DEVICE_DECK_LEMON_TOKEN`, `DEVICE_DECK_ISSUER_TOKEN` and `DEVICE_DECK_WEBHOOK_SECRET`. Optional `DEVICE_DECK_BILLING_PORT` defaults to 8080. The issuer token needs only the configured product's license/policy reads, expiry updates and license policy transfer permission. Neither token nor webhook secret belongs in the desktop package or npm installer.

`npm run billing:serve` binds loopback. A future deployment needs TLS ingress for `POST /webhooks/lemon-squeezy` and durable private storage. Subscribe to `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused` and `subscription_unpaused`. Return 200 only after storing the authenticated delivery. Do not enable this public endpoint until provisioning and sandbox tests are approved.

A PID/token lock prevents two workers. After a crash, `npm run billing:recover-lock -- /absolute/billing-home` removes only a verified dead owner's lock and refuses a live PID. If ownership cannot be parsed or a recovery was interrupted, inspect the private lock records before manual cleanup; the worker never kills a process to recover. Preserve `billing.sqlite` and its ledger across restarts.

## Private distribution

The release targets Node 24, minifies the four JavaScript entry points and emits no source maps. It retains compiled `deck-camera`, the required `apple-tv.py` runtime bridge and third-party notices. Swift source and its compiler plist are excluded. This is a bundled JavaScript application, not a proven source-free executable. The read-only Hosanna reference supplied packaging concepts; its archived pkg/Node 18 toolchain and validation shortcuts were not copied.

`packages/installer` scaffolds a private npm launcher with no source files in its npm payload. It authenticates protected Keygen artifact downloads, checks signed release identity, size and SHA-256, rejects unsafe extraction paths/links and installs into a version-specific app directory. The download authorization does not grant Pro. A separately pinned release signing key authenticates metadata; it is independent of Keygen's account signing key. Neither trust key can be replaced using runtime config or environment variables.

The installer is intentionally unconfigured and marked `private: true`. No publication occurred. New users need a Free/trial download-license issuance route before it can be advertised as anonymously installable. The local app continues to require no account/login screen. Installer metadata freshness gates new downloads; already-installed apps remain launchable after metadata expiry. The daemon controls paid feature expiry.

Minification and private artifact delivery deter casual inspection and make republishing less convenient. They do not prevent a determined user from inspecting or patching local code. Full Device Deck executable packaging, Developer ID signing and notarization remain unproven. A separate temporary Node 24 packager probe proved SQLite, Ed25519 and child processes only; it did not prove this application's ESM imports, helpers or daemon lifecycle.

## Real sandbox completion checklist

1. Confirm the Lemon Squeezy store and test subscription product/variant. Configure hosted checkout and lifecycle webhooks, leaving native Lemon Squeezy license-key generation disabled.
2. Provision a dedicated Keygen product, matching Pro/trial policies, features and finite licenses. Pin its public trust settings and mode in source, then rebuild the same protected app for all testers.
3. Run the bridge with real server credentials and persistent storage behind an approved test endpoint. Complete a genuine test checkout, issue/register/deliver its Keygen license, and activate it in an isolated profile.
4. Exercise renewal, failed payment, cancellation through paid-through date, expiry, trial conversion, deactivation and bounded offline use against real providers. Confirm signed checkout document shape and permissions.
5. Issue a genuine complimentary Pro license for the owner. Only then consider upgrading the existing review daemon, after checking its active work. Do not replace its data.
6. Complete automatic issuance/delivery, Free-download onboarding and refund/chargeback operations. Create signed release metadata and test an authenticated Keygen download before approving npm/Keygen publication.

No item above is represented as already passed. Local tests use injected providers and ephemeral signing keys only in test harnesses; customer bundles contain neither.
