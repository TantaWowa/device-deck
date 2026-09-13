import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  configSchema,
  deviceSchema,
  type Snapshot,
  type Device,
  type Operation,
} from "../../../packages/core/src/local/types";
import { resolveReportRange } from "../../../packages/core/src/reports";
import {
  Workspace,
  menus,
  type Dependencies,
  type Acquired,
} from "./workspace";
import { render } from "./render";
import { cellWidth, Screen, wrap } from "./screen";

const device = (id: string, name = `Roku ${id}`): Device => ({
  id,
  name,
  platform: "Roku",
  kind: "physical",
  model: "Ultra",
  visibility: "local",
  connection: { type: "roku", serial: id, host: "192.0.2.1" },
  captureSourceId: `feed-${id}`,
  online: true,
  healthDetail: "Connected",
  locked: false,
  capabilities: ["key", "text", "preview", "screenshot", "record"],
});
function fixture() {
  const devices = Array.from({ length: 32 }, (_, i) =>
    device(String(i).padStart(2, "0")),
  );
  const snapshot: Snapshot = {
    devices,
    sources: devices.map((d) => ({
      id: d.captureSourceId!,
      name: `Capture ${d.name}`,
      kind: "usb",
      uniqueId: d.id,
      status: "connected",
    })),
    config: configSchema.parse({
      schemaVersion: 1,
      devices: devices.map((d) => deviceSchema.strip().parse(d)),
      settings: { folder: "/tmp/deck-tui-test" },
    }),
    configRevision: "revision-one",
    configError: null,
    license: {
      tier: "pro",
      state: "active",
      configured: true,
      features: ["concurrency"],
      message: "Active",
      maxSessions: null,
    },
    mode: "local",
    sessions: [],
    artifacts: [],
    recordings: [],
    events: [],
    inputs: [],
    diagnostics: ["Ready"],
    reports: {
      range: resolveReportRange(),
      sessions: 0,
      reservedMs: 0,
      contentions: 0,
      captureAttempts: 0,
      captureFailures: 0,
      byDevice: [],
    },
  };
  const calls: { operation: Operation; args: unknown }[] = [],
    opened: string[] = [];
  const acquired: Acquired = {
    session: {
      id: "mine",
      deviceId: devices[0].id,
      sourceId: devices[0].captureSourceId,
      owner: "You",
      reason: "TUI test",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      state: "active",
    },
    leaseToken: "private-credential-never-render",
  };
  const io: Dependencies = {
    call: async (operation, args) => {
      calls.push({ operation, args });
      if (operation === "inventory") return structuredClone(snapshot);
      if (
        operation === "sessions.reserve" ||
        operation === "sessions.takeover"
      ) {
        snapshot.sessions = [acquired.session];
        return acquired;
      }
      if (operation === "sessions.release") {
        snapshot.sessions = snapshot.sessions.filter(
          (s) => s.id !== (args as { sessionId: string }).sessionId,
        );
        return {};
      }
      if (operation === "config.get")
        return { config: snapshot.config, revision: snapshot.configRevision };
      if (operation === "config.save") {
        snapshot.config = (args as { config: Snapshot["config"] }).config;
        snapshot.devices = snapshot.config.devices.map((d) => ({
          ...device(d.id),
          ...d,
        }));
        return {};
      }
      return {};
    },
    open: async (target) => {
      opened.push(target);
    },
    url: async (query) => `http://127.0.0.1/?${query}`,
  };
  const workspace = new Workspace(io);
  workspace.snapshot = structuredClone(snapshot);
  return { workspace, io, calls, opened, snapshot, acquired };
}
const key = (workspace: Workspace, name: string, sequence?: string) =>
  workspace.handle({ name, sequence });
async function settled(workspace: Workspace) {
  while (workspace.busy) await workspace.pending;
}

