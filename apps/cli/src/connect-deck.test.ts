import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairedDecks } from "../../../tests/decks";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const action = path.join(root, "actions/connect-deck/connect.mjs");
const entry = path.join(root, "apps/cli/src/index.ts");

async function fixture(t: TestContext, connected = false) {
  const decks = await pairedDecks();
  t.after(decks.close);
  if (!connected) await decks.local.connections.remove("ms");
  const audit = path.join(decks.local.directory, "cli-calls.jsonl");
  const wrapper = path.join(decks.local.directory, "devdeck-fixture.mjs");
  const output = path.join(decks.local.directory, "action-output");
  const barrier = path.join(decks.local.directory, "list-barrier");
  await writeFile(audit, "");
  await writeFile(output, "");
  await mkdir(barrier);
  await writeFile(wrapper, `#!${process.execPath}
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ args, grantInEnvironment: Object.hasOwn(process.env, "INPUT_GRANT") }) + "\\n");
const result = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(entry)}, ...args], {
  cwd: ${JSON.stringify(root)}, env: process.env, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"],
});
if (process.env.DEVICE_DECK_TEST_LIST_BARRIER && args[0] === "decks" && args[1] === "list" && result.status === 0 && JSON.parse(result.stdout).decks.length === 0) {
  const directory = process.env.DEVICE_DECK_TEST_LIST_BARRIER;
  writeFileSync(directory + "/" + process.pid, "");
  const deadline = Date.now() + 5000;
  while (readdirSync(directory).length < 2) {
    if (Date.now() > deadline) process.exit(2);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, DEVICE_DECK_HOME: decks.local.directory, DEVICE_DECK_TARGET: "not-configured" };
  delete env.INPUT_GRANT;
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath,
    ["--import", "tsx", entry, ...args, "--json"], { cwd: root, env })).stdout);
  const run = async (input: Record<string, string> = {}) => {
    let result: { stdout: string; stderr: string; code: ExecFileException["code"] };
    try {
      result = { ...await exec(process.execPath, [action], { cwd: root, timeout: 20_000,
        env: { ...env, INPUT_NAME: "ms", INPUT_ADDRESS: decks.host.address, INPUT_CLI: wrapper,
          GITHUB_OUTPUT: output, ...input } }), code: 0 };
    } catch (error) {
      const failure = error as ExecFileException & { stdout: string; stderr: string };
      result = { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
    }
    assert.equal(result.stdout.includes(decks.grant.token), false, "stdout must not reveal the grant");
    assert.equal(result.stderr.includes(decks.grant.token), false, "stderr must not reveal the grant");
    assert.equal((await readFile(output, "utf8")).includes(decks.grant.token), false, "action outputs must not reveal the grant");
    const calls = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { args: string[]; grantInEnvironment: boolean });
    assert.ok(calls.every(call => !call.grantInEnvironment), "the CLI must not inherit INPUT_GRANT");
    assert.ok(calls.every(call => call.args.every(arg => !arg.includes(decks.grant.token))), "CLI arguments must not reveal the grant");
    return result;
  };
  return { ...decks, cli, run, output, barrier, audit };
}

test("connect action imports a grant once and CI lists, reserves and releases on the hosting daemon", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.run({ INPUT_GRANT: JSON.stringify(f.grant) });
  assert.equal(first.code, 0, first.stderr);
  const identity = (await f.host.authority.metadata()).id;
  assert.deepEqual(JSON.parse(first.stdout), { name: "ms", address: f.host.address, machineId: identity, created: true });
  assert.match(await readFile(f.output, "utf8"), /created=true\n/);
  const connectionFile = path.join(f.local.directory, "deck-connections.json");
  const installed = await readFile(connectionFile, "utf8");
  const repeated = await f.run();
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), { name: "ms", address: f.host.address, machineId: identity, created: false });
  assert.equal(await readFile(connectionFile, "utf8") === installed, true, "repeat setup must preserve the private connection");
  assert.deepEqual((await f.cli("decks", "list", "--deck", "local")).decks,
    [{ name: "ms", address: f.host.address, machineId: identity }]);
  assert.equal((await f.cli("devices", "--deck", "ms"))[0].name, "Host TV");
  const reserved = await f.cli("reserve", "--deck", "ms", "--device", "tv", "--owner", "CI fixture", "--reason", "Action connection proof");
  assert.equal(f.local.deck.store.sessions().length, 0);
  assert.equal(f.host.deck.store.session(reserved.session.id).owner, "CI fixture");
  await f.cli("release", "--deck", "ms", "--session", reserved.session.id, "--lease", reserved.leaseToken);
  assert.equal(f.host.deck.store.session(reserved.session.id).state, "closed");
});

test("connect action refuses first-run setup without a grant", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires valid dedicated grant JSON/);
  assert.deepEqual(await f.local.connections.list(), { decks: [] });
  assert.equal(f.host.deck.store.sessions().length, 0);
});

test("connect action does not reveal malformed grant contents or add a connection", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run({ INPUT_GRANT: `{ malformed ${f.grant.token}` });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires valid dedicated grant JSON/);
  assert.deepEqual(await f.local.connections.list(), { decks: [] });
  const calls = await readFile(f.audit, "utf8");
  assert.equal(calls.includes('"add"'), false);
});

test("connect action refuses an alias conflict without replacing the saved connection", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, true);
  const before = await readFile(path.join(f.local.directory, "deck-connections.json"), "utf8");
  const result = await f.run({ INPUT_ADDRESS: f.local.address, INPUT_GRANT: JSON.stringify(f.grant) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /existing connection uses a different origin/);
  assert.equal(await readFile(path.join(f.local.directory, "deck-connections.json"), "utf8") === before, true, "a conflict must preserve the private connection");
  assert.equal((await readFile(f.audit, "utf8")).includes('"add"'), false);
  assert.equal(f.local.deck.store.sessions().length, 0);
  assert.equal(f.host.deck.store.sessions().length, 0);
});

test("connect action fails authenticated verification after the host revokes its grant", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, true);
  const before = await readFile(path.join(f.local.directory, "deck-connections.json"), "utf8");
  await f.host.connections.revoke(f.grant.id);
  const result = await f.run({ INPUT_GRANT: JSON.stringify(f.grant) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not verify authenticated access/);
  assert.equal(await readFile(path.join(f.local.directory, "deck-connections.json"), "utf8") === before, true, "revocation must not replace the private connection");
  assert.equal((await readFile(f.audit, "utf8")).includes('"add"'), false);
  assert.equal(f.host.deck.store.sessions().length, 0);
  assert.equal(f.local.deck.store.sessions().length, 0);
});

test("simultaneous connect actions reconcile the CLI conflict into one verified connection", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const input = { INPUT_GRANT: JSON.stringify(f.grant), DEVICE_DECK_TEST_LIST_BARRIER: f.barrier };
  const results = await Promise.all([f.run(input), f.run(input)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).created).sort(), [false, true]);
  assert.equal((await f.local.connections.list()).decks.length, 1);
  const calls = (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[] });
  assert.equal(calls.filter(call => call.args[0] === "decks" && call.args[1] === "add").length, 2);
  assert.equal((await f.cli("devices", "--deck", "ms"))[0].name, "Host TV");
});
