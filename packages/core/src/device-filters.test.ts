import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyDeviceFilters,
  filterTableDevices,
  hasDeviceFilters,
  readDeviceFilters,
  readDeviceSort,
  saveDeviceFilters,
  toggleVisibleDeviceSelection,
  type DeviceFilterValues,
  type FilterableDevice,
  type FilterSession,
} from "./device-filters";

function device(id: string, overrides: Partial<FilterableDevice> = {}): FilterableDevice {
  return {
    id, name: id, model: "", platform: "Android", kind: "physical",
    connection: { type: "adb", serial: id, port: 5037 },
    online: true, locked: false, visibility: "local", ...overrides,
  };
}
const devices = [
  device("roku", { name: "Lounge", model: "Ultra", platform: "Roku", connection: { type: "roku", serial: "roku", host: "192.0.2.1" }, tags: ["release"] }),
  device("apple", { name: "Studio", model: "AppleTV14,1", platform: "Apple", connection: { type: "apple-tv", identifier: "apple", host: "192.0.2.2" }, visibility: "shared" }),
  device("phone", { name: "Test bench", model: "Pixel 9", tags: ["nightly", "mobile"] }),
  device("sim", { name: "QA simulator", platform: "Apple", kind: "virtual", connection: { type: "simulator", udid: "ios", os: "ios" } }),
  device("offline", { online: false }),
  device("locked", { locked: true }),
];
const sessions: FilterSession[] = [{ deviceId: "apple", state: "active" }, { deviceId: "sim", state: "closing" }, { deviceId: "phone", state: "closed" }];
const ids = (changes: Partial<DeviceFilterValues>) => filterTableDevices(devices, { ...emptyDeviceFilters(), ...changes }, sessions).map((entry) => entry.id);

test("device filters combine alternatives within a facet and intersect separate facets", () => {
  assert.deepEqual(ids({ platform: ["Apple", "Roku"] }), ["roku", "apple", "sim"]);
  assert.deepEqual(ids({ platform: ["Apple", "Roku"], kind: ["physical"] }), ["roku", "apple"]);
  assert.deepEqual(ids({ platform: ["Apple", "Roku"], kind: ["physical"], visibility: ["shared"] }), ["apple"]);
  assert.deepEqual(ids({ formFactor: "phone", platform: ["Apple"] }), ["sim"]);
  assert.deepEqual(ids({ formFactor: "tv" }), ["roku", "apple"]);
  assert.deepEqual(ids({ platform: ["Other"] }), []);
});

test("device search matches case-insensitive terms across names, models, tags, platforms and IDs", () => {
  assert.deepEqual(ids({ search: "  PIXEL nightly  " }), ["phone"]);
  assert.deepEqual(ids({ search: "roku release" }), ["roku"]);
  assert.deepEqual(ids({ search: "Test bench" }), ["phone"]);
  assert.deepEqual(ids({ search: "Apple", kind: ["virtual"] }), ["sim"]);
  assert.deepEqual(ids({ search: "locked" }), ["locked"]);
  assert.deepEqual(ids({ search: "does not exist" }), []);
  assert.equal(ids({ search: "   " }).length, devices.length);
});

test("availability retains closed/closing session, lock and connectivity behavior", () => {
  assert.deepEqual(ids({ reservation: ["free"] }), ["roku", "phone"]);
  assert.deepEqual(ids({ reservation: ["reserved"] }), ["apple", "sim"]);
  assert.deepEqual(ids({ reservation: ["locked", "reserved"] }), ["apple", "sim", "locked"]);
  assert.deepEqual(ids({ health: ["offline"] }), ["offline"]);
  assert.deepEqual(ids({ health: ["online", "offline"] }), devices.map((entry) => entry.id));
});

test("facet counts omit only their own facet and retain the search and other constraints", () => {
  const filters = { ...emptyDeviceFilters(), platform: ["Apple"], kind: ["physical"], reservation: ["free"] };
  assert.deepEqual(filterTableDevices(devices, filters, sessions).map((entry) => entry.id), []);
  assert.deepEqual(filterTableDevices(devices, filters, sessions, "platform").map((entry) => entry.id), ["roku", "phone"]);
  assert.deepEqual(filterTableDevices(devices, { ...filters, search: "pixel" }, sessions, "platform").map((entry) => entry.id), ["phone"]);
});

test("legacy saved views load from empty defaults and multiselect views round-trip through string records", () => {
  assert.deepEqual(readDeviceFilters({ platform: "Roku", health: "online" }), { ...emptyDeviceFilters(), platform: ["Roku"], health: ["online"] });
  assert.deepEqual(readDeviceFilters({ platform: " Android,Apple,Apple,invalid", formFactor: "unsupported", unexpected: "value" }).platform, ["Apple", "Android"]);
  const filters = { ...emptyDeviceFilters(), search: "nightly", platform: ["Roku", "Apple"], kind: ["virtual", "physical"], health: ["offline"], reservation: ["locked"], visibility: ["shared"], formFactor: "tv" };
  const saved = saveDeviceFilters(filters);
  assert(Object.values(saved).every((value) => typeof value === "string"));
  assert.equal(saved.platform, "Apple,Roku");
  assert.deepEqual(saveDeviceFilters(readDeviceFilters(saved)), saved);
  assert.deepEqual(saveDeviceFilters({ ...filters, platform: ["Apple", "Roku"] }), saved, "click order must not change saved-view identity");
  assert.equal(hasDeviceFilters(emptyDeviceFilters()), false);
  assert.equal(hasDeviceFilters({ ...emptyDeviceFilters(), search: "  " }), false);
  assert.equal(hasDeviceFilters(readDeviceFilters(saved)), true);
});

test("select visible devices preserves hidden selections and only deselects the visible set", () => {
  assert.deepEqual(toggleVisibleDeviceSelection(["roku"], ["apple", "sim"], true), ["roku", "apple", "sim"]);
  assert.deepEqual(toggleVisibleDeviceSelection(["roku", "apple"], ["apple", "sim"], true), ["roku", "apple", "sim"]);
  assert.deepEqual(toggleVisibleDeviceSelection(["roku", "apple", "sim"], ["apple", "sim"], false), ["roku"]);
  assert.deepEqual(toggleVisibleDeviceSelection(["roku"], [], false), ["roku"]);
});

test("browser preferences tolerate absent or malformed filter and sort data", () => {
  for (const value of [null, undefined, false, 123, "legacy", ["Apple"], { search: 1, platform: ["Apple"], formFactor: null }])
    assert.deepEqual(readDeviceFilters(value), emptyDeviceFilters());
  assert.deepEqual(readDeviceFilters({ search: "Pixel", platform: "Apple,Android", kind: null }), {
    ...emptyDeviceFilters(), search: "Pixel", platform: ["Apple", "Android"],
  });
  assert.deepEqual(readDeviceSort({ column: "connection", direction: "descending" }), { column: "connection", direction: "descending" });
  for (const value of [null, undefined, false, "legacy", ["device"], { column: "obsolete", direction: "ascending" }, { column: "capture", direction: "invalid" }])
    assert.deepEqual(readDeviceSort(value), { column: "device", direction: "ascending" });
});
