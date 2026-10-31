import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pairedDecks, fixtureImage } from "../../../tests/decks";

const exec = promisify(execFile);

test("CLI selects a remote Deck through its local endpoint and releases the host lease", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  const env = { ...process.env, DEVICE_DECK_HOME: f.local.directory, DEVICE_DECK_TARGET: "local" };
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args, "--json"], { env })).stdout);
  assert.equal((await cli("devices", "--deck", "ms"))[0].name, "Host TV");
  assert.equal((await cli("devices"))[0].name, "Local TV");
  const session = await cli("reserve", "--deck", "ms", "--device", "tv", "--owner", "CLI test", "--reason", "Remote reservation");
  assert.equal(f.local.deck.store.sessions().length, 0);
  assert.equal(f.host.deck.store.sessions()[0].owner, "CLI test");
  const shot = await cli("screenshot", "--deck", "ms", "--session", session.session.id, "--lease", session.leaseToken, "--mode", "clean");
  const captureFile = path.join(f.local.directory, "remote.png");
  await cli("download", shot.id, "--deck", "ms", "--output", captureFile);
  assert.deepEqual(await readFile(captureFile), fixtureImage);
  await assert.rejects(cli("download", shot.id, "--deck", "ms", "--output", captureFile), /exist/i);
  await cli("release", "--deck", "ms", "--session", session.session.id, "--lease", session.leaseToken);
  assert.equal(f.host.deck.store.session(session.session.id).state, "closed");
  const link = await cli("ui", "--deck", "ms");
  assert.equal(new URL(link.url).origin, f.local.address);
  assert.equal(new URL(link.url).searchParams.get("deck"), "ms");
  await assert.rejects(cli("stop", "--deck", "ms"), /manages the local Mac/);
  const output = path.join(f.local.directory, "access.json");
  const grant = await cli("decks", "grant", "other", "--output", output);
  assert.equal(grant.token, undefined);
  assert.ok(JSON.parse(await readFile(output, "utf8")).token);
});

test("MCP discovers remote Decks and returns a remote screenshot inline without reserving locally", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  const client = new Client({ name: "deck-sharing-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "packages/mcp/src/index.ts"],
    env: { PATH: process.env.PATH || "", DEVICE_DECK_HOME: f.local.directory }, stderr: "pipe",
  });
  await client.connect(transport); t.after(() => client.close());
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(Array.isArray(result.content));
    const first = result.content[0];
    assert.equal(first.type, "text");
    return { data: JSON.parse(first.text), content: result.content };
  };
  assert.equal((await invoke("decks_list", {})).data.decks[0].name, "ms");
  assert.equal((await invoke("inventory", { deck: "ms" })).data.devices[0].name, "Host TV");
  const { data } = await invoke("sessions_reserve", { deck: "ms", selector: { device: "tv" }, owner: "MCP test", reason: "Remote screenshot" });
  const lease = { deck: "ms", sessionId: data.session.id, leaseToken: data.leaseToken };
  const shot = await invoke("captures_screenshot", { ...lease, mode: "clean", clipboard: false });
  assert.equal(shot.data.status, "completed");
  assert.equal(shot.content[1].type, "image");
  assert.equal(f.local.deck.store.sessions().length, 0);
  await invoke("sessions_release", lease);
  assert.equal(f.host.deck.store.session(data.session.id).state, "closed");
});
