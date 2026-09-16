import { version } from "../../core/src/version";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callOperation, callService, endpoint } from "../../core/src/client";
import { operations, type Operation } from "../../core/src/local/types";
const server = new McpServer({ name: "device-deck", version });
const descriptions: Partial<Record<Operation, string>> = {
  "license.status":
    "Read the daemon's verified Free, trial or Pro entitlement state. Never returns the license key.",
  "license.activate":
    "Activate an issuer-provided Keygen license on this Mac. Trial and complimentary owner licenses use the same signed verification as paid licenses.",
  "license.refresh":
    "Refresh Keygen validation and the bounded offline certificate. Expired access falls back to Free.",
  "license.deactivate":
    "Deactivate this Mac in Keygen and return to Free. Existing paid work keeps its current bounded lease; new paid operations are denied.",
  "reports.get":
    "Report actual reservation overlap, capture attempts/outcomes by creation timestamp, and contention events within a local calendar range. Defaults to today. Custom start/end dates are inclusive; weeks start Monday. Includes resolved timezone, exclusive end timestamp and asOf timestamp.",
  "capture-cards.list":
    "List detected USB video capture cards and configured disconnected cards by stable hardware identity. Assign using revision-checked config.save; active bindings cannot change.",
  inventory:
    "Read real configured devices, capabilities, reservations, capture files and diagnostics. No seeded devices.",
  discover:
    "Read connected target and USB identities. Discovery does not automatically register or reserve targets.",
  "devices.simulator":
    "Launch or close one configured Apple iOS/tvOS simulator or Android AVD by device ID. Android launch requires a persistent avdName; a running legacy emulator serial can close once its AVD identity is verified. Close requires confirmed=true. Active or closing reservations and recordings must be released and finalized first; this never takes over a session or quits other simulators.",
  "devices.wake":
    "Attempt to wake a configured device without reserving it, including devices reported offline. Before waking any reserved device, warn the user that this may interrupt current work and obtain an explicit wake confirmation; send the expected current sessionId and confirmed=true. Changed, closing or expired reservations reject the request. This preserves reservations and recordings, honors maintenance locks, and reports an attempt rather than proof the device is awake.",
  "sessions.reserve":
    "Atomically reserve one device selected by name, ID or capabilities. Return the session and secret leaseToken. Keep this token for subsequent operations; owner is only a display label.",
  "sessions.release":
    "Release this credential-owned session after finalizing capture. Old credentials cannot control a successor.",
  "sessions.takeover":
    "Explicitly take over an existing session with a reason and confirmed=true. Its recording is finalized before the new reservation.",
  "remote.input":
    "Send exactly one key, text string or x/y tap using a current lease credential. Unsupported keys and platforms return errors.",
  "remote.override":
    "Explicitly send one key, text string or x/y tap to an already reserved device without taking its reservation. Requires deviceId, the expected active sessionId, the overriding user's display owner and confirmed=true. Preserves the current reservation and recording; changed or ended sessions reject the override. Capture still requires the owner's lease credential.",
  "captures.screenshot":
    "Save a real screenshot in the shared local capture folder. Optionally copy it to the Mac clipboard or make an annotated copy. Return file metadata and image content.",
  "recordings.start":
    "Start a daemon-owned real recording. It survives client disconnection. Native Android recordings have a 175-second managed limit.",
  "recordings.stop":
    "Finalize and validate the video file, with clean original and aligned key log. Interrupted recordings remain explicitly interrupted.",
  "config.save":
    "Validate and atomically save the complete configuration using the revision from config.get. Reserved devices and source bindings cannot change.",
};
for (const [operation, schema] of Object.entries(operations)) {
  server.tool(
    operation.replaceAll(".", "_"),
    descriptions[operation as Operation] ||
      `Device Deck ${operation}. Uses the same validated operation as CLI and web.`,
    schema.shape,
    async (args: Record<string, unknown>) => {
      try {
        const result = await callOperation(
          operation as Operation,
          args,
          "Agent",
        );
        const content: any[] = [{ type: "text", text: JSON.stringify(result) }];
        if (
          operation === "captures.screenshot" &&
          result.status === "completed"
        ) {
          const ep = await endpoint();
          const res = await fetch(`${ep.url}/v1/artifacts/${result.id}/file`, {
            headers: { Authorization: `Bearer ${ep.token}` },
            redirect: "error",
          });
          if (res.ok) {
            const data = Buffer.from(await res.arrayBuffer());
            if (data.length <= 8 * 1024 * 1024)
              content.push({
                type: "image",
                mimeType: "image/png",
                data: data.toString("base64"),
              });
          }
        }
        return { content };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: (error as any).code || "service-error",
                message: (error as Error).message,
                details: (error as any).details,
              }),
            },
          ],
        };
      }
    },
  );
}
server.tool(
  "service_health",
  "Inspect the real local daemon and dependency diagnostics.",
  {},
  async () => {
    try {
      return {
        content: [
          { type: "text", text: JSON.stringify(await callService("health")) },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: (e as Error).message }],
      };
    }
  },
);
await server.connect(new StdioServerTransport());
