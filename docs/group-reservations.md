# Device groups for CI and agent work

A reservation group acquires every device a run needs before any test starts. The request describes capabilities and stable operator tags, not friendly names or temporary emulator serials. Device Deck selects distinct devices, claims all logical devices and capture sources in one SQLite transaction, starts stopped virtual devices in parallel, and returns only after every member is ready. If selection or preparation fails, no partial group remains available to the run.

## Configure the pool

Register each device once. In **Devices → Edit**, add comma-separated tags such as `ci`, `nightly`, or `shared-lab`. Tags are operator policy: discovery does not invent them and editing or rediscovery preserves them. A request can combine:

- `platform`: `Roku`, `Android`, `Apple`, or `Other`
- `kind`: `physical` or `virtual`
- `formFactor`: `phone`, `tv`, or `other`
- `tags`: every listed tag must be present
- the existing `device`, `name`, `state`, and `capabilities` criteria

Form factor comes from stable connection/input metadata, not a friendly name. iPad-class touch devices are currently in the `phone` class; use tags when a pool needs a narrower policy.

Physical devices must already be online. A stopped registered Apple simulator or Android AVD is eligible when its saved UDID/AVD identity can launch it. Device Deck never installs runtimes, SDKs, AVDs, or simulators.

After claiming the complete set, Device Deck gives each member up to two minutes to stabilize while it rechecks readiness and transient Android AVD identity. This wait belongs to the allocator; CI jobs and test suites do not add sleeps. A virtual device already starting remains externally owned and is never shut down by group cleanup. Device Deck records `startedByGroup` immediately before it launches a definitively stopped virtual device, and release restores only those recorded cold starts. A timeout reports the affected group, alias, device, and last readiness detail, then rolls back the complete group.

## Manifest and CLI

Create an ephemeral manifest after the test planner has selected its suites:

The shipped [`examples/ci-reservation.json`](../examples/ci-reservation.json)
is a starting point; replace its group ID and emit only the aliases selected
for the current run.

```json
{
  "version": 1,
  "groupId": "TantaWowa/hosanna-ui/35732895965/1/framework-regressions",
  "owner": "GitHub Actions",
  "reason": "Selected framework regression suites",
  "ttlMinutes": 240,
  "requests": {
    "androidPhone": {
      "selector": {
        "platform": "Android",
        "kind": "virtual",
        "formFactor": "phone",
        "tags": ["ci"]
      }
    },
    "androidTv": {
      "selector": {
        "platform": "Android",
        "kind": "virtual",
        "formFactor": "tv",
        "tags": ["ci"]
      }
    }
  }
}
```

Reserve once, before the test commands, and keep the result file private:

```sh
devdeck reserve "$RUNNER_TEMP/device-request.json" \
  --result-file "$RUNNER_TEMP/device-reservation.json" --json
```

`--result-file` is important. The CLI generates a random group credential and atomically writes `{groupId,leaseToken}` to that owner-only file before it sends the request. On success it replaces the file with the full response. Cleanup therefore retains authority even if the CLI is interrupted or the HTTP response is lost after the daemon commits the group. Shell redirection alone cannot provide that guarantee.

When `--result-file` is present, stdout deliberately omits `leaseToken`; it is safe to keep `--json` output in a CI log. The private result file is authoritative. Repeating the same command with the same manifest and result path reuses the existing credential rather than replacing it. An already-active matching request returns the persisted original bindings without depending on a fresh identity lookup; it still verifies that every member is online. A request still preparing asks the caller to retry shortly. A different group ID or manifest cannot reuse that credential.

The private result file (and the raw API response) has this shape:

```json
{
  "groupId": "TantaWowa/hosanna-ui/35732895965/1/framework-regressions",
  "leaseToken": "SECRET",
  "createdAt": 0,
  "expiresAt": 14400000,
  "devices": {
    "androidPhone": {
      "sessionId": "SESSION_ID",
      "id": "CONFIGURED_DEVICE_ID",
      "name": "CI Android phone",
      "platform": "Android",
      "kind": "virtual",
      "connection": {
        "type": "adb",
        "serial": "emulator-5570",
        "avdName": "Hosanna_Phone_API_36",
        "port": 5037
      },
      "startedByGroup": true
    }
  }
}
```

Use the returned concrete connection (`connection.serial` for Android and `connection.udid` for Apple) with the existing test runner. The test suite does not need a Device Deck dependency.

Always release in the job's unconditional cleanup:

```sh
devdeck release "$RUNNER_TEMP/device-reservation.json"
```

Release requires the group credential, is idempotent, closes every member session, and shuts down only virtual devices that this group cold-started. Virtual devices that were already running stay running. If the prewritten credential exists but admission definitely failed before creating a group, CLI release reports `not-found` successfully. An incorrect credential for an existing group still fails.

Long-running agent work can extend the shared expiry:

```sh
devdeck renew "$RUNNER_TEMP/device-reservation.json" --ttl 60
```

TTL expiry and daemon restart use the same whole-group cleanup path, providing a safety net for cancelled jobs and dead agents. A cleanup that cannot be verified leaves the group closing and its devices maintenance-locked; retry release after fixing the underlying simulator/device problem.

## JavaScript and operation API

Source builds and unpacked releases include the supported Node ESM entry point `build/client.mjs`. It exports `callOperation`, `createReservationGroupLeaseToken`, `reserveDeviceGroup`, `renewDeviceGroup`, and `releaseDeviceGroup`. Persist the generated token in a private file before calling reserve; the CLI remains the simplest crash-safe implementation because `--result-file` performs that write for you.

```js
import {
  createReservationGroupLeaseToken,
  reserveDeviceGroup,
  releaseDeviceGroup,
} from "/absolute/path/to/device-deck/build/client.mjs";

const leaseToken = createReservationGroupLeaseToken();
// Atomically persist {groupId: manifest.groupId, leaseToken} with mode 0600 here.
const reservation = await reserveDeviceGroup(manifest, leaseToken);
try {
  // Use reservation.devices.*.connection with the existing test runner.
} finally {
  await releaseDeviceGroup(manifest.groupId, leaseToken);
}
```

Raw HTTP/MCP callers use `sessions.reserveGroup`, `sessions.renewGroup`, and `sessions.releaseGroup`; the reserve operation requires the client-generated `leaseToken` in addition to the manifest fields.

The secret token owns all member sessions, so it can also be used with a returned member `sessionId` for normal input/capture operations. Group members cannot be individually renewed, released, or taken over; release the group to preserve its all-or-nothing lifecycle.

## Runner requirements

Each runner host needs:

1. Device Deck installed and its daemon running as the same account that owns the registered simulators and SDKs.
2. Every eligible target registered with stable identity and explicit pool tags.
3. Physical devices kept online; virtual runtimes/AVDs installed and launchable.
4. A license whose concurrent-session limit covers the largest requested group.
5. A unique group ID including repository, run ID, attempt, and job identity.
6. An ephemeral manifest produced by that project's own test decision tree, one pre-test reserve, use of the returned concrete connections, and unconditional release.

Do not put Device Deck calls inside every test or teach a shared test framework about one lab allocator. The project/CI orchestration layer knows which suites were selected; Device Deck owns allocation and lifecycle; the existing test runner consumes concrete device identifiers.

When a group cannot be formed, `group-no-match` details list each alias, its selector, matching configured device IDs/names, and why each match is unusable (offline physical device, missing virtual identity/runtime, lock, or active reservation). If every alias has usable matches but the complete assignment still fails, the aliases are competing for the same device or capture source.
