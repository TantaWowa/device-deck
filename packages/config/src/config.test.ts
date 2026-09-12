import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore, validateConfig } from "./index";
test("two concurrent saves with one revision have exactly one winner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-config-"));
  const store = new ConfigStore(path.join(dir, "config.json"));
  await store.load();
  try {
    const revision = store.revision;
    const a = structuredClone(store.config),
      b = structuredClone(store.config);
    a.settings.owner = "A";
    b.settings.owner = "B";
    const result = await Promise.allSettled([
      store.save(a, revision),
      store.save(b, revision),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(result.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      JSON.parse(await readFile(store.file, "utf8")).settings.owner,
      store.config.settings.owner,
    );
    await writeFile(store.file, "broken");
    assert.equal(await store.refresh(), false);
    assert.ok(store.error);
    assert.equal(store.config.settings.owner, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("duplicate USB identities and physical devices across hosts or ADB ports are rejected", () => {
  const c = validateConfig({
    schemaVersion: 1,
    settings: { folder: "./captures" },
  });
  assert.throws(
    () =>
      validateConfig({
        ...c,
        sources: [
          { id: "one", name: "One", kind: "usb", uniqueId: "physical" },
          { id: "two", name: "Two", kind: "usb", uniqueId: "physical" },
        ],
      }),
    /cannot be registered twice/,
  );
  const d = {
    id: "a",
    name: "A",
    platform: "Android",
    kind: "physical",
    connection: { type: "adb", serial: "serial", port: 5037 },
  };
  assert.throws(
    () =>
      validateConfig({
        ...c,
        devices: [
          d,
          {
            ...d,
            id: "b",
            name: "B",
            connection: { ...d.connection, port: 5038 },
          },
        ],
      }),
    /hardware identity/,
  );
});
