import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckService } from "./local/service";
import { Store } from "./local/store";
import { Adapters } from "../../../packages/adapters/src";
import { ready, start, stop } from "../../../packages/adapters/src/process";
import { configSchema, deviceSchema } from "../../../packages/core/src/local/types";
import { licensedManager } from "../../../tests/licensing";

for (const existing of [false, true]) {
  test(`restart stops the temporary simulator recorder and preserves ${existing ? "existing" : "recovered"} capture`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "deck-recovery-test-"));
    const temporary = await mkdtemp(path.join(os.tmpdir(), "device-deck-recording-"));
    const localPath = path.join(temporary, "recording.mp4");
    const destination = path.join(directory, "captures", "video.mp4");
    await mkdir(path.dirname(destination));
    if (existing) await writeFile(destination, "existing capture");
    const recorder = start(process.execPath, ["-e", `
const fs = require("node:fs"), file = process.argv[1];
process.on("SIGINT", () => { fs.writeFileSync(file, "recovered video"); process.exit(0); });
process.stderr.write("Recording started\\n");
setInterval(() => {}, 1000);
`, localPath]);
    const config = configSchema.parse({ schemaVersion: 1, settings: { folder: directory } });
    const adapters = new Adapters(() => config);
    t.mock.method(adapters, "diagnostics", async () => []);
    const license = await licensedManager(directory);
    const deck = new DeckService(directory, undefined, adapters, undefined, license.manager);
    try {
      await ready(recorder, /Recording started/);
      const store = new Store(path.join(directory, "state.sqlite"));
      store.worker("recording", {
        pid: recorder.child.pid, localPath, path: destination,
        device: deviceSchema.parse({
          id: "sim", name: "Simulator", platform: "Apple", kind: "virtual",
          connection: { type: "simulator", os: "ios", udid: "0371776A-0FC2-4DD1-8831-8941C7D1088A" },
        }),
      });
      store.close();
      await deck.init();
      assert.equal(recorder.exited(), true);
      assert.equal(await readFile(destination, "utf8"), existing ? "existing capture" : "recovered video");
      assert.deepEqual(deck.store.workers(), []);
      await assert.rejects(access(temporary));
    } finally {
      await stop(recorder);
      await deck.close();
      await rm(temporary, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