test("all menus, long lists, dialogs and remote frames stay within terminal cells", () => {
  const { workspace } = fixture();
  workspace.snapshot!.devices[31].name =
    "電視 👩‍💻 café\x1b[2J\x1b]52;c;not-a-clipboard\x07 unsafe\nname";
  for (const [width, height] of [
    [79, 23],
    [99, 29],
    [139, 39],
    [69, 19],
    [18, 8],
  ]) {
    for (const view of menus) {
      workspace.switchView(view);
      key(workspace, "end");
      const frame = render(workspace, width, height);
      assert.equal(frame.length, height);
      for (const line of frame)
        assert.equal(
          cellWidth(stripVTControlCharacters(line)),
          width,
          `${view} ${width} cells`,
        );
      assert(!frame.join("").includes("\x1b[2J"));
      assert(!frame.join("").includes("52;c;"));
    }
    workspace.switchView("Devices");
    key(workspace, "end");
    key(workspace, "return");
    for (const line of render(workspace, width, height))
      assert.equal(cellWidth(line), width, `dialog ${width}`);
    workspace.dialog = undefined;
    workspace.remoteId = workspace.snapshot!.devices[0].id;
    for (const line of render(workspace, width, height))
      assert.equal(cellWidth(line), width, `remote ${width}`);
    workspace.remoteId = undefined;
  }
  const screen = new Screen(10, 2);
  screen.text(0, 0, "電視電視電");
  screen.text(1, 0, "x", 1);
  screen.text(4, 0, "z", 1);
  assert.equal(
    cellWidth(screen.lines(false)[0]),
    10,
    "overlays repair partially covered wide characters",
  );
  assert.deepEqual(wrap("電視", 1), ["?", "?"]);
});

test("navigation keeps menu selection and bounded item scrolling independent", () => {
  const { workspace } = fixture();
  render(workspace, 99, 29);
  key(workspace, "pagedown");
  assert.equal(workspace.index, workspace.pageSize);
  key(workspace, "end");
  assert.equal(workspace.selected!.id, "31");
  const frame = render(workspace, 99, 29, false).join("\n");
  assert(frame.includes("Roku 31"));
  assert(!frame.includes("Roku 00"));
  key(workspace, "tab");
  key(workspace, "down");
  assert.equal(workspace.view, "Feeds");
  assert.equal(workspace.focus, "menu");
  key(workspace, "return");
  key(workspace, "down");
  assert.equal(workspace.index, 1);
  key(workspace, "1");
  assert.equal(workspace.view, "Devices");
  assert.equal(workspace.index, 31);
  key(workspace, "f");
  key(workspace, "3");
  assert.equal(workspace.platform, "Android");
  assert.equal(workspace.rows().length, 0);
  key(workspace, "x");
  assert.equal(workspace.rows().length, 32);
  key(workspace, "/", "/");
  key(workspace, "q", "q");
  assert.equal(workspace.done, false);
  assert.equal(workspace.dialog?.kind, "form");
  key(workspace, "escape");
  assert.equal(workspace.filter, "");
});

test("refresh follows current selection instead of jumping back to the row selected when polling began", async () => {
  const { workspace, io, snapshot } = fixture();
  let resolve!: (value: Snapshot) => void;
  io.call = () =>
    new Promise((r) => {
      resolve = r;
    });
  const polling = workspace.refresh();
  key(workspace, "end");
  snapshot.devices.reverse();
  resolve(snapshot);
  await polling;
  assert.equal(workspace.selected!.id, "31");
});

test("remote acquisition, input and quit preserve lease ownership and never render credentials", async () => {
  const { workspace, calls } = fixture();
  key(workspace, "c");
  assert.equal(workspace.dialog?.kind, "form");
  key(workspace, "return");
  key(workspace, "t", "test");
  key(workspace, "return");
  await settled(workspace);
  assert.equal(workspace.remote?.id, "00");
  assert(!render(workspace, 99, 29).join("").includes("private-credential"));
  key(workspace, "right");
  await settled(workspace);
  assert.deepEqual(calls.find((c) => c.operation === "remote.input")?.args, {
    sessionId: "mine",
    leaseToken: "private-credential-never-render",
    key: "Right",
  });
  key(workspace, "escape");
  assert.equal(workspace.remoteId, undefined);
  key(workspace, "q");
  assert.equal(workspace.done, false);
  key(workspace, "return");
  assert.equal(workspace.done, false, "cancel is the default confirmation");
  key(workspace, "q");
  key(workspace, "y");
  await settled(workspace);
  assert.equal(workspace.done, true);
  assert.equal(
    calls.filter((c) => c.operation === "sessions.release").length,
    1,
  );
});

