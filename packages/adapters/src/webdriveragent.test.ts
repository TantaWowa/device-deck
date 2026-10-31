import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWda, startWdaInteractive, wdaActions, wdaScreen, wdaScreenshot, type WdaConnection } from "./webdriveragent";
import { Adapters } from "./index";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import type { run } from "./process";

const udid = "00008110-0012345678901234";
const portrait = { screenSize: { width: 390, height: 844 }, scale: 3 };
const tap = { type: "tap" as const, x: 195, y: 422, width: 390, height: 844 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZr8AAAAASUVORK5CYII=", "base64");

test("physical iOS gestures map scaled video to full-screen points and reject stale rotation and invalid endpoints", () => {
  const scaled = wdaActions({ ...tap, width: 585, height: 1266, x: 292.5, y: 633 }, portrait);
  assert.deepEqual(scaled.actions[0].actions, [
    { type: "pointerMove", duration: 0, origin: "viewport", x: 195, y: 422 },
    { type: "pointerDown", button: 0 }, { type: "pause", duration: 50 }, { type: "pointerUp", button: 0 },
  ]);
  const landscape = { ...portrait, screenSize: { width: 844, height: 390 } };
  const swipe = wdaActions({ ...tap, type: "swipe", width: 1266, height: 585, x: 633, y: 292.5, toX: 0, toY: 0, durationMs: 350 }, landscape);
  assert.deepEqual(swipe.actions[0].actions[2], { type: "pointerMove", duration: 350, origin: "viewport", x: 0, y: 0 });
  assert.deepEqual(wdaActions({ ...tap, type: "longPress", durationMs: 900 }, portrait).actions[0].actions[2], { type: "pause", duration: 900 });
  assert.throws(() => wdaActions(tap, landscape), /orientation changed/);
  assert.throws(() => wdaActions({ ...tap, x: 390 }, portrait), /outside/);
  assert.throws(() => wdaActions({ ...tap, type: "swipe", toX: 390, toY: 0, durationMs: 350 }, portrait), /outside/);
});

function protocol() {
  const calls: { method: string; route: string; body?: unknown }[] = [];
  let existing: string | null = null, closed = 0, screen = portrait;
  let actions: (() => Promise<void>) | undefined, geometry: (() => Promise<void>) | undefined;
  const connection: WdaConnection = {
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (route === "/status") return { sessionId: existing, value: { ready: true } };
      if (route === "/wda/screen") { await geometry?.(); return { value: screen }; }
      if (route === "/session") { existing = "owned"; return { value: { sessionId: existing } }; }
      if (route === "/screenshot") return { value: png.toString("base64") };
      assert.equal(route, method === "DELETE" ? "/session/owned" : "/session/owned/actions");
      if (method === "DELETE") existing = null;
      else await actions?.();
      return { value: null };
    },
    onClose: () => () => {}, close: async () => { closed++; },
  };
  return { connection, calls, closed: () => closed, existing: (value: string) => { existing = value; },
    rotate: () => { screen = { ...portrait, screenSize: { width: 844, height: 390 } }; },
    delayActions: (value: () => Promise<void>) => { actions = value; },
    delayGeometry: (value: () => Promise<void>) => { geometry = value; },
  };
}

test("view-only WDA screen reads never create or delete automation sessions", async () => {
  const f = protocol(); f.existing("another-tool");
  assert.deepEqual(await wdaScreen(f.connection), portrait);
  assert.deepEqual(await wdaScreenshot(f.connection), png);
  assert(f.calls.every((call) => call.method === "GET"));
});

test("physical iOS refuses an existing WDA session and never deletes another tool's session", async () => {
  const f = protocol(); f.existing("another-tool");
  await assert.rejects(startWdaInteractive(f.connection), /already has an active automation session/);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
  assert.equal(f.closed(), 1);
});

test("closing physical iOS input waits for its final up and deletes only the owned session once", async () => {
  const f = protocol();
  const source = await startWdaInteractive(f.connection);
  assert.deepEqual(source.capabilities, ["tap", "swipe", "longPress"]);
  assert.deepEqual([source.width, source.height], [1170, 2532]);
  await assert.rejects(source.pointer({ ...tap, type: "down", contactId: 1 }), /continuous pointer/);
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.delayActions(() => { entered(); return new Promise((resolve) => { finish = resolve; }); });
  const gesture = source.gesture({ ...tap, type: "longPress", durationMs: 500 });
  await started;
  await assert.rejects(source.gesture(tap), /already running/);
  const closing = source.close();
  assert(!f.calls.some((call) => call.method === "DELETE"));
  assert.equal(f.closed(), 0);
  finish(); await gesture; await Promise.all([closing, source.close()]);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(f.closed(), 1);
  await assert.rejects(source.gesture(tap), /closed/);
});

test("closing while physical iOS geometry is pending drops the undispatched gesture", async () => {
  const f = protocol(), source = await startWdaInteractive(f.connection);
  let finish!: () => void;
  f.delayGeometry(() => new Promise<void>((resolve) => { finish = resolve; }));
  const gesture = source.gesture(tap);
  const closing = source.close(); finish(); await gesture; await closing;
  assert(!f.calls.some((call) => call.route.endsWith("/actions")));
});

