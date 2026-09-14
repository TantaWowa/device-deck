import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Adapters } from "./index";
import { validateConfig } from "../../config/src";

test("Roku ECP input sends an explicitly empty form POST accepted by physical Ultras", async (t) => {
  const received: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/query/device-info") {
      res.end(
        "<device-info><serial-number>roku-test</serial-number></device-info>",
      );
      return;
    }
    if (
      req.headers["content-type"] !== "application/x-www-form-urlencoded" ||
      req.headers["content-length"] !== "0"
    ) {
      res.writeHead(415);
      res.end();
      return;
    }
    received.push(req.url!);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string, options?: RequestInit) =>
    realFetch(base + new URL(url).pathname, options),
  );
  try {
    const config = validateConfig({
      schemaVersion: 1,
      settings: { folder: "/tmp/deck-test" },
    });
    const adapters = new Adapters(() => config);
    for (const key of [
      "Home",
      "OK",
      "Rewind",
      "FastForward",
      "Replay",
      "Special",
    ])
      await adapters.input(
        {
          id: "roku",
          name: "Roku",
          platform: "Roku",
          kind: "physical",
          model: "Ultra",
          visibility: "local",
          captureSourceId: null,
          connection: { type: "roku", host: "192.0.2.1", serial: "roku-test" },
        },
        { key },
      );
    assert.deepEqual(received, [
      "/keypress/Home",
      "/keypress/Select",
      "/keypress/Rev",
      "/keypress/Fwd",
      "/keypress/InstantReplay",
      "/keypress/Info",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
