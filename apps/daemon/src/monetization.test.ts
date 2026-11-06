import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckService } from "./local/service";
import { Adapters } from "../../../packages/adapters/src";
import { validateConfig } from "../../../packages/config/src";

for (const enabled of [undefined, false, true]) {
  test(`config monetization.enabled=${enabled} cannot restrict free access`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "deck-monetization-"));
    const config = validateConfig({ schemaVersion: 1, settings: { folder: directory },
      ...(enabled === undefined ? {} : { monetization: { enabled } }) });
    const file = path.join(directory, "config.json");
    await writeFile(file, JSON.stringify(config));
    class FixtureAdapters extends Adapters {
      async diagnostics() { return []; }
    }
    const deck = new DeckService(directory, file, new FixtureAdapters(() => config));
    try {
      await deck.init();
      const status = deck.licensing.status();
      assert.equal(status.tier, "free");
      assert.equal(status.maxSessions, null);
      assert.match(status.message, /free and open source/);
    } finally {
      await deck.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
