# Develop Device Deck

The local service, browser dashboard, CLI, terminal UI, MCP server and public website live in this repository. Start with the [contribution guide](../CONTRIBUTING.md) for a change, or the [Mac install guide](install.md) to use a packaged release.

## Build from source

Requires macOS 14 or later, Node 24 or later, and Xcode command-line tools to build the capture helper. The downloadable package already contains that helper for its named architecture. Use a separate development profile when a shared installation already exists:

```sh
npm ci
npm run build:local
export DEVICE_DECK_HOME="$HOME/Library/Application Support/Device Deck Development"
export DEVICE_DECK_PORT=0
node build/devdeck.mjs init
node build/devdeck.mjs start
node build/devdeck.mjs ui
```

From an unpacked source-build release, use `./devdeck` instead of `node build/devdeck.mjs`. Keep that folder at a stable location before installing its per-user development login service. These commands do not configure or remove the installed shared boot service:

```sh
./devdeck install      # Start at login
./devdeck status
./devdeck logs
./devdeck stop
./devdeck uninstall    # Remove the login service, retain config and captures
```

`start` runs the development daemon in the background. `npm run service` runs it in the foreground. Closing a browser, CLI or MCP connection leaves recordings running. Release, takeover, expiry, the recording duration limit or service shutdown finalize them. To build the full app with its encoder, use the [Mac package instructions](macos-distribution.md#build-an-unsigned-test-package).

## Dependencies

New Mac packages bundle FFmpeg and ffprobe for live encoding, recording validation, screenshots and annotations. Source runs and older unsigned public betas need a separate encoder or the [source-built media bundle](macos-distribution.md#bundled-recording-tools). Source builds fetch and verify the pinned scrcpy 4.1 server; packages include it with its Apache-2.0 license. The native USB and clipboard helper is included too.

Install only the device-specific tools you use, under the host account. Android needs ADB. Apple simulators need Xcode and runtimes; input uses the separately installed [official idb client and companion](https://github.com/facebook/idb). Physical Apple TV uses [pyatv](https://pyatv.dev/). For a developer-managed host:

```sh
brew install --cask android-platform-tools
brew install facebook/fb/idb-companion
python3 -m venv ~/.local/share/device-deck-tools
~/.local/share/device-deck-tools/bin/pip install fb-idb pyatv
```

For an unbundled source run, `brew install ffmpeg-full` provides the required ASS annotation filter. Configure its FFmpeg and ffprobe paths below `brew --prefix ffmpeg-full` if needed. Packaged users do not need that step.

Set absolute `tools.adb`, `tools.idb` and `tools.python` paths in the host's Settings when those executables are outside the service's PATH. `devdeck apple-pair --device 'Desk Apple TV'` starts a credential-owned session and asks for the displayed PIN. Pairing is also available through `pairing.start` and `pairing.finish` in API and MCP.

## Workspace

| Location            | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `apps/website`      | Public marketing website                             |
| `docs`              | Markdown guides rendered into the website's `/docs/` section |
| `apps/web`          | Isolated public demo and real local web entry        |
| `apps/portal`       | Signed-in machine registry PWA and mobile remotes     |
| `apps/cloud`        | Firebase-authenticated Cloud Run registry API         |
| `packages/machine-client` | Direct browser-to-machine transport and grants |
| `apps/daemon`       | HTTP server and application service                  |
| `apps/cli`          | Scriptable commands and interactive picker           |
| `apps/tui`          | Separate terminal UI                                 |
| `packages/core`     | Shared contracts, selectors and clients              |
| `packages/config`   | JSON validation and atomic editing                   |
| `packages/adapters` | Discovery, identity checks and input                 |
| `packages/capture`  | Preview streams, screenshots and recorder lifecycle  |
| `packages/mcp`      | MCP tools over daemon operations                     |
| `packages/ui`       | Shared branding and visual tokens                    |
| `native`            | Mac capture/clipboard and Apple TV Companion helpers |

The source adaptation map is in [source provenance](source-provenance.md). Tawi and Hosanna Tools are source material, not runtime dependencies. Their checkouts were not modified.

## Develop and validate

For local hardware development:

```sh
npm ci
npm run build:local
npm run install:dev-cli   # Install devdeck in ~/.local/bin
./devdeck start
./devdeck status --json
./devdeck view --mux
./devdeck stop
```

The repository-root `./devdeck` wrapper uses the ignored `work/local-deck/` profile and starts `scripts/service-local.ts` with real adapters and all features enabled. `npm run service:local` runs that same daemon in the foreground. No license or payment account is required. After `npm run install:dev-cli`, use `devdeck` from any directory with `~/.local/bin` on your PATH. `./devdeck` also works from the checkout. `DEVICE_DECK_HOME` can select another development profile.

Without an explicit development profile, the normal `node build/devdeck.mjs` launcher discovers an installed shared service; otherwise it uses the standard user profile with the same unrestricted features. The repository wrapper is for local development start/stop, not shared-service installation. macOS Camera permission belongs to the application that launches the capture helper; development launches from Codex may appear as "ChatGPT." Installed shared-service capture uses the host's Device Deck camera bridge. Hardware IDs for cards without serial numbers can change when moved to another USB port; rediscover and confirm the picture before rebinding.

```sh
npm run check
npm run check:docs     # Markdown links and heading targets
npm test
npm run schema
npm run build:local
npm run package:local
npm run build           # Website, /docs/, isolated /demo/, and /app/ PWA
npm run build:cloud     # Cloud Run registry API
npm run dev             # Marketing site on 5173
npm run dev:app         # Public demo on 5174
```

For documentation work, run `npm run dev` and open `http://127.0.0.1:5173/docs/`. Edit the Markdown in `docs/`; the website renders the same files with navigation, tables and code examples. `CONTRIBUTING.md` is also available at `/docs/contributing/`. `npm run build` includes the rendered pages under `dist/docs/`. No separate docs repository or hosting service is needed.

The renderer and local-link checks live in `scripts/build-docs.mjs`. Run `npm run test:docs` after changing that renderer or its route handling. Website-only work does not require starting the device daemon or rebuilding the Mac application.

The Firebase website and portal use the existing `tantawowa-device-deck` project. Only `dist/` is hosted; the authenticated registry API runs separately on Cloud Run. Never deploy the local `build/`, runtime directory, capture files or private endpoint credentials to Firebase.

## Public website hosting

The public website and docs use [device-deck.tantawowa.com](https://device-deck.tantawowa.com/), attached as a custom domain to the existing Firebase Hosting site. Cloudflare manages the DNS records with proxying disabled, shown as **DNS only**. Firebase serves the site and provisions its HTTPS certificate. Keep Firebase's domain-verification records in DNS so ownership and certificate renewal continue to work.

The existing `tantawowa-device-deck.firebaseapp.com` and `tantawowa-device-deck.web.app` addresses remain available. Public pages declare the custom domain as their canonical URL. The signed-in portal and machine pairing retain their configured Firebase origin; see [remote access](remote-access.md#pair-a-machine). Changing the public website address does not require changing portal authentication, signing keys or existing pairings.
