# Website-first delivery

Delivered 11 September 2026. The product name and repository name were available as requested.

## Resources

- Private GitHub repository: https://github.com/TantaWowa/device-deck
- Google account: `george@tantawowa.com`
- Organization: `tantawowa.com`, ID `375503269979`
- Google Cloud / Firebase project: `tantawowa-device-deck`
- Project number: `723600237548`
- Project state: `ACTIVE`
- Firebase web app: `Device Deck website`
- Web app ID: `1:723600237548:web:0bb1c0bc1603916861d6c9`
- Hosting site: `tantawowa-device-deck`
- Preview channel: `product-preview`
- Preview URL: https://tantawowa-device-deck--product-preview-83xolv2t.web.app
- Interactive app: https://tantawowa-device-deck--product-preview-83xolv2t.web.app/demo/
- Preview expiry: 11 October 2026, as returned by Firebase
- Billing: `billingEnabled: false`, no billing account attached

The source repository is private. Firebase Hosting previews are accessible to anyone holding the URL. No live-channel release was made. No analytics, functions, database, storage bucket, payment system, or user account backend was added.

## What works

The responsive website links to a rendered React dashboard. The browser prototype has four sample devices, platform/type/search filtering, a device session, remote input that changes the fictional screen, simulated capture entries, renew/release/reserve, ownership blocking, expiry, source pairing and agent examples. Navigation works on desktop and mobile.

The local service has health and inventory endpoints. The CLI supports help, human output, JSON and exit codes. MCP has two working tools. All three read the same empty inventory from the service. No sample data is injected into the service.

## What remains simulated or unimplemented

The dashboard keeps demo state in memory. Closing or reloading it loses that state. All sample devices and owners are fictional. Its screenshots and recordings are metadata entries; there are no real captured files or playable clips. The optional sample-artwork download is labelled as artwork.

Hardware discovery, actual remote input, live preview, screenshots, video capture, durable credentials and leases, config loading/writes, shared-source arbitration, background capture persistence, service installation, and packaging remain unimplemented. These are described in the build brief and architecture docs. No physical hardware was touched or validated in this milestone.

## Validation

- `npm run check`: passed.
- `npm test`: three focused tests passed, covering occupied-device control, demo expiry/cleanup, and the service's read-only/origin/Host restrictions.
- `npm run build`: both static apps passed. Combined static output is approximately 976 KiB.
- Browser QA: fourteen checks passed both locally and against the deployed Firebase preview, including assets, internal links, example tabs, filtering/search, input, captures, another owner's restrictions, release/reserve/renew, recording state across views, source-pairing rules, simulated file labels, mobile menu and width checks at 390, 768 and 1440 pixels. No browser runtime errors or horizontal overflow.
- MCP: a real client completed initialize/list-tools and called both tools. CLI JSON matched the same service inventory.
- Public asset scan: no personal filesystem paths, account email, private network addresses, common API-token prefixes or private-key markers found in the static build.
- GitHub visibility, Firebase app existence, active project organization and disabled billing verified from CLI output.

`scripts/qa.mjs` repeats browser checks against `QA_URL`, defaulting to port 5175. Use `PLAYWRIGHT_CHANNEL=chrome` to use an installed Google Chrome, or install Playwright's Chromium. The script saves screenshots to the ignored `outputs/` directory.

## Images

The website's `dashboard-preview.webp` and `session-preview.webp` were captured from the actual prototype. The sample landscape is original generated artwork. The site explicitly labels these images as product previews and the embedded TV app as fictional. There are no customer logos, testimonials, private device locators, or copied app screens.

## Refresh the preview

```sh
npm ci
npm run check
npm test
npm run build
npx firebase-tools hosting:channel:deploy product-preview --project tantawowa-device-deck --expires 30d
```

Deployment uses only `dist/`, as specified in `firebase.json`. Keep the project on the no-billing setup for this static preview. The generated Firebase web app registration is retained; the static site does not need the Firebase client SDK or its API configuration.
