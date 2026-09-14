# Website and interactive preview delivery

This records the earlier public demo milestone. See [local application delivery](local-delivery.md) for the subsequent real daemon, clients and capture implementation.

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
- Preview expiry: 14 October 2026 at 09:17 UTC, as returned by Firebase
- Billing: `billingEnabled: false`, no billing account attached

The source repository is private. Firebase Hosting previews are accessible to anyone holding the URL. No live-channel release was made. No analytics, functions, database, storage bucket, payment system, or user account backend was added.

## What works

The responsive website links to a light React workspace with eight sample devices. The primary devices table includes combined filtering, saved views, multi-row selection, validated add/edit forms, source binding conflicts, and simulated bulk lock/unlock/restart results. Focused and multi-device viewers keep remote control scoped to one selected device.

Capture metadata, tags, editing, removal/undo, input timelines, session history, seeded reports and local settings are interactive. Browser clipboard and download actions create a labelled sample PNG. No login is required. See [the readable workspace revision](redesign.md) for complete behavior and validation scope.

The local service has health and inventory endpoints. The CLI supports help, human output, JSON and exit codes. MCP has two working tools. All three read the same empty inventory from the service. No sample data is injected into the service.

## What remains simulated or unimplemented

The dashboard persists demo configuration and metadata in browser localStorage. This does not write to the configured Mac folder or synchronize tabs and hosts. All devices, owners and USB discovery entries are samples. Captures are metadata; there are no actual device frames or playable recordings. Reloading records a simulated recording interruption. Report metrics are explicitly seeded.

Hardware discovery, actual remote input, live preview, screenshots, video capture, durable credentials and leases, config loading/writes, shared-source arbitration, background capture persistence, service installation, and packaging remain unimplemented. These are described in the build brief and architecture docs. No physical hardware was touched or validated in this milestone.

## Validation

The readable workspace revision passes 13 model/service tests and 16 browser acceptance checks locally. The revision's commands and coverage are documented in [redesign.md](redesign.md). Evidence includes actual rendered table, focused viewer, multi-device, mobile and marketing screenshots. Browser QA runs against both a combined local production build and the existing Firebase preview. The local service tests continue to prove that no seeded hardware leaks into the real service.

`scripts/qa.mjs` repeats browser checks against `QA_URL`, defaulting to port 5175. Set `PLAYWRIGHT_CHANNEL=chrome` for installed Google Chrome, or install Playwright Chromium. `QA_OUTPUT` chooses the ignored evidence output directory.

## Images

The marketing images now come from the current Mac app's web UI: `devices-current.png`, `remote-current.png` and `feeds-current.png`. They show the platform and Sim/Real filter buttons, compact floating remote and three-input split screen. The screenshot script supplies fictional devices and labelled sample feeds; it does not connect to the local daemon or capture hardware. The sample landscape is original generated artwork.

Run `PLAYWRIGHT_CHANNEL=chrome npm run screenshots:website` after changing the local Devices, Feeds or remote components. It builds the current local UI separately from the older public `/demo/` prototype, captures the three assets, and checks the relevant controls and images. Review the output visually before deploying. The website identifies these as current app screenshots with sample data and labels the separate interactive prototype accordingly.

The 14 September 2026 refresh passed the screenshot generator's image, layout and fixture-isolation checks, TypeScript checking, the production website/demo build and all 16 existing browser acceptance checks. The generator writes its browser version, source commit and screenshot details to ignored `work/marketing-screenshots/report.json`; browser evidence for this refresh is in ignored `outputs/website-refresh/`.

## Refresh the preview

```sh
npm ci
npm run check
npm test
PLAYWRIGHT_CHANNEL=chrome npm run screenshots:website
npm run build
npx firebase-tools hosting:channel:deploy product-preview --project tantawowa-device-deck --expires 30d
```

Deployment uses only `dist/`, as specified in `firebase.json`. Keep the project on the no-billing setup for this static preview. The generated Firebase web app registration is retained; the static site does not need the Firebase client SDK or its API configuration.
