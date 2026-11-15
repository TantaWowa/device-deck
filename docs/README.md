# Device Deck documentation

Device Deck is a Mac workspace for shared devices, simulators and captures. Use it from the dashboard, CLI, terminal UI or an MCP client. Local use is free under MIT and needs no Device Deck account.

These pages describe the source in this repository. Release notes and the [install guide](install.md) identify what is available in each downloadable package.

## Start here

1. [Install Device Deck](install.md) for your Mac architecture and release.
2. [Check device compatibility](compatibility.md), platform tools and current limits.
3. [Run your first device session](using-device-deck.md#first-device-session), then find the saved capture.

## Use your workspace

- [Devices, feeds, remotes and captures](using-device-deck.md)
- [Live video and touch](live-video-and-touch.md)
- [Launch and clean up simulators](simulator-controls.md)
- [Reports and capture-card assignments](reports-and-capture-cards.md)
- [Set up physical iPhone and iPad control](physical-ios.md)

## Share devices

- [Team setup](team-rollout.md)
- [Open your Mac through Tailscale](using-device-deck.md#open-device-deck-from-another-machine)
- [Connect another Mac's Deck](deck-sharing.md)
- [Remote access and the optional account portal](remote-access.md)
- [Separate development and CI profiles](multiple-accounts.md)

## Automate a workflow

- [CLI, HTTP and MCP reference](api.md), including [MCP client setup](api.md#mcp-walkthrough)
- [Interactive agent work](agent-device-workflow.md)
- [Reserve device groups for CI and agents](group-reservations.md)
- [Operation schemas](operations.schema.json) and [configuration schema](device-deck.schema.json)

## Contribute and maintain

- [Contribution guide](../CONTRIBUTING.md)
- [Development setup and repository map](development.md)
- [Architecture](architecture.md)
- [Validation history and evidence limits](validation.md)
- [Source provenance and third-party components](source-provenance.md)
- [Build and operate Mac packages](macos-distribution.md)
- [Publish a release](release-publishing.md)

Earlier implementation receipts are retained in [local delivery](local-delivery.md), [website/demo delivery](delivery.md) and the [demo redesign](redesign.md). They record earlier milestones rather than current release acceptance.

## Where these docs live

The Markdown files in `docs/` are the source for both GitHub documentation and the website's `/docs/` section. The website lives in `apps/website/`; its build renders these files alongside the marketing pages. Update a Markdown page here to change both reading paths. See [development setup](development.md) to preview the site locally.
