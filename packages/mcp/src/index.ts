import { version } from "../../core/src/version";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callOperation, callService, serviceRequest, selectedDeck } from "../../core/src/client";
import { deckNameSchema } from "../../core/src/decks";
import { operations, type Operation } from "../../core/src/local/types";
import { z } from "zod";
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
  "sessions.reserveGroup":
    "Atomically claim a complete criteria-selected device set, then start stopped virtual devices in parallel and wait until every member is ready. The caller must generate and privately persist leaseToken before this call so an uncertain response can always be released. Physical matches must already be online. Failure releases every member and restores virtual devices started for the group.",
  "sessions.renewGroup":
    "Extend every active member of a credential-owned reservation group to one shared expiry.",
  "sessions.releaseGroup":
    "Idempotently release every member of a credential-owned reservation group and close only virtual devices that group started.",
  "sessions.release":
    "Release this credential-owned session after finalizing capture. Old credentials cannot control a successor.",
  "sessions.takeover":
    "Explicitly take over an existing session with a reason and confirmed=true. Its recording is finalized before the new reservation.",
  "remote.input":
    "Send exactly one key, text string or x/y tap using a current lease credential. Unsupported keys and platforms return errors.",
  "control.start": "Start daemon-owned persistent touch control for a credential-owned Android, iOS simulator or configured physical iPhone/iPad session. Returns supported gestures and screen dimensions. Android uses pinned scrcpy; iOS simulators use idb; physical iOS uses a signed WebDriverAgent helper over USB. Idle controllers expire after 15 seconds.",
  "control.pointer": "Send an ordered down/move/up/cancel contact in encoded screen pixels through an existing or newly started lease-owned Android controller. Movement is continuous and bounded. Send dimensions matching the current display. Never replay after connection loss.",
  "control.stop": "Cancel active contacts and stop scripted control helpers without releasing the reservation or interrupting recording.",
  "remote.gesture": "Perform a supported tap, swipe or longPress with the current lease, in encoded screen pixels. width/height must match the displayed image; unsupported platforms are rejected. Release or control.stop cleans up the helper.",
  "streams.open": "Negotiate an authenticated H264 WebRTC viewer from a browser SDP offer. View-only streams need no reservation; interactive streams require the exact device session and lease. Return an SDP answer and short-lived stream credentials; ping every 5 seconds and close when leaving.",
  "streams.ping": "Keep this live viewer alive while its original authentication and optional reservation remain valid. Does not renew the reservation.",
  "streams.close": "Close a live viewer and cancel contacts, releasing its encoder/helper references. Does not release the reservation.",
  "remote.override":
    "Explicitly send one key, text string or x/y tap to an already reserved device without taking its reservation. Requires deviceId, the expected active sessionId, the overriding user's display owner and confirmed=true. Preserves the current reservation and recording; changed or ended sessions reject the override. Capture still requires the owner's lease credential.",
  "captures.screenshot":
    "Save a real screenshot in the selected host's capture folder. Optionally copy it to that host's clipboard or make an annotated copy. Return file metadata and image content, including for a remote Deck.",
  "captures.openFolder":
    "Open the configured capture folder in Finder on the Mac running Device Deck. Accepts no path. For remote clients, this opens Finder on the host Mac, not on the viewing computer.",
  "captures.storage": "Report space used by managed capture files, clean originals, metadata and trash.",
  "recordings.start":
    "Start a daemon-owned real recording. It survives client disconnection. Native Android recordings have a 175-second managed limit.",
  "recordings.stop":
    "Finalize and validate the video file, with clean original and aligned key log. Interrupted recordings remain explicitly interrupted.",
  "config.save":
    "Validate and atomically save the complete configuration using the revision from config.get. Reserved devices and source bindings cannot change.",
};
for (const [operation, schema] of Object.entries(operations)) {
  let inputSchema: z.ZodTypeAny = schema;
  while (inputSchema instanceof z.ZodEffects) inputSchema = inputSchema.innerType();
  if (!(inputSchema instanceof z.ZodObject)) throw new Error(`Operation ${operation} requires an object schema.`);
  server.tool(
    operation.replaceAll(".", "_"),
    descriptions[operation as Operation] ||
      `Device Deck ${operation}. Uses the same validated operation as CLI and web.`,
    { ...inputSchema.shape, deck: z.union([z.literal("local"), deckNameSchema]).optional().describe("Connected Deck name, for example ms. Omit for DEVICE_DECK_TARGET or the local Mac. Use the same Deck for every operation on a lease.") },
    async ({ deck, ...args }: Record<string, unknown>) => {
      try {
        const result = await callOperation(
          operation as Operation,
          args,
          "Agent",
          undefined,
          typeof deck === "string" ? deck : selectedDeck(),
        );
        const content: any[] = [{ type: "text", text: JSON.stringify(result) }];
        if (
          operation === "captures.screenshot" &&
          result.status === "completed"
        ) {
          const res = await serviceRequest(`/v1/artifacts/${encodeURIComponent(result.id)}/file`, { signal: AbortSignal.timeout(30000) }, typeof deck === "string" ? deck : selectedDeck());
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
  "decks_list",
  "List remote Deck connections configured on this Mac. Use their names in the deck argument of device, capture and session tools. Reservations remain on the selected host.",
  {},
  async () => {
    try {
      const response = await serviceRequest("/v1/decks", { signal: AbortSignal.timeout(5000) }, "local");
      return { isError: !response.ok, content: [{ type: "text" as const, text: JSON.stringify(await response.json()) }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] }; }
  },
);
server.tool(
  "service_health",
  "Inspect the real local daemon and dependency diagnostics.",
  { deck: z.union([z.literal("local"), deckNameSchema]).optional() },
  async ({ deck }) => {
    try {
      return {
        content: [
          { type: "text", text: JSON.stringify(await callService("health", deck)) },
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
