# Device Deck

A local device workspace for humans and AI agents. This private monorepo contains a marketing website, an interactive product prototype, and the entry points for the future local app.

**Status: product preview, not a shipping hardware manager.** Browser interactions use sample data. No adapter controls a physical device, no real screen capture runs, and no installer or paid service exists.

## Run

Requires Node 24 or later and npm. No personal checkout paths or sourced shell configuration are required.

```sh
npm ci
npm run dev       # Website at http://127.0.0.1:5173
npm run dev:app   # Dashboard at http://127.0.0.1:5174
```

The website's `/demo/` link works in the combined production build. During development, open the dashboard at port 5174.

```sh
npm run check
npm test
npm run build
npm run preview   # Combined website and /demo/ at port 5173
```

Do not run `dev` and `preview` on the same port simultaneously.

## Local service scaffold

```sh
npm run service
npm run cli -- --help
npm run cli -- status
npm run cli -- devices --json
npm run mcp
```

The service exposes health and empty inventory on loopback port 47831. CLI and MCP call that same service. Set `DEVICE_DECK_PORT` consistently to change the port. Browser-origin requests and unexpected Host headers are rejected. This is a read-only scaffold; it must gain authenticated sessions before any mutation is implemented. The browser demo does not connect to this service.

## Workspace

| Location        | Purpose                                                       |
| --------------- | ------------------------------------------------------------- |
| `apps/web`      | Marketing website with actual rendered prototype screenshots  |
| `apps/app`      | Browser dashboard and isolated `src/demo` simulation          |
| `apps/service`  | Loopback background-service entry point, health and inventory |
| `packages/core` | Device/source/session contracts and local client              |
| `packages/cli`  | Human and JSON output for current service operations          |
| `packages/mcp`  | MCP stdio health/inventory tools using the same local client  |
| `packages/ui`   | Shared brand mark and theme tokens                            |

## Delivery scope

The preview now uses a light devices table with combined filters, saved views, validated add/edit and source bindings, and simulated bulk maintenance actions. Focused and multi-device viewers provide explicit single-device remote targeting, session ownership, capture controls, key overlays and recording-aligned input logs.

The capture library supports metadata editing, tags, filters, selection, removal and undo. Settings, device edits and sample history persist in browser localStorage. Reset demo restores the samples. Reloading interrupts simulated recordings. History and seeded reports complete the review workflow.

Captures remain metadata entries. Clipboard copying and download create an actual labelled sample PNG; recordings have no playable file. The configured Mac folder is a remembered preference, not a directory this website can write. See [revision coverage](docs/redesign.md) for functional and simulated boundaries.

Hardware discovery, durable transactional leases and credentials, real remote input, live preview, source sharing, background recording, config loading/editing, and installers remain future work. The present tests are not evidence of hardware reliability.

## Product and implementation docs

- [Build brief](docs/build-brief.md), with the original broader acceptance criteria.
- [Architecture and reuse map](docs/architecture.md).
- [Current API and client setup](docs/api.md).
- [Proposed JSON schema](docs/device-deck.schema.json) and [example](examples/device-deck.json).
- [Deployment and validation](docs/delivery.md).

The new project is independent of a Tawi job and the Hosanna framework. Tawi and Hosanna Tools are source material, not runtime dependencies. Their files have not been modified or copied.

## Hosting

Static Firebase Hosting only. The project is `tantawowa-device-deck`, inside the `tantawowa.com` Google Cloud organization. Do not enable paid services or attach billing merely to publish this preview.

```sh
npm run build
npx firebase-tools hosting:channel:deploy product-preview --project tantawowa-device-deck --expires 30d
```

Firebase preview links are accessible to anyone who has the URL. The source repository is private. Only `dist/` is published; private documentation and source checkouts are not uploaded.

Copyright 2026 TantaWowa. All rights reserved. Third-party libraries remain under their respective licenses.
