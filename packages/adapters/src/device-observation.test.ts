import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observationAdapter, androidUi, normalizeUi, boundedLogs, type ObservationHost } from "./device-observation";
import { Adapters } from "./index";
import { deviceLogsSchema, uiReadSchema } from "../../core/src/device-interaction";
import { deviceSchema } from "../../core/src/local/types";
import type { run } from "./process";

const device = deviceSchema.parse({ id: "phone", name: "Phone", kind: "virtual", platform: "Apple", connection: { type: "simulator", os: "ios", udid: "00000000-0000-4000-8000-000000000001" } });
const host = (execute: typeof run): ObservationHost => ({ execute, tool: (name) => `/fixture/${name}`, adb: () => ["-P", "5038", "-t", "72"], verify: async () => {}, wda: async () => { throw new Error("Unexpected physical device access"); } });
const result = (value: unknown) => ({ stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), stderr: "" });

test("UI snapshots normalize values, unknown booleans, selectors, bounds, limits and secure fields", () => {
  const tree = [{ AXUniqueId: "root", AXRole: "View", children: [
    { AXUniqueId: "name", AXLabel: "Name", AXValue: "George", frame: { x: 10, y: 20, width: 100, height: 30 } },
    { type: "XCUIElementTypeSecureTextField", label: "Secret", value: "never-return-this" },
  ] }];
  const all = normalizeUi(tree, uiReadSchema.parse({}), "points");
  assert.equal(all.nodes[1].value, "George"); assert.equal(all.nodes[1].enabled, null);
  assert.deepEqual(all.nodes[1].bounds, { x: 10, y: 20, width: 100, height: 30 });
  assert(!JSON.stringify(all).includes("never-return-this"));
  assert.equal(normalizeUi(tree, uiReadSchema.parse({ maxNodes: 1 }), "points").truncated, true);
  const filtered = normalizeUi(tree, uiReadSchema.parse({ selector: { id: "name" } }), "points");
  assert.equal(filtered.nodes.length, 1); assert.equal(filtered.nodes[0].value, "George");
  const xml = '<?xml version="1.0"?><hierarchy><node class="EditText" resource-id="name" text="A &amp; B" enabled="true" bounds="[10,20][110,50]"><node text="hidden secret" password="true" /></node></hierarchy>';
  const android = normalizeUi(androidUi(xml), uiReadSchema.parse({}), "pixels");
  assert.equal(android.nodes[0].value, "A & B"); assert.equal(android.nodes[0].enabled, true);
  assert(!JSON.stringify(android).includes("hidden secret"));
  assert.throws(() => androidUi('<!DOCTYPE x><hierarchy></hierarchy>'), /document type/);
  assert.throws(() => androidUi('<hierarchy><node />'), /incomplete/);
});

test("logs enforce finite intervals, byte and line budgets and remove common credential fields", () => {
  assert.throws(() => deviceLogsSchema.parse({ since: "2020-01-01T00:00:00Z", until: "2020-01-01T01:00:00Z" }));
  assert.throws(() => deviceLogsSchema.parse({ process: "bad' OR true" }));
  assert.throws(() => deviceLogsSchema.parse({ maxBytes: 1000000 }));
  const logs = boundedLogs('Authorization: Bearer secret\npassword="secret"\nok\nextra', deviceLogsSchema.parse({ maxLines: 3 }));
  assert.equal(logs.truncated, true); assert(!logs.text.includes("secret")); assert(logs.text.includes("ok"));
  const json = boundedLogs('{"password":"json-secret","access_token":"escaped-\\\"secret","ok":true}', deviceLogsSchema.parse({}));
  assert(!json.text.includes("secret")); assert(json.text.includes('"ok":true'));
  const unicode = boundedLogs("abc" + "界".repeat(100), deviceLogsSchema.parse({ maxBytes: 256 }));
  assert(unicode.truncated); assert(Buffer.byteLength(unicode.text) <= 256); assert(!unicode.text.includes("\uFFFD"));
  for (const raw of ['{"password":"prefix,credential-tail', '{"password":"prefix,credential-tail\\', "password='prefix,credential-tail", 'password="first-line\ncredential-tail"', '{"password":"prefix,credential-tail\r']) {
    assert(!boundedLogs(raw, deviceLogsSchema.parse({})).text.includes("credential-tail"));
  }
});

