import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createService } from "./server";
import { DeckService } from "./local/service";
import { Store } from "./local/store";
import { Adapters } from "../../../packages/adapters/src";
import {
  CaptureEngine,
  type RecordingHandle,
} from "../../../packages/capture/src";
import {
  type DeviceConfig,
  type Device,
  type Config,
} from "../../../packages/core/src/local/types";
const config: Config = {
  schemaVersion: 1,
  port: 0,
  devices: [],
  sources: [],
  settings: {
    folder: "./captures",
    naming: "{device}-{time}",
    owner: "Test",
    ttl: 15,
    overlay: true,
    logging: true,
    clipboard: false,
    captureMode: "clean",
    maxRecordingMinutes: 15,
    previewIntervalMs: 750,
  },
  tools: {},
  savedViews: [],
};
class TestAdapters extends Adapters {
  inputs: string[] = [];
  constructor() {
    super(() => config);
  }
  async diagnostics() {
    return [];
  }
  async inspect(d: DeviceConfig): Promise<Device> {
    return {
      ...d,
      online: true,
      locked: false,
      healthDetail: "Test fixture",
      capabilities: ["key", "preview", "screenshot", "record"],
    };
  }
  async inspectSources() {
    return [];
  }
  async input(d: DeviceConfig) {
    this.inputs.push(d.id);
  }
}
class TestCapture extends CaptureEngine {
  resolveStop?: () => void;
  starts = 0;
  stops = 0;
  disconnected?: (reason: string) => void;
  async startRecording(
    id: string,
    d: DeviceConfig,
    _s: unknown,
    file: string,
  ): Promise<RecordingHandle> {
    this.starts++;
    let endedResolve: (reason: string | undefined) => void = () => {};
    const ended = new Promise<string | undefined>((r) => (endedResolve = r));
    this.disconnected = (r) => endedResolve(r);
    return {
      id,
      deviceId: d.id,
      path: file,
      startedAt: Date.now(),
      startedMono: performance.now(),
      ended,
      stop: async () => {
        this.stops++;
        if (this.resolveStop === undefined)
          await new Promise<void>((r) => (this.resolveStop = r));
        endedResolve(undefined);
        return { duration: 1, bytes: 10 };
      },
    };
  }
  async closeSource(_source: any) {}
  async close() {}
}
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-service-"));
  const adapters = new TestAdapters(),
    capture = new TestCapture(adapters);
  const deck = new DeckService(dir, undefined, adapters, capture);
  await deck.init();
  const c = structuredClone(deck.config.config);
  c.settings.folder = path.join(dir, "captures");
  for (const id of ["one", "two"]) {
    c.devices.push({
      id,
      name: id,
      platform: "Android",
      kind: "virtual",
      model: "fixture",
      visibility: "local",
      connection: { type: "adb", serial: id, port: 5037 },
      captureSourceId: "screen-" + id,
    });
    c.sources.push({
      id: "screen-" + id,
      name: id,
      kind: "native",
      deviceId: id,
    });
  }
  await deck.execute("config.save", {
    config: c,
    revision: deck.config.revision,
  });
  return {
    deck,
    adapters,
    capture,
    cleanup: async () => {
      capture.resolveStop?.();
      await deck.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const reserve = (deck: DeckService, device = "one") =>
  deck.execute("sessions.reserve", {
    selector: { device },
    owner: "same label",
    reason: "test",
  }) as Promise<{ session: { id: string }; leaseToken: string }>;
test("exclusive leases across independent SQLite connections reject stale credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-sqlite-"));
  const a = new Store(path.join(dir, "state.sqlite"));
  const b = new Store(path.join(dir, "state.sqlite"));
  try {
    const first = a.reserve(
      "one",
      "source",
      "usb:identity",
      "Same",
      "test",
      15,
    );
    assert.throws(
      () => b.reserve("one", null, null, "Same", "test", 15),
      /already reserved/,
    );
    assert.throws(
      () =>
        b.reserve("two", "source-alias", "usb:identity", "Same", "test", 15),
      /source is in use/,
    );
    assert.throws(() => a.validate(first.session.id, "wrong"), /does not own/);
    a.putSession({ ...first.session, state: "closed" });
    const second = a.reserve("one", null, null, "Same", "again", 15);
    assert.throws(
      () => a.validate(first.session.id, first.leaseToken),
      /expired or closed/,
    );
    assert.equal(
      a.validate(second.session.id, second.leaseToken).state,
      "active",
    );
  } finally {
    b.close();
    a.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("competing API reservations have one winner; closing invalidates queued input before capture cleanup", async () => {
  const { deck, capture, adapters, cleanup } = await setup();
  try {
    const attempts = await Promise.allSettled([reserve(deck), reserve(deck)]);
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
    const result = attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>;
    const lease = {
      sessionId: result.value.session.id,
      leaseToken: result.value.leaseToken,
    };
    await deck.execute("recordings.start", lease);
    const releasing = deck.execute("sessions.release", lease);
    await assert.rejects(
      deck.execute("remote.input", { ...lease, key: "Home" }),
      /expired or closed/,
    );
    await assert.rejects(reserve(deck), /already reserved/);
    while (!capture.resolveStop) await new Promise((r) => setTimeout(r, 1));
    capture.resolveStop();
    await releasing;
    assert.equal(capture.stops, 1);
    assert.deepEqual(adapters.inputs, []);
    await reserve(deck);
    assert.equal(
      ((await deck.execute("sessions.release", lease)) as any).state,
      "closed",
    );
  } finally {
    await cleanup();
  }
});
test("source failure closes session promptly and marks recording interrupted", async () => {
  const { deck, capture, cleanup } = await setup();
  try {
    const l = await reserve(deck);
    const lease = { sessionId: l.session.id, leaseToken: l.leaseToken };
    await deck.execute("recordings.start", lease);
    capture.disconnected!("USB disconnected");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(deck.store.session(l.session.id).state, "closing");
    while (!capture.resolveStop) await new Promise((r) => setTimeout(r, 1));
    capture.resolveStop();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deck.store.session(l.session.id).state, "closed");
    assert.equal(deck.store.artifacts()[0].status, "interrupted");
  } finally {
    await cleanup();
  }
});
test("authenticated HTTP and browser bootstrap reject origins, unknown hosts, missing tokens and replayed tickets", async () => {
  const { deck, cleanup } = await setup();
  const token = "a".repeat(64),
    server = createService(deck, token, "/tmp/no-web");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + "/v1/health")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/health", {
          headers: { Authorization: `Bearer ${"é".repeat(token.length)}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/v1/health", {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://example.com",
          },
        })
      ).status,
      403,
    );
    const post = (route: string, body: unknown, auth = true) =>
      fetch(base + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const { ticket } = await post("/v1/browser-ticket", {}).then((r) =>
      r.json(),
    );
    const bootstrap = await post("/v1/bootstrap", { ticket }, false);
    assert.equal(bootstrap.status, 200);
    assert.match(
      bootstrap.headers.get("set-cookie")!,
      /HttpOnly; SameSite=Strict/,
    );
    assert.equal((await post("/v1/bootstrap", { ticket }, false)).status, 403);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await fetch(base + "/v1/operations/inventory", {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    const inventory = await post("/v1/operations/inventory", {}).then((r) =>
      r.json(),
    );
    assert.equal(inventory.mode, "local");
    assert.equal(inventory.devices.length, 2);
    assert.equal("leaseToken" in inventory.sessions, false);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      http
        .get(
          base + "/v1/health",
          { headers: { Host: "untrusted.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on("error", reject),
    );
    assert.equal(status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
});

test("renewal, expiry and takeover invalidate credentials while preserving ownership history", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  try {
    const first = await reserve(deck);
    const lease = { sessionId: first.session.id, leaseToken: first.leaseToken };
    const renewed = (await deck.execute("sessions.renew", {
      ...lease,
      ttlMinutes: 20,
    })) as any;
    assert.ok(renewed.expiresAt - Date.now() > 19 * 60000);
    const replacement = (await deck.execute("sessions.takeover", {
      deviceId: "one",
      owner: "same label",
      reason: "Explicit takeover",
      confirmed: true,
    })) as any;
    await assert.rejects(
      deck.execute("remote.input", { ...lease, key: "Home" }),
      /expired or closed/,
    );
    const current = deck.store.session(replacement.session.id);
    current.expiresAt = Date.now() - 1;
    deck.store.putSession(current);
    await deck.expire();
    await assert.rejects(
      deck.execute("remote.input", {
        sessionId: current.id,
        leaseToken: replacement.leaseToken,
        key: "Home",
      }),
      /expired or closed/,
    );
    assert.ok(deck.store.events().some((e) => e.action === "takeover"));
    assert.equal(deck.store.session(current.id).state, "closed");
  } finally {
    await cleanup();
  }
});
test("logging off stores no new text and capture trash/purge removes original and sidecars", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  try {
    const c = structuredClone(deck.config.config);
    c.settings.logging = false;
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    const l = await reserve(deck);
    await deck.execute("remote.input", {
      sessionId: l.session.id,
      leaseToken: l.leaseToken,
      text: "Do not persist this text",
    });
    assert.equal(deck.store.inputs().length, 0);
    const { writeFile, readFile, stat } = await import("node:fs/promises");
    const file = path.join(deck.directory, "capture.png"),
      log = file + ".json",
      clean = path.join(deck.directory, "clean.png");
    for (const p of [file, log, clean]) await writeFile(p, "test file");
    await writeFile(
      log,
      JSON.stringify({
        schemaVersion: 1,
        inputs: [{ key: "Home", elapsedMs: 500 }],
      }),
    );
    deck.store.putArtifact({
      id: "capture",
      deviceId: "one",
      sessionId: l.session.id,
      owner: "test",
      sourceId: "screen-one",
      name: "Test capture",
      path: file,
      cleanPath: clean,
      logPath: log,
      kind: "screenshot",
      mode: "annotated",
      tags: [],
      createdAt: Date.now(),
      duration: 0,
      bytes: 9,
      status: "completed",
      origin: "API",
    });
    await deck.execute("captures.edit", {
      id: "capture",
      name: "Renamed capture",
      tags: ["proof"],
    });
    const manifest = JSON.parse(await readFile(log, "utf8"));
    assert.equal(manifest.artifact.name, "Renamed capture");
    assert.deepEqual(manifest.inputs, [{ key: "Home", elapsedMs: 500 }]);
    await deck.execute("captures.remove", {
      ids: ["capture"],
      confirmed: true,
    });
    assert.ok(await stat(file));
    await deck.execute("captures.restore", { ids: ["capture"] });
    assert.equal(deck.store.artifact("capture").deletedAt, undefined);
    await deck.execute("captures.remove", {
      ids: ["capture"],
      confirmed: true,
    });
    const results = await Promise.allSettled([
      deck.execute("captures.purge", { ids: ["capture"], confirmed: true }),
      deck.execute("captures.edit", {
        id: "capture",
        name: "Concurrent edit",
        tags: [],
      }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.ok(deck.store.artifact("capture").purgedAt);
    for (const p of [file, log, clean])
      await assert.rejects(stat(p), { code: "ENOENT" });
    await assert.rejects(
      deck.execute("captures.restore", { ids: ["capture"] }),
      /cannot be restored/,
    );
  } finally {
    await cleanup();
  }
});
test("config edits close idle preview sources, and reject edits to reserved bindings", async () => {
  const { deck, capture, cleanup } = await setup();
  capture.resolveStop = () => {};
  const closed: string[] = [];
  capture.closeSource = async (s: any) => {
    closed.push(s.id);
  };
  try {
    const c = structuredClone(deck.config.config);
    c.devices[0].captureSourceId = null;
    await deck.execute("config.save", {
      config: c,
      revision: deck.config.revision,
    });
    assert.ok(closed.includes("screen-one"));
    const acquired = await reserve(deck);
    const changed = structuredClone(deck.config.config);
    changed.devices[0].name = "Cannot change reserved identity";
    await assert.rejects(
      deck.execute("config.save", {
        config: changed,
        revision: deck.config.revision,
      }),
      /Release the affected session/,
    );
    assert.equal(deck.config.config.devices[0].name, "one");
    await deck.execute("sessions.release", {
      sessionId: acquired.session.id,
      leaseToken: acquired.leaseToken,
    });
  } finally {
    await cleanup();
  }
});
