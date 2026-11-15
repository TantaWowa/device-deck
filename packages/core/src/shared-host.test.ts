import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hasExplicitProfile, readAccountEndpoint, readSharedHost } from "./shared-host";

test("shared discovery rejects writable registration and symlinks, and checks account ownership", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deck-shared-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uid = process.getuid!();
  const host = { schemaVersion: 1 as const, uid, username: "host", home: directory, profile: path.join(directory, "profile") };
  const file = path.join(directory, "host.json");
  assert.equal(await readSharedHost(directory, uid), undefined);
  await writeFile(file, JSON.stringify(host), { mode: 0o644 });
  assert.deepEqual(await readSharedHost(directory, uid), host);
  await chmod(directory, 0o777);
  await assert.rejects(readSharedHost(directory, uid), /unsafe ownership/);
  await chmod(directory, 0o755);
  await chmod(file, 0o666);
  await assert.rejects(readSharedHost(directory, uid), /unsafe ownership/);
  await chmod(file, 0o644);
  await symlink(file, path.join(directory, "link"));
  await rm(file);
  await symlink(path.join(directory, "link"), file);
  await assert.rejects(readSharedHost(directory, uid));
  await rm(file); await rm(path.join(directory, "link"));
  await mkdir(path.join(directory, "access"), { mode: 0o711 });
  const credential = { schemaVersion: 1, hostUID: uid, uid, grantId: "bf60cf3e-d65e-4b4c-8e7c-de52c48140cb", port: 47831, pid: 123, token: "a".repeat(43), startedAt: 1 };
  const accountFile = path.join(directory, "access", `${uid}.json`);
  await writeFile(accountFile, JSON.stringify(credential), { mode: 0o600 });
  assert.equal((await readAccountEndpoint(host, uid, directory)).shared, true);
  await chmod(accountFile, 0o644);
  await assert.rejects(readAccountEndpoint(host, uid, directory), /unsafe ownership/);
  await chmod(accountFile, 0o600);
  await writeFile(accountFile, JSON.stringify({ ...credential, uid: uid + 1 }));
  await assert.rejects(readAccountEndpoint(host, uid, directory), /identity does not match/);
  await rm(accountFile);
  await assert.rejects(readAccountEndpoint(host, uid, directory), /Ask host to allow/);
});

test("explicit development profiles opt out of automatic shared discovery", () => {
  assert.equal(hasExplicitProfile({}), false);
  assert.equal(hasExplicitProfile({ DEVICE_DECK_HOME: "/private/profile" }), true);
  assert.equal(hasExplicitProfile({ DEVICE_DECK_CONFIG: "/private/config.json" }), true);
});
