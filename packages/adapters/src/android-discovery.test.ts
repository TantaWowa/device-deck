import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Adapters } from "./index";
import { configSchema } from "../../core/src/local/types";
import type { run } from "./process";

test("Android discovery uses the account's server for new AVDs and retains explicitly configured ports", async (t) => {
  const previous = process.env.ANDROID_ADB_SERVER_PORT;
  t.after(() => {
    if (previous === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
    else process.env.ANDROID_ADB_SERVER_PORT = previous;
  });
  for (const value of [undefined, "5038", "invalid", "0", "65536"]) {
    await t.test(value ?? "default", async () => {
      if (value === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
      else process.env.ANDROID_ADB_SERVER_PORT = value;
      const calls: string[][] = [];
      const config = configSchema.parse({
        schemaVersion: 1,
        settings: { folder: "/tmp/captures" },
        tools: { adb: "/usr/bin/true", emulator: "/usr/bin/true", python: "/usr/bin/true" },
        devices: [{ id: "configured-avd", name: "Configured AVD", platform: "Android", kind: "virtual",
          connection: { type: "adb", avdName: "configured_avd", serial: "avd-configured", port: 5040 } }],
      });
      const execute: typeof run = async (_command, args) => {
        let output = "[]";
        if (args[0] === "-P") {
          calls.push(args);
          output = "List of devices attached\n";
        } else if (args[0] === "-list-avds") output = "new_account_avd\nconfigured_avd\n";
        else if (args[0] === "simctl") output = '{"devices":{}}';
        else if (args[0] === "devicectl") {
          await writeFile(args[args.indexOf("--json-output") + 1], '{"result":{"devices":[]}}');
          output = "";
        }
        return { stdout: Buffer.from(output), stderr: "" };
      };
      const adapters = new Adapters(() => config, execute);
      Object.defineProperty(adapters, "scanRoku", { value: async () => [] });
      try {
        const discovered = await adapters.discover();
        if (value !== undefined && value !== "5038") {
          assert.equal(calls.length, 0);
          assert(discovered.diagnostics.some((message) => message.includes("ANDROID_ADB_SERVER_PORT")));
          assert.equal(discovered.devices.filter((device) => device.platform === "Android").length, 0);
        } else {
          const expected = value ?? "5037";
          assert.deepEqual([...new Set(calls.map((args) => args[1]))], [expected, "5040"]);
          const connections = discovered.devices.map((device) => device.connection).filter((connection) => connection.type === "adb");
          assert.equal(connections.find((connection) => connection.avdName === "new_account_avd")?.port, Number(expected));
          assert.equal(connections.find((connection) => connection.avdName === "configured_avd")?.port, 5040);
          assert.deepEqual(discovered.diagnostics, []);
        }
      } finally { await adapters.close(); }
    });
  }
});

test("forced discovery sees an AVD created immediately after discovery while concurrent reads share work", async () => {
  let avds = "";
  let listings = 0;
  const config = configSchema.parse({ schemaVersion: 1, settings: { folder: "/tmp/captures" },
    tools: { adb: "/usr/bin/true", emulator: "/usr/bin/true", python: "/usr/bin/true" } });
  const execute: typeof run = async (_command, args) => {
    let output = "[]";
    if (args[0] === "-P") output = "List of devices attached\n";
    else if (args[0] === "-list-avds") { listings++; output = avds; }
    else if (args[0] === "simctl") output = '{"devices":{}}';
    else if (args[0] === "devicectl") {
      await writeFile(args[args.indexOf("--json-output") + 1], '{"result":{"devices":[]}}');
      output = "";
    }
    return { stdout: Buffer.from(output), stderr: "" };
  };
  const adapters = new Adapters(() => config, execute, () => 1000);
  Object.defineProperty(adapters, "scanRoku", { value: async () => [] });
  try {
    assert.equal((await adapters.discover()).devices.length, 0);
    avds = "new_ci_avd\n";
    assert.equal((await adapters.discover()).devices.length, 0);
    const results = await Promise.all([adapters.discover(true), adapters.discover(true)]);
    assert.equal(listings, 2);
    for (const result of results) {
      assert.deepEqual(result.diagnostics, []);
      assert(result.devices.some((device) => device.connection.type === "adb" && device.connection.avdName === "new_ci_avd"));
    }
  } finally { await adapters.close(); }
});
