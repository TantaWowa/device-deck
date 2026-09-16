# Remote machines and the Device Deck portal

Device Deck can listen on an ordinary IP address and port. Your network supplies
the route: a LAN, Tailscale, WireGuard, a VPN, or a public address all work. Device
Deck does not create tunnels, relay feeds, or connect your networks together.

## Open a machine by IP and port

On the machine running Device Deck:

If upgrading an already-running daemon from a version without `network` commands,
finish its active sessions and restart it once to load the new server first.

```sh
devdeck network enable --host 0.0.0.0 --port 47831
devdeck stop
devdeck start
devdeck ui --address http://100.94.9.50:47831 --json
```

Use that machine's actual reachable IP in the last command. Open the returned
one-use launch link on the other computer within a minute. It establishes a
24-hour browser session. A bare address serves the dashboard but does not grant
access to devices or feeds; opening the authenticated launch link supplies that
access. `devdeck ui` continues to work locally.

`0.0.0.0` listens on all IPv4 interfaces. Use a specific interface IP to restrict
the listener. `DEVICE_DECK_HOST` and `DEVICE_DECK_PORT` override the saved values.
Binding changes require a restart. `devdeck network status` shows saved settings;
`devdeck network disable` restores the default loopback configuration after a
restart, unless an environment override is still present.

Interface IPs and the machine hostname are accepted automatically. Register any
additional DNS name or reverse-proxy host explicitly:

```sh
devdeck network enable --allow-host studio.example.com
```

Network reachability still follows your firewall and network policy. A Tailscale
IP is reached through your tailnet; binding all interfaces also makes the service
available on its LAN interfaces. Device Deck requires authentication on either.
Optional `devdeck tailscale` commands remain available for people using Serve.

## One signed-in web app

`apps/portal` is a responsive, installable PWA served at `/app/`. Firebase Auth
provides Google and email/password sign-in. The Cloud Run API in `apps/cloud`
stores each account's named machine addresses in Firestore. It never contacts
those addresses; the signed-in browser connects directly to each machine.

The machines page supports adding, renaming, changing an address and removing a
machine. Its connection status describes reachability **from this browser**.
Opening a machine shows feeds, devices and captures. The remote reserves devices
through the same lease system as the local dashboard. Phone controls use large
touch targets and a bottom sheet. Pending input is cancelled when the selected
remote changes, and credentials are never replayed as queued offline actions.

### Pair a machine

After deploying the portal, configure its origin on the machine. The default
deployment origin is `https://tantawowa-device-deck.firebaseapp.com`:

```sh
devdeck network enable --host 0.0.0.0 --port 47831 \
  --portal https://tantawowa-device-deck.firebaseapp.com \
  --allow-host studio.example.com \
  --cert /absolute/path/fullchain.pem --key /absolute/path/private-key.pem
devdeck stop
devdeck start
devdeck pair
```

Supply a certificate trusted by the browsers you use, covering the machine's
hostname or IP. TLS is optional for standalone access; it is the reliable choice
for feeds and controls inside an HTTPS PWA across phone browsers. A VPN provides
network reachability but does not automatically make an HTTP endpoint compatible
with an HTTPS page. Browser local-network permission prompts may also apply.

Your own HTTPS reverse proxy is another option. Configure its public Host through
`--allow-host`; it forwards to the ordinary machine listener. Device Deck does not
manage the proxy or tunnel. The native CLI retains a private loopback HTTP control
listener when the public listener uses TLS or a specific interface.

In the portal, choose **Add machine**, enter a name, its reachable address and the
pairing code. The code expires in five minutes, permits a bounded number of
attempts and is single-use. Run `devdeck pair` again for a new code. After pairing
through a secure address, an HTTP address can be saved as a standalone destination.
New pairing from the hosted portal requires trusted HTTPS to the machine. Local
HTTP development can pair directly with HTTP machines.

The host pins the configured portal's public signing key. A pairing receipt
signed by the machine proves possession of its private key before the cloud
saves the record. Machine identity persists in owner-only `machine.json`;
`hub-binding.json` records the paired account and pinned portal key.

Firebase login tokens go only to the account API. The cloud issues separate
machine-specific grants lasting at most 60 seconds. The machine checks the
signature, issuer, account, machine ID, pairing ID, purpose and expiry on every
authorized request. Removing a machine prevents new grants; existing grants
expire within 60 seconds. `devdeck pair --revoke` revokes the local binding
immediately. Re-pairing invalidates the previous binding too.

One machine is paired with one account at a time in this release. Pairing gives
that account device, capture and configuration access; network trust and pairing
changes require the native client on the host. Team membership, roles and sharing are future
work. Captures and device credentials remain on the machine. The portal caches
its public shell and account-scoped machine metadata for offline display; cached
metadata is marked stale and removed on logout. It does not cache feeds, capture
files or access grants. Firebase manages the browser's sign-in session.

## Build and deploy

```sh
npm ci
npm run check
npm test
npm run build:local
npm run build
npm run build:cloud
```

The existing marketing website remains at `/` and the isolated demo at `/demo/`.
Only `dist/` goes to Firebase Hosting. `/api/**` rewrites to the cloud registry;
`/app/` serves the PWA. The daemon and its runtime files are never hosted there.

For the existing `.firebaserc` project, enable billing and configure Firebase
Authentication with Google sign-in once, then run:

```sh
gcloud auth login
npm run deploy:portal
```

The deploy script verifies the application, enables the required APIs, reuses or
creates Firestore and the cloud service account, stores an Ed25519 signing key in
Secret Manager, builds Cloud Run, writes the public Firebase browser config into
`dist/app/firebase-config.json`, and deploys Hosting plus Firestore rules. Google
sign-in must already have its OAuth client enabled in the Firebase console; the
script checks this before publishing. It enables email/password sign-in and adds
the canonical portal domain without replacing other authorized domains. Cloud
Run scales from zero to at most two instances. The API is publicly reachable but
all account routes require a verified Firebase token, including revocation and
disabled-user checks. Direct Firestore access is denied by its rules.

Keep the signing secret stable across deployments. Replacing it requires pairing
the machines again because each host pins that key. Deployments reuse it and
never print or upload machine credentials. See [the cloud service README](../apps/cloud/README.md)
for API and runtime configuration details. For local portal work, run
`npm run dev:portal`; supply the public Firebase config and a development API
proxy as described in the portal README. Production does not accept emulator
credentials.
