# Device Deck cloud registry

This Cloud Run API stores each signed-in user's machines in Firestore. Firebase Authentication provides Google and email/password identities. Every authenticated request verifies the Firebase ID token with revocation and disabled-user checks enabled. The API never contacts a saved endpoint: the user's browser connects directly to each machine for status, feeds and controls.

## Configuration and build

Use Node 24 or later. From the repository root:

```sh
npm install
node apps/cloud/build.mjs
node --import tsx --test apps/cloud/src/*.test.ts
docker build -f apps/cloud/Dockerfile -t device-deck-cloud .
```

Configure `FIREBASE_PROJECT_ID`, `PORTAL_ORIGIN`, and `PORTAL_SIGNING_KEY_JSON` using the example in this directory. `PORTAL_ORIGIN` is the exact HTTPS origin where the PWA is hosted. Keep it stable: existing machines pin the portal origin and signing public key when paired. Cloud Run's runtime service account needs Firestore read/write access and Firebase Authentication user-read permissions for revoked/disabled checks. Use application-default credentials; do not bake a service-account JSON key into the image.

Generate an Ed25519 private JWK once and save its output directly into a protected file for Secret Manager ingestion:

```sh
umask 077
node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto"; const {privateKey}=generateKeyPairSync("ed25519"); process.stdout.write(JSON.stringify(privateKey.export({format:"jwk"})));' > portal-signing-key.json
```

Mount that secret as `PORTAL_SIGNING_KEY_JSON` in Cloud Run. The API will not start without valid signing and project configuration. Rotating the key requires re-pairing existing machines. Do not place the private key in `VITE_*` variables or ship it to browsers. The `/api/v1/public-key` endpoint returns only the public JWK.

For explicit local development, use `NODE_ENV=development`, a loopback `PORTAL_ORIGIN`, and local ADC or Firebase emulators. Emulator environment variables are rejected outside explicit development mode. The test suite uses injected storage and authentication and requires no cloud credentials.

Deploy the container with public Cloud Run invocation so Firebase-authenticated browsers can call it. Firebase ID-token authorization is enforced inside the API. Configure Firebase Hosting to rewrite `/api/v1/**` to this Cloud Run service and serve the PWA for other paths. The HTTP server permits only the configured portal origin and never uses wildcard CORS. `GET /healthz` reports that the process started; API requests surface storage availability independently.

Client access to Firestore should be denied by security rules; all registry operations go through this API. Records are stored at `users/{uid}/machines/{machineId}` and pending pairings at `users/{uid}/pairings/{pairingId}`. Enable Firestore TTL for collection group `pairings`, field `deleteAfter`, to clean up abandoned pairing attempts. Expiration is enforced in application code even before TTL cleanup.

## API and pairing

The API prefix is `/api/v1`. Supply `Authorization: Bearer <Firebase ID token>` for every route except `GET /public-key`. JSON writes require `Content-Type: application/json` and are bounded to 16 KiB.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/public-key` | Portal issuer and Ed25519 public key |
| GET | `/machines` | The authenticated user's machine records |
| POST | `/pairings` | Five-minute, machine-specific pairing token |
| POST | `/machines` | Verify a signed receipt and consume its pending pairing |
| GET | `/machines/:id` | One owned machine |
| PATCH | `/machines/:id` | Change a friendly name or endpoint |
| DELETE | `/machines/:id` | Remove the record and stop issuing grants |
| POST | `/machines/:id/grant` | Machine-specific access token valid for at most 60 seconds |

The browser reads a machine's public identity directly, then sends `{machineId, publicKey}` to `/pairings`. The API persists a pending pairing and returns `{token, pairingId, expiresAt}`. The token has issuer `PORTAL_ORIGIN`, audience equal to the machine UUID, and `{uid, machineId, pairingId, purpose:"pair"}` claims. The user enters a one-time code generated locally on that machine; that local flow pins the portal signing key. The browser sends the code and pairing token directly to the machine, which validates both and returns an Ed25519 receipt with issuer equal to its UUID, audience equal to the portal origin, and `{uid, machineId, pairingId, purpose:"paired"}` claims.

To finish, the browser submits `{name, endpoint, receipt}` to `/machines`. The API verifies the receipt against the pending machine key and user, then atomically consumes the pending pairing and writes the machine record. Receipts expire after five minutes and cannot be reused, including by concurrent requests or different accounts. Machine IDs remain stable when endpoints change. Only HTTP(S) origins with optional ports are stored, with no URL credentials, path, query or fragment.

The browser obtains a 60-second access grant from `/machines/:id/grant` and sends that grant directly to the machine. Firebase ID tokens and the daemon's local master token are never shared between cloud and machine. Deleting a machine stops future grants immediately; an already-issued grant can remain valid for its remaining lifetime, at most 60 seconds. Remove the pairing locally when immediate machine-side revocation is needed.

HTTPS PWA clients need browser-trusted HTTPS machine endpoints on browsers that prohibit HTTP local-network connections. The cloud registry stores HTTP endpoints too, but does not tunnel traffic or bypass browser transport permissions. Reachability belongs to the browser's network, not Cloud Run's network.

Firebase references: [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [revoked and disabled user checks](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.baseauth), [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions).
