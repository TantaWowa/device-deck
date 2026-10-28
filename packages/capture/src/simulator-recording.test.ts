import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Adapters } from "../../adapters/src";
import { configSchema, deviceSchema } from "../../core/src/local/types";
import { CaptureEngine } from "./index";

for (const platform of ["ios", "tvos"] as const) {
  for (const outcome of ["success", "startup-failure", "destination-exists"] as const) {
    test(`${platform} recording finalizes safely with ${outcome}`, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "deck-recording-test-"));
      const destination = path.join(directory, "captures", "video.mp4");
      const invocation = path.join(directory, "invocation.json");
      const executable = path.join(directory, "xcrun");
      const previousPath = process.env.PATH;
      const config = configSchema.parse({ schemaVersion: 1, settings: { folder: directory } });
      const device = deviceSchema.parse({
        id: "sim", name: "Simulator", platform: "Apple", kind: "virtual",
        connection: { type: "simulator", os: platform, udid: "0371776A-0FC2-4DD1-8831-8941C7D1088A" },
      });
      const adapters = new Adapters(() => config);
      const engine = new CaptureEngine(adapters);
      t.mock.method(adapters, "verifyIdentity", async () => device);
      t.mock.method(engine, "probe", async (file: string) => {
        assert.equal(await readFile(file, "utf8"), "finalized video");
        return { duration: 60, bytes: (await stat(file)).size };
      });
      await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), file = args.at(-1);
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({args,pid:process.pid}));
if (file === ${JSON.stringify(destination)}) { process.stderr.write("Permission denied for capture destination"); process.exit(1); }
if (${JSON.stringify(outcome)} === "startup-failure") { process.stderr.write("Recorder startup failed"); process.exit(1); }
process.on("SIGINT", () => { fs.writeFileSync(file, "finalized video"); process.exit(0); });
process.stderr.write("Recording started\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
      process.env.PATH = directory + path.delimiter + previousPath;
      try {
        let worker: { localPath?: string; pid?: number } | undefined;
        const pending = engine.startRecording("fixture", device, { id: "native", name: "Native", kind: "native" }, destination, 1, (value) => { worker = value; });
        if (outcome === "startup-failure") {
          await assert.rejects(pending, /Recorder startup failed/);
          await assert.rejects(access(destination));
        } else {
          const recording = await pending;
          assert.equal(recording.path, destination);
          assert.equal(recording.localPath, worker?.localPath);
          assert.notEqual(recording.localPath, destination);
          await assert.rejects(access(destination));
          if (outcome === "destination-exists") {
            await writeFile(destination, "existing capture");
            await assert.rejects(recording.stop(), /EEXIST/);
            assert.equal(await readFile(destination, "utf8"), "existing capture");
          } else {
            const first = recording.stop();
            assert.equal(recording.stop(), first);
            assert.deepEqual(await first, { duration: 60, bytes: 15, interruption: undefined });
          }
        }
        const { args, pid } = JSON.parse(await readFile(invocation, "utf8"));
        assert.deepEqual(args.slice(0, 5), ["simctl", "io", device.connection.type === "simulator" ? device.connection.udid : "", "recordVideo", "--codec=h264"]);
        assert.equal(args.includes("--display=external"), platform === "tvos");
        assert.equal(worker?.localPath, args.at(-1));
        assert.equal(worker?.pid, pid);
        await assert.rejects(access(path.dirname(args.at(-1))));
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await engine.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
