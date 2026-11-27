import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { callOperation, validateEndpoint } from "./client";

test("local endpoint rejects process-group PIDs and non-loopback URL overrides", () => {
  for (const pid of [-1, 0, 1, 2.5, "100", null, undefined, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateEndpoint({ port: 12345, token: "local-token", pid }), /Invalid local endpoint/);
  for (const value of [null, {}, "invalid", { port: 12345, pid: 100, token: "" }])
    assert.throws(() => validateEndpoint(value), /Invalid local endpoint/);
  const ep = validateEndpoint({ port: 12345, token: "local-token", pid: 100, url: "https://example.com" });
  assert.equal(ep.url, "http://127.0.0.1:12345");
  assert.equal(ep.pid, 100);
});

test("app cleanup waits for the host result past the default response header timeout", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-slow-cleanup-"));
  const previousHome = process.env.DEVICE_DECK_HOME;
  const previousDispatcher = getGlobalDispatcher();
  const shortRequests = new Agent({ headersTimeout: 30 });
  const server = createServer((_req, res) => {
    const timer = setTimeout(() => res.end(JSON.stringify([{ id: "sim", ok: true }])), 1800);
    res.once("close", () => clearTimeout(timer));
  });
  t.after(async () => {
    setGlobalDispatcher(previousDispatcher);
    if (previousHome === undefined) delete process.env.DEVICE_DECK_HOME;
    else process.env.DEVICE_DECK_HOME = previousHome;
    server.closeAllConnections();
    server.close();
    await shortRequests.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.DEVICE_DECK_HOME = directory;
  await writeFile(path.join(directory, "endpoint.json"), JSON.stringify({ port: address.port, pid: process.pid, token: "fixture" }));
  setGlobalDispatcher(shortRequests);
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}`),
    (error: Error & { cause?: { code?: string } }) => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT");
  assert.deepEqual(await callOperation("devices.cleanup", { ids: ["sim"], action: "uninstall-apps", confirmed: true }),
    [{ id: "sim", ok: true }]);
});
