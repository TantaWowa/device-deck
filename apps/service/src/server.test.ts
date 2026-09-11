import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createService } from "./server";
test("service has no seeded hardware, rejects browser origins and unsupported mutations", async () => {
  const server = createService();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const inventory = await fetch(url + "/v1/inventory").then((r) => r.json());
    assert.deepEqual(inventory, { devices: [], sources: [], leases: [] });
    assert.equal(
      (
        await fetch(url + "/v1/inventory", {
          headers: { Origin: "https://example.com" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/v1/sessions", { method: "POST" })).status,
      501,
    );
    const rejected = await new Promise<number | undefined>(
      (resolve, reject) => {
        http
          .get(
            url + "/v1/health",
            { headers: { Host: "untrusted.test" } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          )
          .on("error", reject);
      },
    );
    assert.equal(rejected, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
