import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { available, run } from "./process";

test("commands with empty stderr still report a useful failure or timeout", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"]), /Command failed/);
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 100), /Timed out/);
});

test("tool availability follows executable files and symlinks without retaining stale installation state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-helper-"));
  const helper = path.join(directory, "helper"), link = path.join(directory, "link");
  try {
    assert.equal(await available(helper), false);
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(helper, link);
    assert.equal(await available(helper), true);
    assert.equal(await available(link), true);
    assert.equal(await available(directory), false, "an executable directory is not a tool");
    await chmod(helper, 0o600);
    assert.equal(await available(helper), false);
    assert.equal(await available(link), false);
    await chmod(helper, 0o700);
    assert.equal(await available(helper), true);
    await rm(helper);
    assert.equal(await available(link), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("PATH lookup respects later executable entries and changes immediately with configured paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-path-"));
  const original = process.env.PATH;
  try {
    const first = path.join(directory, "first"), second = path.join(directory, "second");
    await mkdir(first); await mkdir(second);
    await writeFile(path.join(first, "helper"), "disabled", { mode: 0o600 });
    await writeFile(path.join(second, "helper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = [first, second].join(path.delimiter);
    assert.equal(await available("helper"), true);
    process.env.PATH = first;
    assert.equal(await available("helper"), false);
    assert.equal(await available(path.join(second, "helper")), true);
    process.env.PATH = "";
    assert.equal(await available("helper"), false);
  } finally {
    if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
});