test("release retries reconnect only for owned-session cleanup and preserve replacement automation sessions", async () => {
  const f = protocol(); let failed = false, reconnected = 0;
  const connection: WdaConnection = { ...f.connection, request: async (method, route, body) => {
    if (method === "DELETE" && !failed) { failed = true; throw new Error("Phone disconnected during cleanup"); }
    return f.connection.request(method, route, body);
  } };
  const source = await startWdaInteractive(connection, async () => { reconnected++; return f.connection; });
  await assert.rejects(source.close(), /disconnected during cleanup/);
  assert.equal(f.closed(), 1, "Failed cleanup must still stop the owned forward");
  f.existing("replacement-session");
  await source.close();
  assert.equal(reconnected, 1);
  assert.equal(f.closed(), 2);
  assert(!f.calls.some((call) => call.method === "DELETE"), "A replacement session is never deleted");
  await assert.rejects(source.gesture(tap), /closed/);
});

test("rotation rejects a physical iOS gesture before input; malformed screen and images fail explicitly", async () => {
  const f = protocol(), source = await startWdaInteractive(f.connection);
  f.rotate();
  await assert.rejects(source.gesture(tap), /orientation changed/);
  assert(!f.calls.some((call) => call.route.endsWith("/actions")));
  await source.close();
  const invalid: WdaConnection = { ...f.connection, request: async () => ({ value: {} }) };
  await assert.rejects(wdaScreen(invalid), /full screenSize and scale/);
  await assert.rejects(wdaScreenshot(invalid), /no screenshot/);
  await assert.rejects(wdaScreenshot({ ...invalid, request: async () => ({ value: "not-an-image" }) }), /PNG or JPEG/);
});

test("owned iproxy pins USB UDID and port, carries real WDA HTTP, reports errors without replay and exits on close", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-wda-"));
  const argvFile = path.join(dir, "argv.json"), executable = path.join(dir, "iproxy.mjs");
  let session: string | null = null, requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the request before replying. */ }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/status") response.end(JSON.stringify({ sessionId: session, value: { ready: true, device: "iphone", os: { name: "iOS" } } }));
    else if (request.url === "/wda/screen") response.end(JSON.stringify({ value: portrait }));
    else if (request.url === "/screenshot") response.end(JSON.stringify({ value: png.toString("base64") }));
    else if (request.url === "/session") { session = "fixture"; response.end(JSON.stringify({ value: { sessionId: session } })); }
    else if (request.url === "/session/fixture") { session = null; response.end('{"value":null}'); }
    else { requests++; response.statusCode = 500; response.end('{"value":{"error":"unknown error","message":"device rejected gesture"}}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  // A TCP relay exercises the actual child lifecycle and bounded HTTP client.
  // This fixture never enumerates or sends input to a real USB device.
  await writeFile(executable, `#!${process.execPath}\nimport net from 'node:net';\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ args, pid: process.pid }));\nconst [local, remote] = args.at(-1).split(':').map(Number);\nconst sockets = new Set();\nconst server = net.createServer(socket => {\n  const upstream = net.connect(remote, '127.0.0.1');\n  for (const s of [socket, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => { socket.destroy(); upstream.destroy(); }); }\n  socket.pipe(upstream).pipe(socket);\n});\nserver.listen(local, args[args.indexOf('--source') + 1]);\nprocess.on('SIGINT', () => { for (const s of sockets) s.destroy(); server.close(() => process.exit(0)); });\n`);
  await chmod(executable, 0o700);
  let connection: WdaConnection | undefined;
  try {
    connection = await openWda(udid, address.port, executable);
    const launched = JSON.parse(await readFile(argvFile, "utf8"));
    assert.deepEqual(launched.args.slice(0, 5), ["--udid", udid, "--local", "--source", "127.0.0.1"]);
    assert.equal(launched.args.at(-1).split(":")[1], String(address.port));
    assert.deepEqual(await wdaScreenshot(connection), png);
    const source = await startWdaInteractive(connection);
    await assert.rejects(source.gesture(tap), /device rejected gesture/);
    assert.equal(requests, 1, "A failed input must never be retried");
    await source.close();
    assert.equal(session, null);
    assert.throws(() => process.kill(launched.pid, 0), /ESRCH/);
    await assert.rejects(connection.request("GET", "/status"), /closed/);
    await assert.rejects(openWda("core-device-uuid", 8100, executable), /hardware UDID/);
    await assert.rejects(openWda(udid, 8100, path.join(dir, "missing")), /needs iproxy/);
  } finally {
    await connection?.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("Xcode identity must resolve to one physical iOS hardware UDID before any USB helper is launched", async () => {
  const device = deviceSchema.parse({ id: "phone", name: "Phone", platform: "Apple", kind: "physical", connection: { type: "apple-device", udid: "core-id", webDriverAgent: {} } });
  let rows: unknown[] = [];
  const execute: typeof run = async (_command, args) => {
    await writeFile(args[args.indexOf("--json-output") + 1], JSON.stringify({ result: { devices: rows } }));
    return { stdout: Buffer.alloc(0), stderr: "" };
  };
  const adapters = new Adapters(() => configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" } }), execute);
  try {
    for (const hardware of [undefined, { reality: "simulated", platform: "iOS", udid }, { reality: "physical", platform: "tvOS", udid }, { reality: "physical", platform: "iOS" }]) {
      rows = [{ identifier: "core-id", hardwareProperties: hardware }];
      await assert.rejects(adapters.startAppleScreen(device), /exact physical iPhone or iPad/);
    }
    rows = [{ identifier: "some-other-device", hardwareProperties: { reality: "physical", platform: "iOS", udid } }];
    await assert.rejects(adapters.startAppleScreen(device), /exact physical iPhone or iPad/);
  } finally { await adapters.close(); }
});