test("simulator UI and app operations use exact UDID and the idb backend without desktop access", async () => {
  const calls: string[][] = [];
  const adapter = observationAdapter(device, host(async (_command, args) => {
    calls.push(args);
    if (args[0] === "ui") return result([{ AXUniqueId: "play", AXLabel: "Pause", AXValue: "42" }]);
    if (args[0] === "list-apps") return result('{"bundle_id":"org.hope.app","process_state":"Running"}\n{"bundle_id":"other.app"}\n');
    return result("launched");
  }));
  assert.equal(adapter.capabilities.backend, "idb");
  assert.equal((await adapter.ui(uiReadSchema.parse({}))).nodes[0].value, "42");
  const state = await adapter.appState("org.hope.app"); assert.equal(state.installed, true);
  await adapter.launch("org.hope.app", ["--fixture"]);
  assert(calls.every((args) => args[args.indexOf("--udid") + 1] === "00000000-0000-4000-8000-000000000001"));
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ["launch", "--foreground-if-running"]);
});

test("Android preserves frozen ADB selectors, supports TV launch categories and rejects launch errors", async () => {
  const android = deviceSchema.parse({ ...device, platform: "Android", connection: { type: "adb", serial: "emulator-5554", avdName: "Phone", port: 5038 } });
  const calls: string[][] = []; let fail = false;
  const adapter = observationAdapter(android, host(async (_command, args) => {
    calls.push(args);
    if (args.includes("uiautomator")) return result('<hierarchy><node resource-id="play" text="Pause" /></hierarchy>');
    if (args.includes("dumpsys")) return result("mResumedActivity: ActivityRecord{abc u0 org.hope.app/.Main t1}");
    if (args.includes("resolve-activity")) return result(args.includes("android.intent.category.LEANBACK_LAUNCHER") ? "org.hope.app/.Tv$Activity" : "No activity found");
    return { ...result("Status: ok"), stderr: fail ? "Error type 3: Activity class does not exist" : "" };
  }));
  assert.equal(adapter.capabilities.backend, "adb-scrcpy");
  assert.equal((await adapter.ui(uiReadSchema.parse({}))).nodes[0].label, "Pause");
  assert.equal((await adapter.appState("org.hope.app")).foreground, true);
  await adapter.launch("org.hope.app", []);
  assert(calls.every((args) => args.slice(0, 4).join(" ") === "-P 5038 -t 72"));
  assert(calls.some((args) => args.includes("'org.hope.app/.Tv$Activity'")));
  fail = true; await assert.rejects(adapter.launch("org.hope.app", []), /could not launch/);
});

test("physical WDA readback never opens an automation session and closes each owned forward", async () => {
  const phone = deviceSchema.parse({ ...device, kind: "physical", connection: { type: "apple-device", udid: "physical", webDriverAgent: {} } });
  const routes: string[] = []; let closed = 0;
  const context = host(async () => result(""));
  context.wda = async () => ({ request: async (method, route) => {
    assert.equal(method, "GET"); routes.push(route);
    return { value: route.startsWith("/source") ? { type: "Button", rawIdentifier: "play", name: "Pause", label: "Pause", isEnabled: "1", isFocused: "0", frame: "{{10, 20}, {100, 30}}", rect: { x: 10, y: 20, width: 100, height: 30 } } : { bundleId: "org.hope.app", pid: 42 } };
  }, onClose: () => () => {}, close: async () => { closed++; } });
  const adapter = observationAdapter(phone, context);
  const node = (await adapter.ui(uiReadSchema.parse({}))).nodes[0];
  assert.equal(node.id, "play"); assert.equal(node.enabled, true); assert.equal(node.focused, false);
  assert.deepEqual(node.bounds, { x: 10, y: 20, width: 100, height: 30 });
  assert.equal((await adapter.appState("org.hope.app")).foreground, true);
  assert.equal(closed, 2); assert(!routes.includes("/session"));
  await assert.rejects(adapter.logs(deviceLogsSchema.parse({})), /does not support/);
});

test("physical app launch targets only its owned WDA session and preserves replacement sessions", async () => {
  const phone = deviceSchema.parse({ ...device, kind: "physical", connection: { type: "apple-device", udid: "physical", webDriverAgent: {} } });
  const context = host(async () => result(""));
  const calls: string[] = []; let active: string | null = null, closed = 0;
  context.wda = async () => ({ request: async (method, route, body) => {
    calls.push(`${method} ${route}`);
    if (route === "/status") return { sessionId: active, value: {} };
    if (route === "/wda/screen") return { value: { screenSize: { width: 390, height: 844 }, scale: 3 } };
    if (route === "/session") { active = "replacement"; return { value: { sessionId: "owned" } }; }
    assert.equal(route, "/session/owned/wda/apps/launch");
    assert.deepEqual(body, { bundleId: "org.hope.app", arguments: [], shouldWaitForQuiescence: false });
    return { value: null };
  }, onClose: () => () => {}, close: async () => { closed++; } });
  await observationAdapter(phone, context).launch("org.hope.app", []);
  assert.equal(closed, 1);
  assert(!calls.some((call) => call.startsWith("DELETE")));
  await assert.rejects(observationAdapter(phone, context).launch("org.hope.app", []), /already has an active/);
});

