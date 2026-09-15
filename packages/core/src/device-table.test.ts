import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceConnectionLabel,
  sortTableDevices,
  type DeviceSortColumn,
} from "./device-table";

const devices = [
  {
    id: "ten",
    name: "Roku 10",
    online: true,
    locked: false,
    visibility: "shared" as const,
    captureSourceId: "one",
  },
  {
    id: "two",
    name: "roku 2",
    online: true,
    locked: false,
    visibility: "local" as const,
    captureSourceId: "two",
  },
  {
    id: "one",
    name: "Apple TV",
    online: false,
    locked: true,
    visibility: "local" as const,
    captureSourceId: null,
    simulatorState: "shutdown" as const,
  },
];
const sources = [
  { id: "one", name: "UGREEN 2" },
  { id: "two", name: "UGREEN 10" },
];
const sessions = [
  {
    deviceId: "two",
    state: "closed" as const,
    owner: "Old owner",
    reason: "Old session",
  },
  { deviceId: "two", state: "active" as const, owner: "Zoe", reason: "QA" },
];

test("device table sorts every visible data column in both directions using labels and natural numbers", () => {
  const cases: [DeviceSortColumn, string[], string[]][] = [
    ["device", ["one", "two", "ten"], ["ten", "two", "one"]],
    ["connection", ["ten", "two", "one"], ["one", "ten", "two"]],
    ["reservation", ["ten", "one", "two"], ["two", "one", "ten"]],
    ["capture", ["one", "ten", "two"], ["two", "ten", "one"]],
    ["visibility", ["two", "one", "ten"], ["ten", "two", "one"]],
  ];
  const before = structuredClone(devices);
  for (const [column, expected, descending] of cases) {
    assert.deepEqual(
      sortTableDevices(
        devices,
        { column, direction: "ascending" },
        sources,
        sessions,
      ).map((d) => d.id),
      expected,
      column,
    );
    assert.deepEqual(
      sortTableDevices(
        devices,
        { column, direction: "descending" },
        sources,
        sessions,
      ).map((d) => d.id),
      descending,
      column,
    );
  }
  assert.deepEqual(devices, before);
  assert.equal(
    sortTableDevices(
      devices,
      { column: "device", direction: "ascending" },
      sources,
      sessions,
    )[0],
    devices[2],
  );
});

test("connection sorting uses simulator lifecycle labels and reservation sorting includes reason", () => {
  assert.deepEqual(
    [
      deviceConnectionLabel({ online: false, simulatorState: "starting" }),
      deviceConnectionLabel({ online: true, simulatorState: "stopping" }),
      deviceConnectionLabel({ online: false, simulatorState: "shutdown" }),
      deviceConnectionLabel({ online: false }),
      deviceConnectionLabel({ online: true }),
    ],
    ["Launching…", "Closing…", "Stopped", "Offline", "Online"],
  );
  const reserved = [
    {
      deviceId: "ten",
      state: "active" as const,
      owner: "George",
      reason: "Task 10",
    },
    {
      deviceId: "two",
      state: "closing" as const,
      owner: "George",
      reason: "Task 2",
    },
  ];
  assert.deepEqual(
    sortTableDevices(
      devices.slice(0, 2),
      { column: "reservation", direction: "ascending" },
      sources,
      reserved,
    ).map((d) => d.id),
    ["two", "ten"],
  );
});
