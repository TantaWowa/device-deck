import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/mcp.mjs"],
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "device-deck-proof", version: "1" });
await client.connect(transport);
const invoke = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result;
};
let lease;
try {
  const inventory = await invoke("inventory", {});
  const snapshot = JSON.parse(inventory.content[0].text);
  if (!snapshot.devices.some((d) => d.id === "proof-ios"))
    throw new Error("Proof simulator missing");
  const reserved = JSON.parse(
    (
      await invoke("sessions_reserve", {
        selector: { device: "proof-ios" },
        owner: "MCP proof",
        reason: "Real MCP session",
      })
    ).content[0].text,
  );
  lease = { sessionId: reserved.session.id, leaseToken: reserved.leaseToken };
  await invoke("remote_input", { ...lease, key: "Home" });
  const image = await invoke("captures_screenshot", lease);
  if (
    !image.content.some((c) => c.type === "image" && c.mimeType === "image/png")
  )
    throw new Error("MCP screenshot image missing");
  await invoke("sessions_release", lease);
  const stale = await client.callTool({
    name: "remote_input",
    arguments: { ...lease, key: "Home" },
  });
  if (!stale.isError) throw new Error("MCP stale credential accepted");
  console.log(
    "MCP real inventory, reserve, input, screenshot image, release and stale-credential rejection passed.",
  );
} finally {
  if (lease)
    await client
      .callTool({ name: "sessions_release", arguments: lease })
      .catch(() => {});
  await client.close();
}
