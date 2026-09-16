import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { Adapters, root } from "./index";
import { available } from "./process";
import { validateConfig } from "../../config/src";
import { deviceSchema, type DeviceConfig } from "../../core/src/local/types";

const roku = deviceSchema.parse({
  id: "roku-test",
  name: "Roku",
  platform: "Roku",
  kind: "physical",
  connection: { type: "roku", host: "192.0.2.1", serial: "roku-test" },
});
const android = deviceSchema.parse({
  id: "fire-test",
  name: "Fire TV",
  platform: "Android",
  kind: "physical",
  connection: {
    type: "adb",
    serial: "192.0.2.2:5555",
    port: 5038,
    hardwareId: "fire-hardware",
  },
});

test("Roku wake verifies serial before sending Home for players or PowerOn for TVs", async (t) => {
  let isTv = false;
  let serial = "roku-test";
  let status = 200;
  const calls: { pathname: string; options?: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, options });
      return new Response(
        pathname === "/query/device-info"
          ? `<device-info><serial-number>${serial}</serial-number><is-tv>${isTv}</is-tv></device-info>`
          : "",
        { status: pathname === "/query/device-info" ? 200 : status },
      );
    },
  );
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: "/tmp/deck-test" },
  });
  const adapters = new Adapters(() => config);
  assert.deepEqual(await adapters.wake(roku), { method: "Roku Home button" });
  isTv = true;
  assert.deepEqual(await adapters.wake(roku), { method: "Roku TV power on" });
  assert.deepEqual(
    calls.map((call) => call.pathname),
    [
      "/query/device-info",
      "/keypress/Home",
      "/query/device-info",
      "/keypress/PowerOn",
    ],
  );
  const keypresses = () =>
    calls.filter((call) => call.pathname.startsWith("/keypress/"));
  for (const call of keypresses()) {
    assert.equal(call.options?.method, "POST");
    assert.equal(call.options?.body, "");
    assert.deepEqual(call.options?.headers, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    assert.equal(call.options?.redirect, "error");
  }
  serial = "different-roku";
  await assert.rejects(adapters.wake(roku), /Roku serial changed/);
  assert.equal(keypresses().length, 2);
  serial = "roku-test";
  status = 403;
  await assert.rejects(adapters.wake(roku), /Roku returned 403/);
});

