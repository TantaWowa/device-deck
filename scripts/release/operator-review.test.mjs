import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, stat, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { renderCask } from "./cask-template.ts";
import { writePrivateFile, isFutureExpiry, environmentCreationBody } from "./operator-files.mjs";

test("public cask template is valid Ruby for each architecture and guards owned CLI removal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-cask-template-"));
  try {
    const manifest = { version: "1.0.0", arch: "arm64", sha256: "a".repeat(64), filename: "device-deck-1.0.0-macos-arm64-live.pkg" };
    for (const variants of [[manifest], [manifest, { ...manifest, arch: "x64", filename: "device-deck-1.0.0-macos-x64-live.pkg" }]]) {
      const cask = renderCask(variants, { accountId: "account", productId: "product" });
      const file = path.join(directory, "device-deck.rb");
      await writeFile(file, cask);
      assert.match(execFileSync("/usr/bin/ruby", ["-c", file], { encoding: "utf8" }), /Syntax OK/);
      assert.match(cask, /must_succeed: true/);
      assert.match(cask, /\[ -L "\$cli" \]/);
      assert.match(cask, /sudo: true/);
      assert.doesNotMatch(cask, /File\.unlink|zap /);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator key receipts restore private permissions and never follow symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-operator-file-"));
  try {
    const file = path.join(directory, "license.key"), outside = path.join(directory, "outside");
    await writeFile(file, "old"); await chmod(file, 0o666);
    await writePrivateFile(file, "private-test-value");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await rm(file); await writeFile(outside, "untouched"); await symlink(outside, file);
    await assert.rejects(writePrivateFile(file, "must-not-write"));
    assert.equal(await readFile(outside, "utf8"), "untouched");
    for (const value of [null, undefined, "invalid", "", "2000-01-01T00:00:00Z"]) assert.equal(isFutureExpiry(value), false);
    assert.equal(isFutureExpiry("2030-01-01T00:00:00Z", Date.parse("2029-01-01")), true);
    assert.deepEqual(environmentCreationBody("live"), { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
