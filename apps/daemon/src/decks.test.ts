import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pairedDecks, fixtureImage } from "../../../tests/decks";
import { DeckConnections, assertSharedRoute } from "./decks";

const operation = (name: string) => `/v1/decks/ms/v1/operations/${name}`;
const reserve = { selector: { device: "tv" }, owner: "Remote agent", reason: "Sharing fixture", ttlMinutes: 5 };

test("remote Deck owns reservations, input, recordings and capture files; local identities never collide", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  const inventory = await (await f.local.request(operation("inventory"), {})).json();
  assert.equal(inventory.devices[0].name, "Host TV");
  const cards = await (await f.local.request(operation("capture-cards.list"), {})).json();
  assert.equal(cards.sources[0].uniqueId, "Host-hardware");
  const acquired = await (await f.local.request(operation("sessions.reserve"), reserve)).json();
  assert.ok(acquired.leaseToken);
  const lease = { sessionId: acquired.session.id, leaseToken: acquired.leaseToken };
  assert.equal(f.host.deck.store.sessions().length, 1);
  assert.equal(f.local.deck.store.sessions().length, 0);
  const contested = await f.host.request("/v1/operations/sessions.reserve", reserve);
  assert.equal(contested.status, 409);
  assert.equal((await contested.json()).error, "device-reserved");
  assert.equal((await f.local.request(operation("remote.input"), { ...lease, key: "Home" })).status, 200);
  assert.deepEqual(f.host.inputs, ["tv"]);
  assert.deepEqual(f.local.inputs, []);
  const shot = await (await f.local.request(operation("captures.screenshot"), { ...lease, mode: "clean", clipboard: false })).json();
  assert.equal(shot.status, "completed");
  assert.ok(shot.path.startsWith(f.host.directory));
  assert.equal(f.local.deck.store.artifacts().length, 0);
  const download = await f.local.request(`/v1/decks/ms/v1/artifacts/${shot.id}/file?download=1`);
  assert.match(download.headers.get("content-disposition")!, /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixtureImage);
  const partial = await f.local.request(`/v1/decks/ms/v1/artifacts/${shot.id}/file`, undefined, f.local.token, { Range: "bytes=0-7" });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-7/${fixtureImage.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), fixtureImage.subarray(0, 8));
  const preview = await f.local.request("/v1/decks/ms/v1/source-preview/card");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), fixtureImage);
  const recording = await (await f.local.request(operation("recordings.start"), { ...lease, mode: "clean" })).json();
  assert.equal(recording.status, "recording");
  assert.equal((await f.local.request(operation("sessions.release"), lease)).status, 200);
  assert.equal(f.host.deck.store.artifact(recording.id).status, "completed");
  assert.notEqual((await f.local.request(operation("remote.input"), { ...lease, key: "Home" })).status, 200);
  assert.deepEqual(f.host.inputs, ["tv"]);
});

test("Deck grants are private, durable, independently revocable and cannot administer or chain Deck connections", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  const listed = await (await f.local.request("/v1/decks")).json();
  assert.equal(listed.decks[0].name, "ms");
  assert.equal(JSON.stringify(listed).includes(f.grant.token), false);
  const file = path.join(f.host.directory, "deck-connections.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, "utf8")).includes(f.grant.token), false);
  assert.equal(await new DeckConnections(f.host.directory).authorize(f.grant.token), true);
  for (const [route, body] of [
    ["/v1/decks", undefined], ["/v1/deck-access/grant", { name: "intruder" }],
    ["/v1/decks/ms/v1/health", undefined], ["/v1/operations/license.deactivate", {}],
  ] as const) assert.equal((await f.host.request(route, body, f.grant.token)).status, 403);
  assert.equal((await f.local.request("/v1/decks/ms/v1/browser-ticket", {})).status, 403);
  await f.host.connections.revoke(f.grant.id);
  const denied = await f.local.request(operation("sessions.reserve"), reserve);
  assert.equal(denied.status, 401);
  assert.equal(f.host.deck.store.sessions().length, 0);
  assert.equal(f.local.deck.store.sessions().length, 0);
});

test("unknown and offline Decks fail without claiming local devices or retrying mutations", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  assert.equal((await f.local.request("/v1/decks/missing/v1/operations/sessions.reserve", reserve)).status, 404);
  f.host.server.closeAllConnections();
  await new Promise<void>((resolve) => f.host.server.close(() => resolve()));
  const failed = await f.local.request(operation("sessions.reserve"), reserve);
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, "deck-unavailable");
  assert.equal(f.local.deck.store.sessions().length, 0);
});

test("remote configuration preserves host trust and tool execution settings", async (t) => {
  const f = await pairedDecks(); t.after(f.close);
  const current = await (await f.local.request(operation("config.get"), {})).json();
  const changed = structuredClone(current.config);
  changed.settings.folder = "/tmp/other";
  assert.equal((await f.local.request(operation("config.save"), { config: changed, revision: current.revision })).status, 403);
  changed.settings.folder = current.config.settings.folder;
  changed.devices[0].name = "Remote TV renamed";
  assert.equal((await f.local.request(operation("config.save"), { config: changed, revision: current.revision })).status, 200);
  assert.equal(f.host.deck.config.config.devices[0].name, "Remote TV renamed");
  assert.equal(f.local.deck.config.config.devices[0].name, "Local TV");
});

test("shared routes reject administrative endpoints and arbitrary paths", () => {
  for (const route of ["/v1/decks", "/v1/deck-access/list", "/v1/bootstrap", "/v1/hub/pair", "/v1/artifacts/one/unknown", "/etc/passwd"])
    assert.throws(() => assertSharedRoute("GET", route), /not shared/);
});