test("ADB wake keeps server and hardware identity checks and never toggles power", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-wake-"));
  try {
    const binary = path.join(dir, "fake-adb");
    const log = path.join(dir, "calls.jsonl");
    const hardware = path.join(dir, "hardware.txt");
    await writeFile(hardware, "fire-hardware\n");
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('ro.serialno')) process.stdout.write(fs.readFileSync(${JSON.stringify(hardware)}));
`,
      { mode: 0o755 },
    );
    const config = validateConfig({
      schemaVersion: 1,
      settings: { folder: dir },
      tools: { adb: binary },
    });
    const adapters = new Adapters(() => config);
    assert.deepEqual(await adapters.wake(android), {
      method: "Android wake key",
    });
    const calls = () =>
      readFile(log, "utf8").then((text) =>
        text.trim().split("\n").map((line) => JSON.parse(line)),
      );
    assert.deepEqual(await calls(), [
      ["-P", "5038", "-s", "192.0.2.2:5555", "shell", "getprop", "ro.serialno"],
      [
        "-P", "5038", "-s", "192.0.2.2:5555",
        "shell", "input", "keyevent", "KEYCODE_WAKEUP",
      ],
    ]);
    await writeFile(hardware, "different-hardware\n");
    await assert.rejects(adapters.wake(android), /different hardware serial/);
    assert.equal((await calls()).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wake resolves the configured emulator identity without launching it", async (t) => {
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: "/tmp/deck-test" },
  });
  const adapters = new Adapters(() => config);
  const emulator: DeviceConfig = {
    ...android,
    kind: "virtual",
    connection: {
      type: "adb",
      serial: "emulator-5554",
      port: 5038,
      avdName: "TestTV",
    },
  };
  const resolve = t.mock.method(adapters.emulators, "resolve", async () => {
    throw new Error("Emulator stopped or still starting");
  });
  const launch = t.mock.method(adapters.emulators, "control", async () => {
    throw new Error("Wake must not launch an emulator");
  });
  await assert.rejects(adapters.wake(emulator), /stopped or still starting/);
  assert.equal(resolve.mock.callCount(), 1);
  assert.equal(launch.mock.callCount(), 0);
});

test("capture and discovery-only Apple devices have no wake transport", async () => {
  const config = validateConfig({
    schemaVersion: 1,
    settings: { folder: "/tmp/deck-test" },
  });
  const adapters = new Adapters(() => config);
  for (const connection of [
    { type: "capture" as const },
    { type: "apple-device" as const, udid: "test-iphone" },
  ]) {
    await assert.rejects(
      adapters.wake({ ...roku, connection }),
      /Wake is not available/,
    );
  }
});

test("Apple TV wake turns on only the paired Companion identifier and closes the connection", async (t) => {
  if (!(await available("python3"))) {
    t.skip("Python is not installed; the optional Apple TV bridge cannot run.");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-apple-wake-"));
  try {
    const moduleDir = path.join(dir, "pyatv");
    const log = path.join(dir, "calls.jsonl");
    await mkdir(path.join(moduleDir, "storage"), { recursive: true });
    await writeFile(path.join(moduleDir, "const.py"), `
class Protocol:
 Companion = 'Companion'
class OperatingSystem:
 TvOS = 'TvOS'
`);
    await writeFile(path.join(moduleDir, "storage", "__init__.py"), "");
    await writeFile(path.join(moduleDir, "storage", "file_storage.py"), `
class FileStorage:
 @classmethod
 def default_storage(cls, loop): return cls()
 async def load(self): pass
`);
    await writeFile(path.join(moduleDir, "__init__.py"), `
import json, os
from types import SimpleNamespace
def record(value):
 with open(os.environ['DECK_WAKE_LOG'], 'a') as output: output.write(json.dumps(value) + '\\n')
async def scan(loop, timeout, hosts, protocol, storage):
 record(['scan', hosts, protocol])
 return [SimpleNamespace(identifier='apple-test', device_info=SimpleNamespace(operating_system='TvOS'), get_service=lambda protocol: SimpleNamespace(credentials=os.environ.get('DECK_WAKE_PAIRED')))]
class Power:
 async def turn_on(self): record(['turn_on'])
def close():
 record(['close'])
 return []
async def connect(config, loop, protocol, storage):
 record(['connect', config.identifier, protocol])
 return SimpleNamespace(power=Power(), close=close)
`);
    const execute = promisify(execFile);
    const invoke = (identifier = "apple-test", paired = "credentials") =>
      execute(
        "python3",
        [path.join(root, "native/apple-tv.py"), "wake", "192.0.2.3", identifier],
        {
          env: {
            ...process.env,
            PYTHONPATH: dir,
            DECK_WAKE_LOG: log,
            DECK_WAKE_PAIRED: paired,
          },
        },
      );
    const calls = () =>
      readFile(log, "utf8").then((text) =>
        text.trim().split("\n").map((line) => JSON.parse(line)),
      );
    assert.deepEqual(JSON.parse((await invoke()).stdout), { ok: true });
    assert.deepEqual(await calls(), [
      ["scan", ["192.0.2.3"], "Companion"],
      ["connect", "apple-test", "Companion"],
      ["turn_on"],
      ["close"],
    ]);
    await writeFile(log, "");
    await assert.rejects(invoke("wrong-identifier"), /configured identity/);
    await assert.rejects(invoke("apple-test", ""), /Pair Companion/);
    assert.deepEqual(await calls(), [
      ["scan", ["192.0.2.3"], "Companion"],
      ["scan", ["192.0.2.3"], "Companion"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