test("failed launch cleanup survives until its owned WDA session can reconnect and close", async () => {
  const phone = deviceSchema.parse({ ...device, kind: "physical", connection: { type: "apple-device", udid: "physical", webDriverAgent: {} } });
  const context = host(async () => result(""));
  let active: string | null = null, disconnected = false, connections = 0, deleted = 0, closed = 0;
  let owned: string | undefined;
  context.ownership = { opened: (id) => { owned = id; }, closed: () => { owned = undefined; } };
  context.wda = async () => { connections++; return { request: async (method, route) => {
    if (route === "/status") {
      if (active && !disconnected) { disconnected = true; throw new Error("USB disconnected during cleanup"); }
      return { sessionId: active, value: {} };
    }
    if (route === "/wda/screen") return { value: { screenSize: { width: 390, height: 844 }, scale: 3 } };
    if (route === "/session") { active = "owned"; return { value: { sessionId: active } }; }
    if (method === "DELETE") { assert.equal(route, "/session/owned"); active = null; deleted++; }
    if (route.endsWith("/wda/apps/launch")) assert.equal(owned, "owned", "Ownership is recorded before launch dispatch");
    return { value: null };
  }, onClose: () => () => {}, close: async () => { closed++; } }; };
  const adapter = observationAdapter(phone, context);
  await assert.rejects(adapter.launch("org.hope.app", []), /USB disconnected/);
  assert.equal(active, "owned");
  assert.equal(owned, "owned");
  await adapter.close(); await adapter.close();
  assert.equal(active, null); assert.equal(connections, 2); assert.equal(deleted, 1); assert.equal(closed, 2);
  assert.equal(owned, undefined);
});

test("recovered WDA cleanup checks the exact owned session and preserves another tool's replacement", async () => {
  const phone = deviceSchema.parse({ ...device, kind: "physical", connection: { type: "apple-device", udid: "physical", webDriverAgent: {} } });
  let active = "owned", closed = 0;
  const requests: string[] = [];
  class CleanupAdapters extends Adapters {
    async startAppleScreen(device: typeof phone) {
      assert.deepEqual(device, phone);
      return { request: async (method: string, route: string) => {
        requests.push(`${method} ${route}`); return { sessionId: active, value: null };
      }, onClose: () => () => {}, close: async () => { closed++; } };
    }
  }
  const adapters = new CleanupAdapters(() => { throw new Error("Unexpected configuration access"); });
  try {
    await adapters.closeOwnedWda(phone, "owned");
    active = "replacement";
    await adapters.closeOwnedWda(phone, "owned");
    assert.deepEqual(requests, ["GET /status", "DELETE /session/owned", "GET /status"]);
    assert.equal(closed, 2);
  } finally { await adapters.close(); }
});

test("Roku app queries and launch preserve exact target verification and unsupported transports are explicit", async (t) => {
  const roku = deviceSchema.parse({ ...device, platform: "Roku", kind: "physical", connection: { type: "roku", host: "192.0.2.1", serial: "expected" } });
  const server = http.createServer((request, response) => { response.end(request.url === "/query/active-app" ? '<active-app><app id="42">Hope &amp; Stream</app></active-app>' : ""); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const original = globalThis.fetch; const requested: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string, options?: RequestInit) => { requested.push(url); return original(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options); });
  const context = host(async () => result("")); let verified = 0;
  context.verify = async () => { verified++; };
  try {
    const adapter = observationAdapter(roku, context);
    assert.equal((await adapter.appState()).foregroundAppId, "42");
    await adapter.launch("42", []); assert.equal(verified, 2);
    assert(requested.every((url) => url.startsWith("http://192.0.2.1:8060/")));
    await assert.rejects(adapter.logs(deviceLogsSchema.parse({ since: new Date(Date.now() - 1000).toISOString() })), /historical/);
    const capture = observationAdapter(deviceSchema.parse({ ...device, connection: { type: "capture" } }), context);
    assert.equal(capture.capabilities.ui, false); await assert.rejects(capture.ui(uiReadSchema.parse({})), /does not support/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("bounded log collector terminates its owned process at the byte limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-log-fixture-"));
  const executable = path.join(directory, "adb");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(500000));setInterval(()=>{},1000);\n`);
  await chmod(executable, 0o700);
  const android = deviceSchema.parse({ ...device, platform: "Android", connection: { type: "adb", serial: "fixture" } });
  const context = host(async () => result(String(Math.floor(Date.now() / 1000))));
  context.tool = () => executable;
  try {
    const logs = await observationAdapter(android, context).logs(deviceLogsSchema.parse({ maxBytes: 256 }));
    assert.equal(logs.truncated, true); assert(Buffer.byteLength(logs.text) <= 256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