test("occupied or recording devices require takeover confirmation even with the same owner label", async () => {
  const { workspace, snapshot, acquired, calls } = fixture();
  snapshot.sessions = [
    { ...acquired.session, id: "other", reason: "Someone else recording" },
  ];
  snapshot.recordings = [
    {
      id: "other-recording",
      sessionId: "other",
      deviceId: "00",
      startedAt: Date.now(),
    },
  ];
  await workspace.refresh();
  key(workspace, "v");
  assert.equal(workspace.dialog?.kind, "menu");
  assert(
    workspace.dialog?.kind === "menu" &&
      workspace.dialog.description.includes("saves its recording"),
  );
  key(workspace, "return");
  assert.equal(
    calls.filter(
      (c) =>
        c.operation.startsWith("sessions.") ||
        c.operation.startsWith("recordings."),
    ).length,
    0,
  );
  key(workspace, "q");
  assert.equal(
    workspace.done,
    true,
    "quitting cannot release another client’s reservation",
  );
});

test("batch discovery excludes configured devices and saves all selected additions in one revisioned operation", async () => {
  const { workspace, calls, snapshot } = fixture();
  workspace.discovery = {
    devices: [snapshot.devices[0], device("new-one"), device("new-two")].map(
      (d) => deviceSchema.strip().parse(d),
    ),
    sources: [],
    diagnostics: [],
  };
  key(workspace, "a");
  assert.deepEqual([...workspace.selectedDevices], ["new-one", "new-two"]);
  key(workspace, "return");
  await settled(workspace);
  assert.equal(calls.filter((c) => c.operation === "config.save").length, 1);
  assert.equal(workspace.discovery, undefined);
  assert.equal(workspace.snapshot!.devices.length, 34);
});

test("feed selection opens only the requested mux and capture trash requires explicit confirmation", async () => {
  const { workspace, opened, calls } = fixture();
  key(workspace, "2");
  key(workspace, "space");
  key(workspace, "down");
  key(workspace, "space");
  key(workspace, "g");
  await settled(workspace);
  const query = new URL(opened[0]).searchParams;
  assert.equal(query.get("sources"), "feed-00,feed-01");
  assert.equal(query.get("layout"), "grid");
  workspace.snapshot!.artifacts = [
    {
      id: "shot",
      deviceId: "00",
      sessionId: "ended",
      owner: "You",
      sourceId: "feed-00",
      name: "A screenshot",
      path: "/tmp/shot.png",
      logPath: "/tmp/shot.json",
      kind: "screenshot",
      mode: "clean",
      tags: [],
      createdAt: Date.now(),
      duration: 0,
      bytes: 0,
      status: "completed",
      origin: "CLI",
    },
  ];
  key(workspace, "3");
  key(workspace, "x");
  key(workspace, "return");
  assert(!calls.some((c) => c.operation === "captures.remove"));
  key(workspace, "x");
  key(workspace, "y");
  await settled(workspace);
  assert.deepEqual(calls.find((c) => c.operation === "captures.remove")?.args, {
    ids: ["shot"],
    confirmed: true,
  });
});

test("rapid remote keys remain ordered without inventory polling between presses; Escape discards queued input", async () => {
  const { io, acquired, snapshot, calls } = fixture();
  snapshot.sessions = [acquired.session];
  const workspace = new Workspace(io, { acquired, remoteId: "00" });
  await workspace.refresh();
  const original = io.call;
  let finish!: () => void;
  io.call = async (operation, args) => {
    const result = await original(operation, args);
    if (operation === "remote.input")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return result;
  };
  const inventoryBefore = calls.filter(
    (c) => c.operation === "inventory",
  ).length;
  key(workspace, "right");
  key(workspace, "right");
  key(workspace, "down");
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await settled(workspace);
  assert.deepEqual(
    calls
      .filter((c) => c.operation === "remote.input")
      .map((c) => (c.args as { key: string }).key),
    ["Right", "Right", "Down"],
  );
  assert.equal(
    calls.filter((c) => c.operation === "inventory").length,
    inventoryBefore,
  );
  key(workspace, "up");
  key(workspace, "up");
  key(workspace, "escape");
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await settled(workspace);
  assert.equal(workspace.remoteId, undefined);
  assert.equal(calls.filter((c) => c.operation === "remote.input").length, 4);
});
