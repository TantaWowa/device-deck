#!/usr/bin/env node
import { callService } from "../../core/src/client";
const args = process.argv.slice(2);
const help = `Device Deck 0.1 · local service scaffold\n\nUsage: devdeck <command> [--json]\n\nCommands:\n  status      Inspect service health and implementation status\n  devices     List devices in the service inventory\n  --help      Show this help\n\nRun from this checkout with npm run cli -- <command>.\nStart the service with npm run service.\nDEVICE_DECK_PORT defaults to 47831. The service binds to 127.0.0.1.\n\nNo hardware adapters or session commands are implemented yet.\nExit codes: 0 success, 1 service failure, 2 invalid command.\n`;
if (!args.length || args.includes("--help")) console.log(help);
else if (
  !["status", "devices"].includes(args[0]) ||
  args.slice(1).some((a) => a !== "--json")
) {
  console.error("Unknown command or option. Run devdeck --help.");
  process.exitCode = 2;
} else {
  try {
    const result = await callService(
      args[0] === "status" ? "health" : "inventory",
    );
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else if (args[0] === "status")
      console.log(
        `Device Deck · ${result.status}\nHardware adapters: ${result.hardwareAdapters}\nImplemented: ${result.implemented.join(", ")}\nSession and capture operations are planned.`,
      );
    else
      console.log(
        result.devices.length
          ? result.devices
              .map((d: { id: string; name: string }) => `${d.id}\t${d.name}`)
              .join("\n")
          : "No devices. This scaffold has no registered hardware adapters.",
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: "service-unavailable",
        message: (error as Error).message,
        hint: "Start the service with npm run service.",
      }),
    );
    process.exitCode = 1;
  }
}
