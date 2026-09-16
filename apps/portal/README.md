# Device Deck portal

The React/Vite portal lives at `/app/`. It signs users in through Firebase Authentication and stores machine metadata through the same-origin `/api/v1` cloud registry. The browser connects directly to paired machines for health, feeds, controls and captures. Firebase ID tokens go only to the account API; short-lived machine grants and session leases remain in memory.

## Local development

Use Node 24 or later. From the repository root:

```sh
npm install
DEVICE_DECK_CLOUD_URL=http://127.0.0.1:8080 npm run dev:portal
```

Open `http://127.0.0.1:5175/app/`. Vite proxies `/api` to `DEVICE_DECK_CLOUD_URL`, defaulting to `http://127.0.0.1:8080`. Configure the [cloud service](../cloud/README.md) with the matching portal origin.

Create the ignored `apps/portal/public/firebase-config.json` with the Firebase project's public web configuration:

```json
{
  "apiKey": "your-public-web-api-key",
  "appId": "your-firebase-web-app-id",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project"
}
```

Enable Google and email/password sign-in in Firebase Authentication, and allow the portal's domain. Production configuration also supplies `portalOrigin`; the browser moves to that canonical HTTPS origin before signing in. This origin must be the configured project's `firebaseapp.com` or `web.app` address. Use the same canonical origin for the cloud service and machine pairing.

For the Firebase Auth emulator, add `"authEmulatorUrl": "http://127.0.0.1:9099"` to a local configuration. Emulator support requires both a Vite development build and a loopback page and emulator address. Production builds reject this field. The deployment script generates production configuration in `dist/app/firebase-config.json`; it must not contain an emulator URL.

## Validation and build

```sh
npm run test:portal
npm run check
npm run build:portal
```

`build:portal` writes `dist/app/`, with `/app/` as the asset base. The root website build preserves the marketing page and `/demo/` and includes this portal. Deployment is managed by the repository's `deploy:portal` script.

The browser QA uses the real Firebase browser SDK, an Auth emulator and isolated cloud/machine fixtures. It needs the Firebase CLI, a locally installed Google Chrome, and free ports `9099`, `5185`, `8085`, `47839` and `47840`:

```sh
npx firebase-tools emulators:start --only auth --project demo-device-deck-portal --config apps/portal/firebase-emulators.json
```

In another terminal:

```sh
npm run qa:portal
npm run build:portal
npm run qa:portal-pwa
```

PWA QA also uses the local `openssl` executable to create a temporary HTTPS fixture. Screenshots are written under `outputs/portal-qa/`. The tests cover account creation, pairing, machine switching with duplicate device IDs, mobile controls, editing/removal, logout, manifest/icons and offline shell loading.

## Browser and offline behavior

Trusted HTTPS machine endpoints work across phone browsers. HTTP endpoints can be opened as standalone pages; secure portal pages do not try to bypass mixed-content or local-network permissions. Network status is observed by the browser and includes a check timestamp.

The service worker caches only public `/app/` shell files and assets. It excludes account APIs, machine requests, Firebase requests and URL query strings. Public Firebase web configuration has a separate offline fallback. Saved machine metadata is scoped to the signed-in account, marked stale and cleared on logout. Neither frames nor tokens are stored in that metadata cache.

Controls are never queued for replay. Machine/device switches, logout, hidden pages, browser disconnection and failed inventory checks cancel pending controls. Remote appearances are scoped by both machine and device. Firebase manages session-only authentication persistence; the application does not copy those credentials into its caches.
