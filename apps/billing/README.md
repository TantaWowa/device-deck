# Device Deck billing service

This server connects Lemon Squeezy subscriptions to Device Deck's Keygen licenses. It runs separately from the Mac application. The application and installers contain no Lemon Squeezy token, issuer token, webhook secret, or delivery credentials.

The team beta can use the complimentary Keygen licenses issued by the release tooling immediately; it does not depend on this service. Public checkout needs the deployment and provider setup below.

## Customer purchase and activation

1. Link your Buy Pro button to `https://YOUR_BILLING_DOMAIN/buy`.
2. The service creates a checkout for the one configured Lemon Squeezy variant. Lemon Squeezy displays the price, taxes and renewal terms before payment. The variant is fixed server-side.
3. A signed `subscription_created` webhook is durably queued. The worker reads the current subscription from Lemon Squeezy, verifies store/product/variant/test mode, checks refunds, and creates or reuses the customer's Keygen user and license.
4. The buyer returns to `/activate` in the same browser. A private, HttpOnly cookie proves possession of that checkout; the page waits for confirmation and displays the key. The cookie expires after 24 hours. The receipt button also opens this page; in a different browser or after expiry, support must issue a new retrieval link.
5. The buyer pastes the key into Device Deck's License page, or saves it in a private file and runs `devdeck license activate /path/to/license-key.txt`.

No additional email service is required for this flow, and the bridge never sends email. A plain email address, order number or subscription ID is never sufficient to retrieve a key. Support can issue a 30-minute private link after verifying the purchaser. That link uses a URL fragment, so the secret is not sent in request URLs or access logs; the page immediately removes it from the address bar. Do not put analytics or third-party scripts on the activation origin.

The cookie belongs to the most recent checkout in that browser. Buying another license before collecting the first one, losing the cookie, or opening a receipt elsewhere uses the same support recovery process. Copy the key into your password manager when it appears.

## Provider configuration

The actual Keygen product and policy IDs are already in `deploy/billing.test.example.json` and `deploy/billing.live.example.json`. Their three Lemon Squeezy IDs are deliberately `0`, so unconfigured examples fail validation instead of addressing an accidental product.

Create the Device Deck subscription product/variant in Lemon Squeezy, choose the commercial price and terms, and disable Lemon's separate license generation for that variant: Keygen supplies the activation key. Use the approved Keygen product/policies for the matching mode. Policies must use an opaque key (`scheme: null`) and `transferStrategy: KEEP_EXPIRY`; the worker verifies these before starting. Product metadata must include `deviceDeckMode: "test"` or `"live"`.

The service uses five distinct server secrets:

