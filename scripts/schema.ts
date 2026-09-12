import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFile } from "node:fs/promises";
import { configSchema, operations } from "../packages/core/src/local/types";
await writeFile(
  "docs/device-deck.schema.json",
  JSON.stringify(
    zodToJsonSchema(configSchema, {
      name: "DeviceDeckConfig",
      $refStrategy: "none",
    }),
    null,
    2,
  ) + "\n",
);
await writeFile(
  "docs/operations.schema.json",
  JSON.stringify(
    Object.fromEntries(
      Object.entries(operations).map(([name, schema]) => [
        name,
        zodToJsonSchema(schema, { $refStrategy: "none" }),
      ]),
    ),
    null,
    2,
  ) + "\n",
);
