import test from "node:test";
import assert from "node:assert/strict";
import {
  matchDevices,
  matchReservationGroup,
  type Device,
} from "./local/types";

const device = (
  id: string,
  inputMode: "touch" | "remote",
  tags: string[],
  online = false,
): Device => ({
  id,
  name: id,
  platform: "Android",
  kind: "virtual",
  model: id,
  inputMode,
  tags,
  visibility: "local",
  connection: {
    type: "adb",
    serial: `stopped-${id}`,
    avdName: id,
    port: 5037,
  },
  captureSourceId: `screen-${id}`,
  online,
  locked: false,
  healthDetail: online ? "Ready" : "Stopped",
  capabilities: [],
  simulatorState: online ? "booted" : "shutdown",
});

test("selectors match device kind, stable form factor and all requested tags", () => {
  const phone = device("phone", "touch", ["ci", "nightly"]);
  const tv = device("tv", "remote", ["ci"]);
  assert.deepEqual(
    matchDevices([phone, tv], [], {
      platform: "Android",
      kind: "virtual",
      formFactor: "phone",
      tags: ["ci", "nightly"],
    }).map((item) => item.id),
    ["phone"],
  );
});

test("group matching assigns distinct devices most-constrained-first and permits stopped virtuals", () => {
  const phone = device("phone", "touch", ["ci"]);
  const tv = device("tv", "remote", ["ci"]);
  const selected = matchReservationGroup(
    [phone, tv],
    [],
    {
      any: { selector: { platform: "Android", kind: "virtual", tags: ["ci"] } },
      television: {
        selector: {
          platform: "Android",
          kind: "virtual",
          formFactor: "tv",
          tags: ["ci"],
          state: "free",
        },
      },
    },
  );
  assert.equal(selected?.television.id, "tv");
  assert.equal(selected?.any.id, "phone");
  assert.equal(
    matchReservationGroup([phone], [], {
      first: { selector: { tags: ["ci"] } },
      second: { selector: { tags: ["ci"] } },
    }),
    undefined,
  );
});

test("group matching backtracks on canonical source identity, not source aliases", () => {
  const first = device("a", "touch", ["ci"], true);
  const duplicateSource = device("b", "touch", ["ci"], true);
  const independent = device("c", "touch", ["ci"], true);
  const selected = matchReservationGroup(
    [first, duplicateSource, independent],
    [],
    {
      first: { selector: { tags: ["ci"] } },
      second: { selector: { tags: ["ci"] } },
    },
    (candidate) => candidate.id === "c" ? "source-two" : "source-one",
  );
  assert.equal(selected?.first.id, "a");
  assert.equal(selected?.second.id, "c");
});

test("selectors match exact model and runtime identifiers case-insensitively", () => {
  const phone = { ...device("phone", "touch", []), model: "iPhone-17-Pro", runtime: "iOS-26-2" };
  const older = { ...device("older", "touch", []), model: "iPhone-17-Pro", runtime: "iOS-18-5" };
  const tv = { ...device("tv", "remote", []), model: "Apple-TV-4K-3rd-generation-4K", runtime: "tvOS-26-2" };
  assert.deepEqual(matchDevices([phone, older, tv], [], { model: "iphone-17-pro" }).map((d) => d.id), ["phone", "older"]);
  assert.deepEqual(matchDevices([phone, older, tv], [], { model: "iPhone-17-Pro", runtime: "ios-26-2" }).map((d) => d.id), ["phone"]);
  assert.deepEqual(matchDevices([phone, older, tv], [], { runtime: "tvOS-26-2" }).map((d) => d.id), ["tv"]);
  assert.deepEqual(matchDevices([device("bare", "touch", [])], [], { runtime: "iOS-26-2" }), []);
});