| Setting                            | Purpose                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_DECK_LEMON_TOKEN`          | Read subscriptions/orders/invoices/products and create checkout sessions                                                                 |
| `DEVICE_DECK_ISSUER_TOKEN`         | Read the pinned product/policies/users/licenses; create users/licenses; update license expiry and perform trial-to-Pro policy conversion |
| `DEVICE_DECK_WEBHOOK_SECRET`       | Verify the raw Lemon Squeezy webhook body                                                                                                |
| `DEVICE_DECK_ISSUANCE_SECRET`      | Stable random secret for unique, retry-safe license creation                                                                             |
| `DEVICE_DECK_BILLING_ADMIN_SECRET` | Authenticate operator status, recovery links and holds                                                                                   |

Use a dedicated issuer token with the needed permissions. Do not put the account-wide administrator credential on the public server. Keygen users are created passwordless with no user permissions; existing customer accounts are reused without altering their passwords, permissions or other licenses. License-authenticated machine activation is controlled by the application's licensing policy.

Keep test and live in separate containers, homes, `.env` files, tokens, webhook secrets and volumes. The SQLite database pins the entire billing identity and refuses to start if repointed at a different mode/product/policy. A future pricing variant migration needs an explicit migration, not a config edit against an existing database.

## Prepare a deployment

Requirements: Node 24, Docker with Compose, a Linux host with a persistent local disk, and a DNS hostname pointing at it. The Compose recipe uses Caddy for HTTPS. Provider credentials and a Lemon Squeezy product are required before the worker will start. No public endpoint or paid hosting is created by these commands until you run Compose on your host.

From the repository root, using your real Lemon Squeezy IDs:

```sh
npm ci
node apps/billing/build.mjs
node apps/billing/deploy/init.mjs --mode test --domain billing-test.example.com --store 123 --product 456 --variant 789
```

The initializer writes private, ignored `deploy/.env` and `deploy/billing.json`, generates independent webhook/issuance/admin secrets, and refuses to overwrite existing files. Set the two provider tokens in `.env` with your private editor. Back up that file in your secrets manager, especially the stable issuance secret. Never commit or print it into CI output.

Copy the billing directory and bundled `dist/` onto your server securely, then:

```sh
cd apps/billing/deploy
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/readyz
```

`GET /healthz` checks the HTTP process. `GET /readyz` checks that its work loop has run recently; external failures appear in the authenticated retry queue, not public health responses. Startup preflight verifies provider credentials, product identity and pinned policies before opening the listener. Caddy opens ports 80/443; billing itself is bound to loopback on the host. Public `/admin/*` requests return 404. Do not expose port 8080 publicly.

The image runs as the unprivileged `node` user, has a read-only root filesystem, and stores SQLite state in the named `/data` volume. Keep one worker replica per billing home. SQLite's separate exclusive worker transaction is released by the OS after a crash, including across container PID namespaces; restart can safely recover the informational owner file. The volume must be a local Docker volume or filesystem with working SQLite locks, not shared NFS storage.

The official Node 24.17.0 and Caddy images are pinned by multi-architecture digest. Refresh those pins deliberately and repeat container/provider acceptance before market release. Test/live deployments need distinct Compose projects and hostnames; use separate hosts or adjust the loopback port mapping if colocating them. The initializer sets `COMPOSE_PROJECT_NAME` by mode to separate volumes.

Without Docker, export the same settings, plus an absolute `DEVICE_DECK_BILLING_HOME` and `DEVICE_DECK_BILLING_CONFIG`, and run `node apps/billing/dist/server.mjs` under your host's process supervisor. The default listener is `127.0.0.1:8080`; terminate HTTPS at a trusted reverse proxy.

## Webhook setup and payment rules

Configure `https://YOUR_BILLING_DOMAIN/webhooks/lemon-squeezy` in the matching Lemon Squeezy mode. Set its signing secret to `DEVICE_DECK_WEBHOOK_SECRET`. Subscribe to:

```text
subscription_created
subscription_updated
subscription_cancelled
subscription_resumed
subscription_expired
subscription_paused
subscription_unpaused
subscription_payment_success
subscription_payment_failed
subscription_payment_recovered
subscription_payment_refunded
order_refunded
```

The service acknowledges after persisting the verified event, then retries failures with bounded backoff. Duplicate bodies are deduplicated, remote state is re-fetched, and subscription-license bindings survive restart. Initial license creation derives a unique opaque key from the stable issuance secret plus account/product/mode/subscription. Keygen's unique key and retrieval-by-key recover a creation whose response was lost. A metadata lookup also reuses an existing matching license; ambiguous or mismatched matches fail closed.

| Billing state                | Access                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Active                       | Paid access through the authoritative renewal date                                  |
| Cancelled                    | Keeps paid access through `ends_at`                                                 |
| Expired                      | Expiry is capped at the recorded end date/current time                              |
| Past due / unpaid            | Keeps previously recorded paid time; never grants the retry date as a new term      |
| Trial                        | Uses the pinned trial policy through `trial_ends_at`; upgrades to Pro after payment |
| Paused, free                 | Complimentary time is bounded to one day and reconciled hourly                      |
| Paused, void                 | No new time beyond previously paid access                                           |
| Full order or invoice refund | Holds access pending support review, including if lifecycle webhooks arrive later   |
| Partial refund               | Keeps access and creates an operator review item                                    |
| Reported chargeback          | Operator adds a durable case hold; ordinary renewals cannot clear it                |

This deliberately treats any full refund as a support hold, including refunds for historical terms. If retaining service is appropriate, release the hold with a reason. A released refund remains acknowledged and will not reappear just because the provider still reports the same refund. A partial refund that subsequently becomes a full refund does create a hold.

Lemon Squeezy's published webhook list has no chargeback event. This service does not invent one or claim automatic dispute detection. Use the merchant's dispute notification/support process to add a hold. If both the order and its invoice are refunded, both review records must be resolved. The worker only changes expiry; it never clears a Keygen operator suspension. Already issued offline license certificates remain subject to the application's normal offline window until the next online check.

Hourly reconciliation revisits known subscriptions and checks the initial order plus every page of subscription invoices to catch missed refund events. First purchases whose creation webhook never arrives require webhook replay or an operator `reconcile` command; the worker does not scan the whole store for unobserved purchases.

## Operator recovery, reviews and monitoring

Connect through SSH to the host's loopback billing listener:

```sh
ssh -L 18080:127.0.0.1:8080 YOUR_SERVER
```

In another terminal, set `DEVICE_DECK_BILLING_ADMIN_SECRET` from the secrets manager and `DEVICE_DECK_BILLING_OPERATOR_URL=http://127.0.0.1:18080`. Run from the repository root:

```sh
node apps/billing/dist/operator.mjs status
node apps/billing/dist/operator.mjs reconcile SUBSCRIPTION_ID
node apps/billing/dist/operator.mjs retrieval-grant SUBSCRIPTION_ID
node apps/billing/dist/operator.mjs hold SUBSCRIPTION_ID CASE_ID "Chargeback reported by merchant"
node apps/billing/dist/operator.mjs release-hold operator:CASE_ID "Dispute resolved; restore subscription term"
node apps/billing/dist/operator.mjs release-hold subscription-invoices:INVOICE_ID "Refund reviewed; retain service"
```

`status` returns identifiers, queued retries and outstanding holds, without license keys or provider secrets. Alert on repeated retries and unresolved review items through your normal private monitoring. A retrieval grant is only available after a license exists. The operator command prints the private expiring URL for you to deliver after verifying the buyer; it does not message anyone. A successful reconcile request means queued, so check status before issuing the retrieval grant.

Provider or policy failures stay durable for retry. Correct the server config/credential, then restart or enqueue reconciliation. Legacy PID-only owner files require stopping the old worker and running `node apps/billing/dist/recover.mjs /path/to/billing-home`; it refuses a live legacy PID. Current transaction locks recover automatically after a crash.

Back up the entire persistent volume while the billing container is stopped, alongside the separately encrypted environment secrets. Preserve `billing.sqlite` and its WAL together; copying just the main SQLite file while running can lose acknowledged events. Test restoration in an isolated environment with the same pinned identity. Keep Caddy's certificate volume backed up independently. Do not use `docker compose down --volumes` for an upgrade.

## Release verification

```sh
npm run check
node --import tsx --test apps/billing/src/*.test.ts
node apps/billing/build.mjs
```

Then complete one actual Lemon Squeezy test-mode checkout: collect the key in the same browser, activate a test build, replay the webhook, simulate renewal and cancellation, refund the test payment, verify a hold, and release it using the operator tool. Repeat after a container restart and backup restore. Only after this succeeds should you create the live deployment and switch the Buy Pro link. The automated suite uses fake provider transports and a real loopback HTTP server; it does not substitute for this provider sandbox acceptance test.

## Primary API references

- [Lemon Squeezy checkout creation](https://docs.lemonsqueezy.com/api/checkouts/create-checkout): custom checkout data, redirects, receipt links, fixed variants and test mode.
- [Lemon Squeezy webhook event types](https://docs.lemonsqueezy.com/help/webhooks/event-types): subscription lifecycle, payment and refund payload types; no chargeback event is documented.
- [Lemon Squeezy subscription states](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object): paid-through cancellation and dunning semantics.
- [Lemon Squeezy invoice objects](https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object) and [invoice listing](https://docs.lemonsqueezy.com/api/subscription-invoices/list-all-subscription-invoices): full/partial refunds and pagination.
- [Lemon Squeezy orders](https://docs.lemonsqueezy.com/api/orders/the-order-object) and [subscription filters](https://docs.lemonsqueezy.com/api/subscriptions/list-all-subscriptions): authoritative order checks and order-linked subscriptions.
- [Keygen licenses](https://keygen.sh/docs/api/licenses/) and [users](https://keygen.sh/docs/api/users/): custom unique keys, metadata lookup, email uniqueness and passwordless users.
