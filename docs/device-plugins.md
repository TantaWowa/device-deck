# Generic device plugins

We are adding a generic device plugin API to Device Deck. The goal is to let any device with a usable control or observation interface join the same inventory, reservations and capture workflow. A plugin would translate that device's protocol into capabilities that people, coding agents and CI can use.

**Status: planned API, design preview.** This page describes the intended direction, not an SDK available in the current release. The names and code below are illustrative and will change during implementation. There is no public plugin installation command, package format or compatibility promise yet.

"Any device" means an extension point for new device types. Each integration still needs a working driver or protocol, the required permissions and tests against real hardware. A plugin cannot supply video, touch or remote control that the device does not expose.

## What works today

Device Deck has built-in adapters for supported mobile devices, TVs and simulators. Its [compatibility guide](compatibility.md) lists their capabilities and limits. The internal [`DeviceInteraction` contract](../packages/core/src/device-interaction.ts) covers input, viewing, screenshots, UI reads, logs and app operations. The [`Adapters` implementation](../packages/adapters/src/index.ts) selects a built-in backend.

These are internal interfaces. The current [configuration schema](device-deck.schema.json) accepts a fixed set of connections and capture sources. It does not load arbitrary third-party plugins or accept the proposed fields below.

You can already [create a named capture-only device](reports-and-capture-cards.md#capture-cards) for an HDMI source connected through a USB capture input. For example, a Mac mini or games console can appear in the inventory with its assigned feed. Naming that device does not add keyboard, touch, power or network control.

## What a plugin should add

A device plugin should explain how to find a target, verify its identity, report its health and perform its supported operations. Device Deck should continue to own access checks, reservations, operation ordering and capture records.

| Responsibility | Proposed behavior |
| --- | --- |
| Identify and configure | Declare a stable plugin ID, supported host versions and a configuration schema. Keep a hardware serial or equivalent stable identity separate from a changing IP address or USB path. |
| Discover | Offer bounded discovery where the protocol supports it. Manual configuration should also work. Discovering a device should not silently pair with it or take control. |
| Connect and probe | Report reachable, disconnected, unauthorized, busy or unavailable, with an explanation and next step. Verify the target identity before acting. |
| Describe capabilities | Advertise only operations that this target can perform with its current permissions, tools and connection. A device without a screen still has value in the inventory. |
| Observe | Provide optional status, screenshots, video, logs or structured readings, with timestamps and device identity. Bound logs and stream lifetimes. |
| Control | Implement standard operations where they fit, such as keys, text, touch or restart. Describe device-specific actions with validated input and result schemas. |
| Clean up | Close owned connections and helper processes, stop streams and report whether cleanup completed. A failed cleanup must remain visible before the device is reassigned. |

The intended result is that the dashboard, CLI and MCP clients all see the same capabilities. A plugin should not need a separate agent integration for every coding assistant. How custom actions appear in the dashboard and MCP tool list is still a design decision.

## Devices this could manage

These are possible integrations, not additional supported devices in the current release.

| Example | What an adapter could expose | What it would need |
| --- | --- | --- |
| A TV or set-top box without a built-in adapter | Discover or configure the TV, send remote keys, select an input, report power state and associate an HDMI feed. | A documented or tested network, serial, infrared or HDMI-CEC control path. A separate compatible capture card for video when the device cannot stream it. |
| A serial-connected embedded board | Read firmware version and bounded logs, reset the board, report boot readiness and run a named diagnostic. | A stable USB identity, serial access and a defined command protocol. Firmware flashing would be a separately declared action with explicit safeguards. |
| A network camera with pan, tilt and zoom | Show its stream, save a still, report connection state and select a PTZ preset. | Supported video and control protocols, credentials and limits on movement. RTSP or ONVIF support would need an implementation; it is not implied by this proposal. |
| A kiosk or custom smart display | Combine a capture feed with its test API, send supported input, launch a test screen and collect logs. | A controllable target and a stable way to bind the control connection to the correct video source. |
| A hardware test fixture | Report sensor readings, select a relay or reset one target through a controllable power outlet. | Named outputs, bounded actions and ownership rules for shared resources. Turning off an outlet must not interrupt another reserved device. |
| A virtual target or specialised simulator | List instances, start one, wait for readiness, expose its control API and close only the instance started for the session. | A host-side driver, an instance identity and clear rules for preserving pre-existing instances. |

A useful first plugin can be read-only. An instrument that reports a measurement or an embedded board that supplies logs does not need to pretend it supports touch input or a video feed.

## An illustrative API shape

The following TypeScript-style pseudocode sketches a TV plugin. It is **not runnable code** and does not name an existing package. `Driver`, `Schema` and the other types stand for contracts that still need to be designed.

```ts
// Proposed shape only. No public SDK exports these types today.
const televisionPlugin = {
  id: "example.network-tv",
  apiVersion: "proposal-v1",
  configSchema: Schema.object({
    address: Schema.string(),
    expectedSerial: Schema.string(),
    credentialRef: Schema.secretReference().optional(),
  }),

  async discover(context) {
    return Driver.findTelevisions({
      signal: context.signal,
      deadline: context.deadline,
    });
  },

  async open(config, context) {
    const tv = await Driver.connect({
      address: config.address,
      credential: await context.secrets.resolve(config.credentialRef),
      signal: context.signal,
      deadline: context.deadline,
    });
    await tv.requireSerial(config.expectedSerial);

    return {
      identity: { serial: config.expectedSerial },
      capabilities: { status: true, key: true, video: false },
      actions: {
        "example.network-tv.select-input": {
          inputSchema: Schema.object({ input: Schema.enum(["hdmi1", "hdmi2"]) }),
          resultSchema: Schema.object({ selectedInput: Schema.string() }),
          requiresReservation: true,
          async run(input, operation) {
            // Device Deck would authorize and validate before dispatch.
            return tv.selectInput(input.input, operation);
          },
        },
      },
      probe: (operation) => tv.status(operation),
      key: (key, operation) => tv.sendKey(key, operation),
      close: () => tv.close(),
    };
  },
};
```

In this example the TV plugin handles control and reports no video capability. Device Deck would associate a separate USB capture source with the logical TV, as it already does for supported control connections. The API design needs to preserve that separation and prevent two devices from claiming the same physical source.

Namespaced actions let a plugin expose features that do not fit a standard remote. A serial-board adapter might declare `example.board.read-temperature` with a result schema containing a value, unit and timestamp. A camera might declare `example.camera.move-to-preset` with an allowed set of preset IDs. These should be named, validated operations, not an unrestricted shell command field.

## A session from an agent or CI

For the TV example, the intended workflow would be:

1. An administrator installs a compatible plugin, configures the TV and completes any pairing. Device Deck shows the detected identity and available operations.
2. A person, agent or CI job selects that TV and reserves it with a reason. Other clients see that it is in use.
3. The host validates the caller, reservation and action input, then dispatches `select-input` to that exact target.
4. The client observes the result through a status response or the assigned capture feed, then saves the evidence it needs.
5. Release stops owned work and closes the plugin session. Device Deck makes the target available after cleanup completes.

The plugin must not create a second inventory or its own competing reservation system. For a fixture that controls several devices or shared outputs, the host also needs to know which resources each action affects. A reservation on one board must not authorize resetting an entire rack.

## Mac accounts, permissions and failure handling

The planned plugin system must fit the [shared Mac service](macos-distribution.md#shared-mac-service). Allowed desktop accounts and CI runners should connect to the same host inventory. Device work should run in the configured hosting account, not create a separate plugin instance and device claim for each caller.

Starting the core service at boot does not make every device usable before login. Plugins must declare whether they need a desktop session, Camera access, a user keychain, a vendor helper or an interactive pairing step. The existing USB camera bridge and Apple simulator requirements still apply. FileVault must be unlocked before the Mac can start the service.

The design also needs to cover:

- Deadlines and cancellation for discovery, connection, actions and streams. A disconnected device must not block the host indefinitely.
- Stable identity checks after reconnect. An address or USB path reused by a different device must not receive an old session's commands.
- Explicit outcomes for lost responses. Automatically retrying a reset, power change or firmware write can repeat an operation that already succeeded.
- Capability changes while a device is paired, disconnected or missing a helper. Clients need a reason for unavailable actions.
- Cleanup after client exit, lease expiry, plugin failure and host restart. Only processes, sessions and temporary resources owned by that operation should be removed.
- Credentials stored through a host-controlled mechanism and referenced from configuration. Plugin diagnostics, exports and captures must not include secrets by default.

Installing a third-party driver introduces executable code into the host. A capability declaration alone is not a security sandbox. Plugin distribution, signature verification, permission grants and process isolation remain open design work. We will document the actual trust boundary before asking users to install plugins.

## Versioning and contribution

Before a public SDK, we need a versioned contract, a supported Device Deck version range, configuration migrations, installation and removal behavior, and a test harness for discovery, disconnects, reservations and cleanup. Updating or removing a plugin while it owns a device also needs a defined policy. None of those should depend on an agent guessing how a driver behaves.

Have a device in mind? [Open a feature request](https://github.com/TantaWowa/device-deck/issues/new/choose) with its model, control protocol or SDK, Mac dependencies, available capture path and the operations you need. Include whether it must work before login and whether people or CI will share it. Public protocol documentation and a reproducible hardware test help us choose a useful first integration.

For devices supported now, use the [compatibility guide](compatibility.md) and [agent setup prompts](agent-setup.md). For implementation context, start with the [architecture](architecture.md) and [contribution guide](../CONTRIBUTING.md).
