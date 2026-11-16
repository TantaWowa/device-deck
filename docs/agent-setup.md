# Set up with an agent

Copy a prompt into Codex, Claude Code or another agent that can work on your Mac. Start with the full setup prompt, or choose the task you need. Expand a prompt to read it, then use **Copy prompt**.

The agent can inspect your setup and run commands for you. You handle administrator approval, macOS permissions, device pairing and plugging in hardware. If your agent cannot operate the desktop, it can guide you through the same screens. The [Mac installer](install.md) needs no commands typed into Terminal.

These prompts work without a plugin. For direct device operations, use [Connect your agent](#connect-your-agent) after installing Device Deck. Your agent must check the installed version's capabilities before using a feature described in the latest docs.

## Full setup

Use this when you want the agent to take you from a new Mac installation to a working device session.

```prompt Set up Device Deck from start to finish
Help me set up Device Deck on this Mac and verify one working device session.

Read https://tantawowa-device-deck.firebaseapp.com/docs/install/ and https://tantawowa-device-deck.firebaseapp.com/docs/compatibility/ first. Inspect the Mac architecture, installed Device Deck version, existing service, devices, platform tools and active reservations before changing anything. Reuse what is already installed and configured.

Ask me which devices I want to use and which Mac account should host them if you cannot establish that from the existing setup. The host should own the SDKs, simulators and device pairing settings. Use the signed Mac installer and the graphical setup. Do not ask me to type Terminal commands. Guide me through administrator approval, Camera or Local Network permission, and physical pairing when needed. Do not request my passwords or tokens in chat.

Start the shared service, check the menu app's login setting, and add only the devices I selected. For a capture card, confirm which HDMI device it is connected to; its USB name does not identify the target. Reuse existing simulators and emulator definitions. Ask before downloading large SDKs or creating a new virtual device. Install only the tools needed by my chosen devices.

Use the installed operation schemas or dashboard controls. Preserve other devices, captures, configuration and active sessions. Do not stop another person's work, reset devices, switch the host account, restart the Mac or log out.

Reserve one available device with a clear owner and reason, inspect its supported capabilities, verify its screen and one appropriate control if supported, then save and inspect a screenshot. Finish my test recording if any and release my reservation. Tell me what works, where the evidence is saved, and any remaining action I need to take. Do not claim before-login or other-account testing unless you actually performed it.
```

## Install or update the Mac app

Use this before adding hardware. Node, FFmpeg and ffprobe come with the signed installer.

```prompt Install or update Device Deck on this Mac
Install Device Deck on this Mac, or update the existing installation safely. Read https://tantawowa-device-deck.firebaseapp.com/docs/install/ and use its official signed download for this Mac's architecture.

Inspect the current version, shared-service state and active sessions first. Preserve the existing host account, settings and captures. If the installed app supports updates, use Check for updates and Install when idle. For an older unsigned beta, follow the guide's migration steps. Do not interrupt active reservations or recordings.

Use the macOS installer and Mac setup screens. I will approve administrator prompts myself. Do not ask me to type Terminal commands or share passwords. Start the shared service from the intended hosting account and check Open menu-bar app at login. Ask for Camera permission only if I will use USB capture. Do not restart or log out of the Mac.

Open the dashboard and check service readiness and Host diagnostics. Report the installed version, hosting account, login setting and any missing device-specific tools. Explain that the core service starts at boot after FileVault unlock, while USB capture and Apple simulators still need the host's desktop session. Leave unrelated devices and running jobs alone.
```

## Add a capture card

Connect the card to the Mac and connect the target's HDMI output to the card. A capture-only device can show video without providing remote control.

```prompt Add and check my USB capture card
Help me add a USB capture card to Device Deck on this Mac. Read https://tantawowa-device-deck.firebaseapp.com/docs/reports-and-capture-cards/ and https://tantawowa-device-deck.firebaseapp.com/docs/install/ first.

Inspect the existing cards, assignments, reservations and host diagnostics. Confirm which physical device feeds the card's HDMI input. Identify the card by its stable hardware identity, not enumeration order, and do not guess the HDMI target from the USB name. If the card is missing, check its connections and the host menu app's Camera permission; guide me through any permission prompt.

Use Capture Cards, Discover / refresh and Assigned device to bind the selected card to the correct configured device. For hardware that only needs capture, use Assigned device, Family, Other to create a named capture-only device. Preserve existing names and assignments unless I asked to change them. Do not change a reserved or recording device.

If you use the API instead of the dashboard, discover the installed schemas, read the complete current configuration and save the minimal change with its revision. Discovery alone does not save an assignment.

Open the feed and confirm that it shows the intended hardware. Reserve the device, save a screenshot, inspect the image, then release the reservation. If I requested a recording, stop and inspect it too. Report whether video works and whether this device has remote control. Captures are silent in this release.
```

## Configure physical devices

For Roku, Android, Fire TV, Apple TV, iPhone or iPad. The agent should identify the target before choosing its platform tools.

```prompt Discover and configure my physical devices
Help me add my physical devices to Device Deck. Read https://tantawowa-device-deck.firebaseapp.com/docs/compatibility/ and https://tantawowa-device-deck.firebaseapp.com/docs/install/. Inspect the configured inventory, reservations, discovery results and Host diagnostics first, then ask which unconfigured devices I want to add if that is unclear.

Use Devices, Discover / add devices, then Add selected for those targets. Preserve existing identifiers and avoid duplicates. Check the exact target's network address or USB identity before pairing or sending input. Install only its missing platform tools, in the hosting account. Guide me through device-side network control, debugging authorization, trust or pairing prompts; I will enter private codes myself.

For Roku and physical Apple TV, configure control separately from video; video needs an explicitly assigned USB capture input. For a physical iPhone or iPad, follow https://tantawowa-device-deck.firebaseapp.com/docs/physical-ios/ for the signed helper and supported capabilities. Do not describe discovery alone as working control. Unsupported TVs can use capture-only setup, without invented network controls.

Use installed operation schemas if working through CLI or MCP. Configuration writes must preserve the full current configuration and use its latest revision. Do not take over another reservation or restart a device being used.

Reserve each selected available device for a brief check, inspect its capabilities, verify supported input and capture, and release the reservation afterward. Report each device separately as working, partly working or blocked, with the exact missing step and evidence path.
```

## Add existing simulators and emulators

Device Deck discovers virtual devices already created in the hosting account. It does not install Xcode runtimes, Android SDKs or Android system images.

```prompt Register my existing simulators and emulators
Add my existing Apple simulators and Android emulators to Device Deck without creating duplicates. Read https://tantawowa-device-deck.firebaseapp.com/docs/simulator-controls/ and https://tantawowa-device-deck.firebaseapp.com/docs/compatibility/.

Inspect the Device Deck host account, current inventory, active reservations, Xcode selection, installed simulator runtimes, Android SDK paths and existing AVDs. Use the host's existing simulator and emulator homes. Follow any repository or machine rules for shared virtual-device reservations.

Use Devices, Discover / add devices to find running and stopped virtual devices. Show me a short list if you need me to choose targets, then register only those selected. Match Apple devices by exact UDID and Android emulators by persistent AVD name. Do not reuse an arbitrary emulator serial or silently substitute a similar device. Configure existing executable paths through Settings when needed.

Check the installed operation schemas. For a brief automated test, reserve the selected virtual device through a reservation group so its claim and startup happen together. Inspect capabilities, verify its screen and supported input, save a screenshot and release the group. Explain any desktop-session or helper requirement. Do not erase devices, reset data, kill other emulators or end another user's reservation.

Report the registered names and exact identities, runtime versions, verified capabilities and anything still missing.
```

## Create an Apple simulator

Use this for a new iPhone, iPad or Apple TV simulator. The prompt asks the agent to reuse a suitable existing device before creating one.

```prompt Create and register an Apple simulator
Help me create an Apple simulator for Device Deck. Read https://tantawowa-device-deck.firebaseapp.com/docs/simulator-controls/ and https://tantawowa-device-deck.firebaseapp.com/docs/compatibility/.

Inspect the hosting Mac account, selected Xcode, installed runtimes, existing simulator UDIDs, available disk space and shared-device rules first. Ask which device family and OS version I need if I have not specified them. Reuse an existing matching simulator if it is suitable. Do not change the global Xcode selection or relocate simulator storage without explaining the need first.

If a new simulator is needed, create one in the Device Deck host account using Xcode's supported simulator tools. Use an installed compatible runtime where possible; ask before a large runtime download. Guide me through Apple sign-in, license or permission steps that need my input. Do not reset, delete or recreate existing simulators.

Register the new simulator through Device Deck discovery using its exact UDID. Check Host diagnostics for the helpers required by my chosen capabilities; Apple input and iOS live video need idb and its companion. Use installed operation schemas, and reserve it through a group before starting the verification session.

Verify readiness, inspect supported capabilities, save and inspect a screenshot, and test supported input. Release my reservation after the check. Report the simulator name, UDID, runtime, verified capabilities and any remaining helper or desktop-session requirement. Leave other devices and jobs alone.
```

## Create an Android emulator

Use this for a new phone, tablet or TV AVD. Keep the AVD in the hosting account so Device Deck can find it later.

```prompt Create and register an Android emulator
Help me create an Android emulator for Device Deck. Read https://tantawowa-device-deck.firebaseapp.com/docs/simulator-controls/ and https://tantawowa-device-deck.firebaseapp.com/docs/compatibility/.

Inspect this Mac's architecture, Device Deck hosting account, SDK paths, installed emulator and platform tools, existing AVDs, system images, free disk space and shared-device rules. Ask which device family and Android version I need if I have not specified them. Reuse a suitable existing AVD before creating another.

Create the needed AVD with Android Studio's Device Manager or the installed SDK tools, under the hosting account and its existing AVD home. Select an image compatible with this Mac's architecture. Ask before downloading a large system image, and let me handle SDK licenses or sign-in steps. Do not move SDK storage, wipe emulator data, or replace an existing AVD.

Set Device Deck's existing adb and emulator executable paths in Settings if discovery needs them. Register the exact AVD through Devices, Discover / add devices. Preserve its persistent AVD name; do not identify it solely by a temporary emulator serial.

Use the installed operation schemas and a reservation group to claim and start the emulator for verification. Check the actual ADB transport, capabilities, screen and supported input. Save and inspect a screenshot, then release my group. Report the AVD name, Android version, architecture, working capabilities and any remaining action. Leave unrelated emulators and reservations alone.
```

## Connect your agent

MCP gives the agent Device Deck tools for inventory, reservations, control and captures. A prompt or skill provides guidance; it does not grant access by itself.

```prompt Connect Codex or Claude to Device Deck
Connect this coding agent to the installed Device Deck MCP server. Read https://tantawowa-device-deck.firebaseapp.com/docs/api/#mcp-walkthrough and https://tantawowa-device-deck.firebaseapp.com/docs/agent-device-workflow/.

Identify the agent client and its current supported MCP configuration format. Inspect existing settings and preserve other servers. Use the client's installed help or official documentation rather than guessing its configuration file format. Confirm that Device Deck's shared service is ready and this Mac account has access.

Configure a stdio server named device-deck with command /Applications/Device Deck.app/Contents/MacOS/devdeck and the single argument mcp. Keep the path containing spaces as one command value. Use the app's bundled runtime. Do not add a separate Node installation or set DEVICE_DECK_HOME or DEVICE_DECK_CONFIG for the normal shared installation. Do not copy host API tokens into the client configuration or chat.

Reload the client connection if needed and verify its tool list, installed operation schemas and inventory. Start with read-only checks. Do not reserve or control a device merely to prove that MCP is connected.

Explain how I can ask this agent to reserve a device, inspect its capabilities, capture evidence and release it. Keep lease credentials private, and remind me that disconnecting an MCP client does not stop its active recording or release its reservation. Report any client approval I still need to complete.
```

## Allow CI or another Mac account

The host chooses which existing accounts can connect. Native test runners still need to respect macOS ownership of simulators and SDKs.

```prompt Give another Mac account access to Device Deck
Help me allow an existing Mac account, such as ci-runner, to use this Mac's shared Device Deck service. Read https://tantawowa-device-deck.firebaseapp.com/docs/install/#allow-another-mac-account and https://tantawowa-device-deck.firebaseapp.com/docs/group-reservations/.

Inspect the existing host account and service state. Ask which exact account should have access if I have not named it. From the host's menu-bar app, open Mac setup and use Mac account access to allow only that account. I will complete any required approval. Preserve the host and all other account settings. Do not create another daemon, copy private API tokens, widen unrelated permissions or restart the Mac.

Verify the allowed account can read the same Device Deck inventory when an authorized session for that account is available. Do not log me out or switch accounts automatically. If you cannot test that account, say exactly what still needs checking.

For CI, show how the installed CLI or MCP can reserve a group and release it in unconditional cleanup. Native tools that use a host-owned Apple simulator must also run under the host account; account access does not merge simulator homes. Do not provision virtual devices under a runner account against machine policy.

Explain that the core service starts at boot after FileVault unlock, while USB capture and Apple simulator features still depend on the host desktop environment. Report the granted account and the checks actually completed, without claiming an unperformed reboot or before-login test.
```

## Keep a reusable setup skill

The optional [Device Deck setup skill](../skills/device-deck-setup/SKILL.md) gives Codex or Claude Code the same setup workflow on later tasks. You can read the full skill before installing it. It contains instructions only; it does not install Device Deck or connect MCP automatically.

```prompt Add the Device Deck setup skill to this project
Add the official Device Deck setup skill to this project's agent skills so I can reuse it later.

Read https://raw.githubusercontent.com/TantaWowa/device-deck/main/skills/device-deck-setup/SKILL.md. Inspect this project's agent instructions and identify whether I am using Codex or Claude Code. Use the client's current supported project skill directory, checked against its installed help or official documentation.

Install only the device-deck-setup skill. Preserve existing skills and settings. If a skill with that name already exists, compare it before updating and preserve my local changes. Do not install plugins, alter MCP connections or start device setup as part of this task.

Validate the skill metadata, tell me where it was saved and how to invoke it in this client. If a reload is needed, explain that step. Do not claim it is loaded until you can verify it.
```

For the underlying controls, see [the Mac walkthrough](install.md), [device compatibility](compatibility.md), [simulator management](simulator-controls.md) and [agent operations](agent-device-workflow.md).
