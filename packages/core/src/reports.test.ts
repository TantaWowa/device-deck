import test from "node:test";
import assert from "node:assert/strict";
import { aggregateReport, resolveReportRange } from "./reports";
import { Store } from "../../../apps/daemon/src/local/store";
import type { Artifact } from "./local/types";
test("calendar ranges use local midnight, Monday weeks, inclusive end dates and DST boundaries", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const spring = resolveReportRange(
      { start: "2026-03-29", end: "2026-03-29" },
      new Date("2026-03-29T12:00:00Z").getTime(),
    );
    assert.equal(spring.endMs - spring.startMs, 23 * 3600000);
    const autumn = resolveReportRange({
      preset: "custom",
      start: "2026-10-25",
      end: "2026-10-25",
    });
    assert.equal(autumn.endMs - autumn.startMs, 25 * 3600000);
    const week = resolveReportRange(
      { preset: "week" },
      new Date("2026-03-29T12:00:00Z").getTime(),
    );
    assert.equal(week.start, "2026-03-23");
    assert.equal(week.end, "2026-03-29");
    assert.equal(week.endMs - week.startMs, 167 * 3600000);
    const month = resolveReportRange(
      { preset: "month" },
      new Date("2026-02-15T12:00:00Z").getTime(),
    );
    assert.equal(month.start, "2026-02-01");
    assert.equal(month.end, "2026-02-28");
    assert.equal(
      resolveReportRange({}, new Date("2026-09-12T23:30:00Z").getTime()).start,
      "2026-09-13",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
test("invalid dates, missing bounds, reversed ranges and mixed preset dates are rejected", () => {
  for (const request of [
    { preset: "custom" },
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-05-03", end: "2026-05-02" },
    { preset: "week", start: "2026-05-01", end: "2026-05-02" },
  ] as any[])
    assert.throws(() => resolveReportRange(request));
});
test("reports clip crossing and ongoing sessions, count capture start outcomes and half-open event boundaries", () => {
  const range = {
    preset: "custom" as const,
    start: "2026-09-01",
    end: "2026-09-01",
    startMs: 1000,
    endMs: 5000,
    asOf: 4000,
    timeZone: "UTC",
  };
  const result = aggregateReport(
    range,
    [
      { deviceId: "a", createdAt: 0, endedAt: 2000 },
      { deviceId: "b", createdAt: 2500 },
      { deviceId: "c", createdAt: 0, endedAt: 1000 },
      { deviceId: "d", createdAt: 5000 },
    ],
    [
      { deviceId: "a", createdAt: 999, status: "failed" },
      { deviceId: "a", createdAt: 1000, status: "interrupted" },
      { deviceId: "b", createdAt: 3000, status: "completed" },
      { deviceId: "b", createdAt: 5000, status: "failed" },
    ],
    [
      { deviceId: "a", at: 1000 },
      { deviceId: "a", at: 5000 },
    ],
  );
  assert.equal(result.sessions, 2);
  assert.equal(result.reservedMs, 2500);
  assert.equal(result.captureAttempts, 2);
  assert.equal(result.captureFailures, 1);
  assert.equal(result.contentions, 1);
  assert.equal(
    result.byDevice.find((d) => d.deviceId === "a")?.reservedMs,
    1000,
  );
  assert.equal(
    result.byDevice.find((d) => d.deviceId === "b")?.reservedMs,
    1500,
  );
  assert.equal(
    aggregateReport({ ...range, startMs: 6000, endMs: 7000 }, [], [], [])
      .byDevice.length,
    0,
  );
});
test("SQLite report uses complete durable rows rather than the 2000-event history window", () => {
  const store = new Store(":memory:");
  try {
    const now = new Date(2026, 8, 12, 12).getTime(),
      start = new Date(2026, 8, 12).getTime();
    const { session } = store.reserve(
      "one",
      null,
      null,
      "Test",
      "boundary",
      15,
    );
    session.createdAt = start - 3600000;
    session.endedAt = start + 3600000;
    session.state = "closed";
    store.putSession(session);
    store.event({
      deviceId: "one",
      owner: "Test",
      action: "contention",
      detail: "old row",
    });
    store.db
      .prepare(
        "UPDATE events SET payload=? WHERE id=(SELECT max(id) FROM events)",
      )
      .run(
        JSON.stringify({
          deviceId: "one",
          owner: "Test",
          action: "contention",
          detail: "old row",
          at: start + 1000,
        }),
      );
    for (let i = 0; i < 2001; i++)
      store.event({
        deviceId: "one",
        owner: "Test",
        action: "other",
        detail: "filler",
      });
    assert.equal(
      store.events().some((e) => e.action === "contention"),
      false,
    );
    store.putArtifact({
      id: "capture",
      sessionId: session.id,
      deviceId: "one",
      createdAt: start,
      status: "failed",
      deletedAt: start + 2000,
      purgedAt: start + 3000,
    } as Artifact);
    const report = store.reports(
      { start: "2026-09-12", end: "2026-09-12" },
      now,
    );
    assert.equal(report.contentions, 1);
    assert.equal(report.reservedMs, 3600000);
    assert.equal(report.sessions, 1);
    assert.equal(report.captureFailures, 1);
    assert.equal(report.captureAttempts, 1);
  } finally {
    store.close();
  }
});
