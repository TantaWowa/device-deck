import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callService } from "../../core/src/client";
const server = new McpServer({ name: "device-deck", version: "0.1.0" });
for (const [name, path, description] of [
  [
    "service_health",
    "health",
    "Inspect local service health. This scaffold has no hardware adapters.",
  ],
  [
    "devices_list",
    "inventory",
    "Read the same local inventory used by the CLI and HTTP API. No demo devices are injected.",
  ],
] as const) {
  server.tool(name, description, {}, async () => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await callService(path)),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (error as Error).message }],
      };
    }
  });
}
await server.connect(new StdioServerTransport());
