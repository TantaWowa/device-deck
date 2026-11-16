---
name: device-deck-setup
description: Set up Device Deck on a Mac, connect capture cards and devices, register or create simulators, and configure an agent's MCP connection.
---

# Device Deck setup

Complete the user's requested setup against the installed release. Reuse the Mac's existing Device Deck service, device registrations, SDKs and virtual devices.

## Read the relevant guide

Start with the [agent setup guide](https://device-deck.tantawowa.com/docs/agent-setup/). Read the branch needed for this task:

- Installation, shared accounts, permissions or updates: [Mac installation](https://device-deck.tantawowa.com/docs/install/).
- Physical devices or capture cards: [compatibility](https://device-deck.tantawowa.com/docs/compatibility/) and [workspace setup](https://device-deck.tantawowa.com/docs/using-device-deck/). Physical iPhone or iPad control also needs the [signed helper setup](https://device-deck.tantawowa.com/docs/physical-ios/).
- Existing or new virtual devices: [simulators and emulators](https://device-deck.tantawowa.com/docs/simulator-controls/).
- MCP connection or configuration writes: [API and MCP reference](https://device-deck.tantawowa.com/docs/api/).

The website follows repository development. Compare it with the installed version and its release notes. Prefer the installed operation schemas when commands or capabilities differ.

## Inspect before changing

Identify the macOS version, chip architecture, installed app version, shared-service host account and existing setup. Inspect host diagnostics and device inventory through the dashboard or available Device Deck tools. Ask only for choices that discovery cannot resolve, such as which identical capture card feeds a particular TV.

Use `devdeck api` or MCP `api_describe` to discover supported operations before constructing calls. Discovery finds targets; registration is a separate step. Use **Discover / add devices** in the dashboard, or installed configuration operations when supported. For `config.save`, read the latest `config.get` revision and preserve all unrelated configuration. If the revision changes, reread and merge the intended change.

## Complete the requested branch

**Install or update.** Use the signed installer linked by the Mac guide for this chip. The package includes Node, FFmpeg and ffprobe. Prefer the app's first-run setup and update controls. Let the user complete macOS administrator authentication, permission prompts and hardware pairing. Keep existing sessions and recordings intact; use **Install when idle** when appropriate. Normal installation needs no logout or restart.

**Shared accounts.** Choose the account that owns the devices, SDKs, simulator runtimes and pairing as the host. An existing host is authoritative. Add only the Mac accounts the user requested through **Mac setup… → Mac account access**. Other accounts connect to that shared service; creating another daemon or copying its private tokens is unnecessary. Boot availability starts after FileVault disk unlock. USB capture requires the host's logged-in menu app and Camera permission; Apple simulators need a usable host desktop. Native CI tools still need the account that owns their simulator environment.

**Capture cards and physical devices.** Discover stable hardware identities and match the actual input to the intended device. Reuse an existing source binding. Register a card as capture-only when no supported remote-control adapter exists. Roku and physical Apple TV video require USB capture; their network control alone supplies no video. Check the selected backend's capabilities before promising touch, input or recording.

**Existing simulators.** Discover the host's installed Apple simulators and Android AVDs before creating anything. Register exact Apple UDIDs or persistent Android AVD names. Preserve custom SDK and device-storage paths. A device name or reused emulator serial is insufficient identity. Prefer a matching idle virtual device and respect existing reservations and maintenance locks.

**New simulators.** When the requested device does not exist and creation is in scope, use the host's Xcode or Android SDK tooling to create it, then discover and register it in Device Deck. Device Deck does not install SDKs, system images or create simulator definitions. Check installed runtimes, chip compatibility and free disk space first. Confirm material downloads or unresolved device/runtime choices with the user. Leave license acceptance to the user. Keep existing definitions and app data; creation does not require erasing another device.

**MCP connection.** Use the installed app's stdio launcher from the MCP reference and the client's current supported configuration format. Preserve other MCP servers. The shared installation discovers granted Mac-account access automatically; omit development-profile overrides. This skill provides instructions, not device access: the client still needs its MCP connection or local tools. After configuration, verify a read-only health or inventory call.

## Verify the result

Verify each requested device appears under the intended stable identity and report its actual readiness. Before control or capture, reserve it and retain the session ID and lease token privately. Release only the reservation created for this task after finalizing its recording. If another client owns the target, leave that work running and report the dependency.

For an authorized capture check, inspect a saved image or decoded video frame. A successful command alone does not prove usable video. End with the configured devices, checks that passed, and any remaining user action or unsupported capability. Distinguish configured from tested.
