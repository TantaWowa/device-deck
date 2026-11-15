# Contributing to Device Deck

Bug reports, tested-device reports, documentation fixes and code contributions are welcome. Device Deck is free and open source under the [MIT license](LICENSE).

Start with the [README](README.md) for the product and installation, the [documentation index](docs/README.md) for task guides, and the [architecture](docs/architecture.md) for how the daemon, clients and adapters fit together.

## Report a bug or a working device

Search [existing issues](https://github.com/TantaWowa/device-deck/issues) first. Use the [issue forms](https://github.com/TantaWowa/device-deck/issues/new/choose) to report a bug, suggest a feature or share a device you tested.

For a bug, include your Device Deck version and installation method, macOS version and Mac architecture, device model and OS, connection method, and steps that reproduce it. Describe what you expected and what happened. A short screenshot or recording can help explain a UI or capture problem.

`devdeck version` and `devdeck doctor` can help identify your setup. Share only the relevant output. Remove access tokens, lease tokens, pairing credentials, private addresses, account names and sensitive app content before posting diagnostics or captures. Full logs and configuration files are not required.

For a tested-device report, name the operations you actually tried and their results. For example, a successful screenshot does not establish recording, touch or reconnect support. Include the version or commit and date of the check. See [validation and coverage](docs/validation.md) for the distinction between automated fixtures and real device checks.

## Run a development checkout

Local app builds require macOS 14 or later, Node 24 or later and Xcode command-line tools. Install the platform tools for the devices you intend to use; see the [install guide](docs/install.md).

```sh
npm ci
npm run build:local
./devdeck init
./devdeck start
./devdeck ui
```

The repository's `./devdeck` wrapper uses the ignored `work/local-deck/` development profile. It uses real device adapters. Choose devices you can use without interrupting someone else's work. A development profile has separate configuration, but it can still discover the same physical hardware as an installed copy.

Run `./devdeck stop` when finished. Rebuild with `npm run build:local` after changing bundled CLI or dashboard code. `npm run service:local` runs the development daemon in the foreground.

For website and documentation work, `npm run dev` serves the marketing site and `/docs/`. Edit Markdown in `docs/` to update the documentation on both GitHub and the website. `npm run dev:app` starts the isolated browser demo, which uses simulated devices. These commands do not run the local device dashboard.

## Make and check a change

Keep each pull request focused on one problem. For a substantial new feature or adapter, an issue describing the intended workflow helps establish the scope before implementation. Small fixes can go straight to a pull request.

Use the existing daemon operations and shared contracts when adding client behavior. Keep reservation ownership and cleanup in the daemon. Read the [architecture](docs/architecture.md) before changing device lifecycle, capture or authentication behavior.

Choose checks that exercise the change:

| Change | Useful checks |
| --- | --- |
| Documentation | Run `npm run check:docs` to validate local links and heading targets. Check commands against the source and preview the affected page at `/docs/`. |
| TypeScript or service behavior | Run `npm run check` and relevant tests. Add a regression test when it demonstrates the bug or changed behavior. |
| Local dashboard or bundled CLI | Run `npm run build:local` and exercise the affected flow. |
| Website, public demo or portal UI | Run `npm run build` and inspect the affected page. |
| Documentation renderer or routing | Run `npm run test:docs` and `npm run build`; check a direct `/docs/` page URL in the browser. |
| Installer or distribution code | Run `npm run test:distribution` and the relevant package checks described in [Mac distribution](docs/macos-distribution.md). |
| Configuration or operation schemas | Run `npm run schema` and review the generated changes. |

Run one test file with Node's test runner, for example:

```sh
node --import tsx --test packages/config/src/config.test.ts
```

`npm test` runs the repository test suite. A passing fixture test does not establish hardware compatibility. If a change affects a device transport, describe any real device checks separately. Inspect a hardware proof script before running it and use a device available for that work.

## Open a pull request

Explain the problem, the resulting behavior and how you checked it. Include a screenshot for a visible change when it helps the reviewer. Name the hardware and operations exercised, and state any checks you could not run.

Update the relevant guide or reference when behavior changes. Keep generated files with the source changes that produced them. Leave local profiles, captures, credentials and unrelated edits out of the pull request.
