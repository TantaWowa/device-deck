import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const exec = promisify(execFile),
  directory = path.resolve("work/range-card-fixture");
const ep = JSON.parse(
  await readFile(path.join(directory, "endpoint.json"), "utf8"),
);
const request = { start: "2026-09-08", end: "2026-09-08" };
const api = await fetch(
  `http://127.0.0.1:${ep.port}/v1/operations/reports.get`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  },
).then((r) => r.json());
const env = { ...process.env, DEVICE_DECK_HOME: directory };
const cli = JSON.parse(
  (
    await exec(
      process.execPath,
      [
        "build/devdeck.mjs",
        "reports",
        "--start",
        request.start,
        "--end",
        request.end,
        "--json",
      ],
      { env },
    )
  ).stdout,
);
const same = (a, b) => {
  a = structuredClone(a);
  b = structuredClone(b);
  delete a.range.asOf;
  delete b.range.asOf;
  assert.deepEqual(a, b);
};
same(api, cli);
await assert.rejects(
  exec(
    process.execPath,
    [
      "build/devdeck.mjs",
      "reports",
      "--start",
      "2026-02-30",
      "--end",
      "2026-03-01",
      "--json",
    ],
    { env },
  ),
  (e) => e.code === 2,
);
const client = new Client({ name: "range-card-proof", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["build/mcp.mjs"],
    env,
    stderr: "pipe",
  }),
);
try {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("reports_get"));
  assert.ok(names.includes("capture-cards_list"));
  const result = await client.callTool({
    name: "reports_get",
    arguments: request,
  });
  assert.equal(Boolean(result.isError), false);
  same(api, JSON.parse(result.content[0].text));
  const invalid = await client.callTool({
    name: "reports_get",
    arguments: { preset: "custom", start: "2026-09-12", end: "2026-09-01" },
  });
  assert.ok(invalid.isError);
  const cards = await client.callTool({
    name: "capture-cards_list",
    arguments: {},
  });
  assert.equal(JSON.parse(cards.content[0].text).sources.length, 3);
  console.log(
    "HTTP, CLI and MCP report ranges match; invalid ranges fail; card inventory is exposed.",
  );
} finally {
  await client.close();
}
